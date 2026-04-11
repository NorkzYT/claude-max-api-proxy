import { v4 as uuidv4 } from "uuid";
import { ClaudeSubprocess, subprocessRegistry } from "../subprocess/manager.js";
import { openaiToCli } from "../adapter/openai-to-cli.js";
import { cliResultToOpenai, createDoneChunk, estimateTokens, validateTokens } from "../adapter/cli-to-openai.js";
import { extractTextContent } from "../adapter/cli-to-openai.js";
import { sessionManager } from "../session/manager.js";
import { conversationStore } from "../store/conversation.js";
import { subprocessPool } from "../subprocess/pool.js";
import { getModelTimeout, getStallTimeout, isValidModel } from "../models.js";
import { log, logError } from "../logger.js";
import { modelAvailability } from "../model-availability.js";
import { extractClaudeErrorFromResult } from "../claude-cli.inspect.js";
import { runtimeConfig } from "../config.js";
const conversationQueues = new Map();
const activeRequests = new Map();
class RequestCancelledError extends Error {
    proxyError;
    constructor(proxyError) {
        super(proxyError.message);
        this.proxyError = proxyError;
        this.name = "RequestCancelledError";
    }
}
/**
 * Enqueue a request for a conversation and process sequentially.
 * Phase 3a: Wraps handler with an absolute queue timeout.
 * Phase 5a: Scale timeout buffer based on queue depth to prevent stacking timeouts
 */
function enqueueRequest(conversationId, requestId, handler, hardTimeoutMs) {
    return new Promise((resolve, reject) => {
        let entry = conversationQueues.get(conversationId);
        if (!entry) {
            entry = { queue: [], processing: false };
            conversationQueues.set(conversationId, entry);
        }
        // Phase 5a: Scale buffer based on queue position - 60s per item in queue
        const queuePosition = entry.queue.length;
        const queueBufferMs = Math.max(60000, queuePosition * 60000);
        const queueTimeoutMs = hardTimeoutMs + queueBufferMs;
        const item = {
            requestId,
            handler: () => {
                // Wrap handler in a race with the queue timeout
                return new Promise((handlerResolve, handlerReject) => {
                    const queueTimer = setTimeout(() => {
                        log("queue.timeout", { conversationId, timeoutMs: queueTimeoutMs });
                        handlerReject(new Error(`Queue timeout after ${queueTimeoutMs / 1000}s`));
                    }, queueTimeoutMs);
                    handler()
                        .then(() => {
                        clearTimeout(queueTimer);
                        handlerResolve();
                    })
                        .catch((err) => {
                        clearTimeout(queueTimer);
                        handlerReject(err);
                    });
                });
            },
            resolve,
            reject,
            enqueuedAt: Date.now(),
        };
        entry.queue.push(item);
        log("queue.enqueue", { conversationId, depth: entry.queue.length });
        logQueueDebug("queue.enqueue", {
            conversationId,
            requestId,
            depth: entry.queue.length,
            processing: entry.processing,
            policy: runtimeConfig.sameConversationPolicy,
        });
        if (!entry.processing) {
            processQueue(conversationId);
        }
    });
}
/**
 * Process the next item in a conversation's queue.
 * Phase 3a: Uses finally to guarantee queue always advances.
 */
async function processQueue(conversationId) {
    const entry = conversationQueues.get(conversationId);
    if (!entry || entry.queue.length === 0) {
        if (entry) {
            entry.processing = false;
            if (entry.queue.length === 0) {
                conversationQueues.delete(conversationId);
            }
        }
        return;
    }
    entry.processing = true;
    const item = entry.queue.shift();
    try {
        const result = await item.handler();
        item.resolve(result);
    }
    catch (err) {
        item.reject(err);
    }
    finally {
        // Phase 3a: always advance the queue, even if handler throws
        processQueue(conversationId);
    }
}
// ---------------------------------------------------------------------------
// Cleanup set (Phase 2b)
// ---------------------------------------------------------------------------
/**
 * Safe cleanup collection. Each function runs at most once, wrapped in try/catch.
 */
class CleanupSet {
    fns = new Set();
    ran = false;
    add(fn) {
        if (!this.ran) {
            this.fns.add(fn);
        }
    }
    runAll() {
        if (this.ran)
            return;
        this.ran = true;
        for (const fn of this.fns) {
            try {
                fn();
            }
            catch (e) {
                console.error("[Cleanup] Error:", e);
            }
        }
        this.fns.clear();
    }
}
// ---------------------------------------------------------------------------
// SSE constants
// ---------------------------------------------------------------------------
const SSE_KEEPALIVE_INTERVAL = 5000;
// ---------------------------------------------------------------------------
// Stall detection stats (Phase 4b)
// ---------------------------------------------------------------------------
let stallDetections = 0;
function sendJsonError(res, error) {
    res.status(error.status).json({
        error: {
            message: error.message,
            type: error.type,
            code: error.code,
        },
    });
}
function startStreamingResponse(res, requestId) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Request-Id", requestId);
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write(":ok\n\n");
}
function writeStreamingError(res, error) {
    if (res.writableEnded)
        return;
    res.write(`data: ${JSON.stringify({
        error: {
            message: error.message,
            type: error.type,
            code: error.code,
        },
    })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
}
function respondWithError(res, error, stream, requestId) {
    if (res.writableEnded)
        return;
    if (stream) {
        if (!res.headersSent) {
            startStreamingResponse(res, requestId);
        }
        writeStreamingError(res, error);
        return;
    }
    if (!res.headersSent) {
        sendJsonError(res, error);
    }
}
function logQueueDebug(event, fields) {
    if (!runtimeConfig.debugQueues)
        return;
    log(event, fields);
}
function createSupersededError(conversationId, supersedingRequestId) {
    return {
        status: 409,
        type: "invalid_request_error",
        code: "request_superseded",
        message: `Request for conversation '${conversationId}' was superseded by a newer message (${supersedingRequestId}).`,
    };
}
function clearQueuedRequests(conversationId, supersedingRequestId) {
    const entry = conversationQueues.get(conversationId);
    if (!entry || entry.queue.length === 0)
        return;
    const staleItems = entry.queue.splice(0);
    for (const item of staleItems) {
        log("queue.drop", {
            conversationId,
            requestId: item.requestId,
            reason: "superseded_by_newer_request",
            supersedingRequestId,
        });
        logQueueDebug("queue.drop", {
            conversationId,
            requestId: item.requestId,
            reason: "superseded_by_newer_request",
            supersedingRequestId,
            droppedQueuedRequests: staleItems.length,
        });
        item.reject(new RequestCancelledError(createSupersededError(conversationId, supersedingRequestId)));
    }
}
function supersedeActiveRequest(conversationId, supersedingRequestId) {
    const active = activeRequests.get(conversationId);
    if (!active || active.requestId === supersedingRequestId)
        return;
    const error = createSupersededError(conversationId, supersedingRequestId);
    log("request.cancel", {
        conversationId,
        requestId: active.requestId,
        reason: "superseded_by_newer_request",
        supersedingRequestId,
    });
    logQueueDebug("request.cancel", {
        conversationId,
        requestId: active.requestId,
        supersedingRequestId,
        reason: "superseded_by_newer_request",
        startedAt: active.startedAt,
        stream: active.stream,
    });
    if (active.cancel) {
        active.cancel(error);
    }
    else {
        active.pendingCancel = error;
    }
}
function registerActiveRequest(conversationId, requestId, stream) {
    const entry = {
        requestId,
        startedAt: Date.now(),
        stream,
    };
    activeRequests.set(conversationId, entry);
    return {
        setCancel(cancel) {
            entry.cancel = cancel;
            if (entry.pendingCancel) {
                const pending = entry.pendingCancel;
                entry.pendingCancel = undefined;
                cancel(pending);
            }
        },
        clear() {
            const current = activeRequests.get(conversationId);
            if (current === entry) {
                activeRequests.delete(conversationId);
            }
        },
    };
}
// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export async function handleChatCompletions(req, res) {
    const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
    const body = req.body;
    const stream = body.stream === true;
    const requestedModel = body.model ? String(body.model) : undefined;
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
        res.status(400).json({
            error: {
                message: "messages is required and must be a non-empty array",
                type: "invalid_request_error",
                code: "invalid_messages",
            },
        });
        return;
    }
    if (requestedModel && !isValidModel(requestedModel)) {
        res.status(400).json({
            error: {
                message: `Model '${requestedModel}' is not supported. Use GET /v1/models for available models.`,
                type: "invalid_request_error",
                code: "model_not_found",
            },
        });
        return;
    }
    const availability = await modelAvailability.getSnapshot();
    if (availability.available.length === 0) {
        sendJsonError(res, {
            status: 503,
            type: "server_error",
            code: "no_models_available",
            message: availability.unavailable[0]?.error.message || "No Claude models are currently accessible via Claude CLI.",
        });
        return;
    }
    const resolvedModel = await modelAvailability.resolveRequestedModel(requestedModel);
    if (!resolvedModel) {
        sendJsonError(res, {
            status: 503,
            type: "server_error",
            code: "model_unavailable",
            message: requestedModel
                ? `Model '${requestedModel}' is not currently available to this Claude CLI account. Use GET /v1/models to see accessible models.`
                : "No default Claude model is currently available.",
        });
        return;
    }
    const conversationId = body.user || requestId;
    if (runtimeConfig.sameConversationPolicy === "latest-wins") {
        clearQueuedRequests(conversationId, requestId);
        supersedeActiveRequest(conversationId, requestId);
    }
    const startTime = Date.now();
    const queueEntry = conversationQueues.get(conversationId);
    const queueDepth = queueEntry ? queueEntry.queue.length : 0;
    const MAX_QUEUE_DEPTH = 5;
    if (queueDepth >= MAX_QUEUE_DEPTH) {
        log("queue.blocked", { conversationId, depth: queueDepth });
        logQueueDebug("queue.blocked", {
            conversationId,
            requestId,
            depth: queueDepth,
            policy: runtimeConfig.sameConversationPolicy,
        });
        res.status(429).json({
            error: {
                message: `Too many queued requests for this conversation (${queueDepth}). Please wait for current requests to complete.`,
                type: "rate_limit_error",
                code: "queue_full",
            },
        });
        return;
    }
    // Compute hard timeout for queue wrapper
    const thinking = body.thinking;
    const tempModel = requestedModel || resolvedModel.id;
    const baseTimeout = getModelTimeout(tempModel);
    const hardTimeout = (thinking?.type === "enabled" && thinking.budget_tokens) ? baseTimeout * 3 : baseTimeout;
    log("request.start", { requestId, conversationId, model: tempModel, stream, queueDepth });
    try {
        await enqueueRequest(conversationId, requestId, async () => {
            const activeRequest = registerActiveRequest(conversationId, requestId, stream);
            try {
                const { sessionId, isResume } = sessionManager.getOrCreate(conversationId, resolvedModel.id);
                // Phase 5d: Log session context size for token accounting
                if (isResume) {
                    const contextSize = sessionManager.getContextSizeEstimate(conversationId);
                    log("session.context", { conversationId, estimatedContextTokens: contextSize, isResume });
                }
                conversationStore.ensureConversation(conversationId, resolvedModel.id, sessionId);
                const messages = body.messages;
                const lastUserMsg = messages.filter(m => m.role === "user").pop();
                if (lastUserMsg) {
                    const content = typeof lastUserMsg.content === "string"
                        ? lastUserMsg.content
                        : JSON.stringify(lastUserMsg.content);
                    conversationStore.addMessage(conversationId, "user", content);
                }
                const cliInput = openaiToCli(body, isResume, resolvedModel.id);
                cliInput.sessionId = sessionId;
                cliInput.isResume = isResume;
                cliInput._conversationId = conversationId;
                cliInput._startTime = startTime;
                if (thinking?.type === "enabled" && thinking.budget_tokens) {
                    cliInput.thinkingBudget = thinking.budget_tokens;
                }
                if (stream) {
                    await handleStreamingResponse(req, res, cliInput, requestId, activeRequest.setCancel);
                }
                else {
                    await handleNonStreamingResponse(res, cliInput, requestId, activeRequest.setCancel);
                }
            }
            finally {
                activeRequest.clear();
            }
        }, hardTimeout);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        logError("request.error", error, { requestId, conversationId });
        if (error instanceof RequestCancelledError) {
            respondWithError(res, error.proxyError, stream, requestId);
            return;
        }
        if (!res.headersSent) {
            sendJsonError(res, { status: 500, message, type: "server_error", code: null });
        }
    }
}
/**
 * Single function that wires up all event handlers on a subprocess and
 * returns a promise that resolves when the subprocess completes.
 * Eliminates the duplicated event handler wiring from the old retry logic.
 */
function runStreamingSubprocess(opts) {
    const { cliInput, requestId, res, onStall, registerCancel } = opts;
    const baseTimeout = getModelTimeout(cliInput.model);
    const hardTimeout = cliInput.thinkingBudget ? baseTimeout * 3 : baseTimeout;
    const stallTimeout = cliInput.thinkingBudget
        ? getStallTimeout(cliInput.model) * 3 // thinking blocks can take a long time before first text
        : getStallTimeout(cliInput.model);
    return new Promise((resolve) => {
        const subprocess = new ClaudeSubprocess();
        const cleanup = new CleanupSet();
        let isFirst = true;
        let lastModel = "claude-sonnet-4";
        let isComplete = false;
        let fullResponse = "";
        let clientDisconnected = false;
        let lastAssistantText = "";
        let lastAssistantError;
        let lastActivityAt = Date.now();
        const spawnTime = Date.now();
        let firstByteTime = 0;
        const chunkId = `chatcmpl-${requestId}`;
        const buildChunk = (text, model, first) => {
            const escaped = JSON.stringify(text);
            const ts = Math.floor(Date.now() / 1000);
            if (first) {
                return `data: {"id":"${chunkId}","object":"chat.completion.chunk","created":${ts},"model":"${model}","choices":[{"index":0,"delta":{"role":"assistant","content":${escaped}},"finish_reason":null}]}\n\n`;
            }
            return `data: {"id":"${chunkId}","object":"chat.completion.chunk","created":${ts},"model":"${model}","choices":[{"index":0,"delta":{"content":${escaped}},"finish_reason":null}]}\n\n`;
        };
        const finish = (success, cancelled = false) => {
            if (isComplete)
                return;
            isComplete = true;
            cleanup.runAll();
            resolve({ fullResponse, success, cancelled });
        };
        // SSE keepalive
        const keepaliveId = setInterval(() => {
            if (!isComplete && !clientDisconnected && !res.writableEnded) {
                res.write(":keepalive\n\n");
            }
        }, SSE_KEEPALIVE_INTERVAL);
        cleanup.add(() => clearInterval(keepaliveId));
        // Hard timeout (absolute wall clock)
        // Phase 5b: Only delete session on hard timeout (permanent error), not on stall (transient)
        const hardTimeoutId = setTimeout(() => {
            if (!isComplete) {
                log("request.timeout", {
                    requestId,
                    conversationId: cliInput._conversationId,
                    durationMs: Date.now() - (cliInput._startTime || Date.now()),
                    reason: "hard_timeout",
                    timeoutMs: hardTimeout,
                });
                subprocess.kill();
                if (cliInput._conversationId) {
                    sessionManager.delete(cliInput._conversationId);
                }
                if (!clientDisconnected && !res.writableEnded) {
                    res.write(`data: ${JSON.stringify({
                        error: { message: `Request timed out after ${hardTimeout / 1000}s`, type: "timeout_error", code: null },
                    })}\n\n`);
                    res.write("data: [DONE]\n\n");
                    res.end();
                }
                finish(false);
            }
        }, hardTimeout);
        cleanup.add(() => clearTimeout(hardTimeoutId));
        // Stall detection (Phase 1a): check periodically if lastActivityAt has gone stale
        // Phase 5b: Do NOT delete session on stall - it's transient. Only mark as failed for retry logic.
        const stallCheckInterval = setInterval(() => {
            if (isComplete)
                return;
            const stalledFor = Date.now() - lastActivityAt;
            if (stalledFor > stallTimeout) {
                stallDetections++;
                log("subprocess.stall", {
                    requestId,
                    conversationId: cliInput._conversationId,
                    pid: subprocess.getPid(),
                    stalledMs: stalledFor,
                    stallTimeoutMs: stallTimeout,
                    model: cliInput.model,
                });
                subprocess.kill();
                // Phase 5b: Mark as failed for retry (don't delete - it may be recoverable)
                if (cliInput._conversationId) {
                    sessionManager.markFailed(cliInput._conversationId);
                }
                if (!clientDisconnected && !res.writableEnded) {
                    res.write(`data: ${JSON.stringify({
                        error: { message: `Subprocess stalled (no activity for ${Math.round(stalledFor / 1000)}s)`, type: "timeout_error", code: "stall_detected" },
                    })}\n\n`);
                    res.write("data: [DONE]\n\n");
                    res.end();
                }
                onStall();
                finish(false);
            }
        }, Math.min(stallTimeout / 2, 10000));
        cleanup.add(() => clearInterval(stallCheckInterval));
        registerCancel?.((error) => {
            if (isComplete)
                return;
            log("subprocess.kill", {
                requestId,
                conversationId: cliInput._conversationId,
                pid: subprocess.getPid(),
                reason: error.code || "cancelled",
            });
            if (!res.writableEnded) {
                respondWithError(res, error, true, requestId);
            }
            subprocess.kill();
            finish(false, true);
        });
        // Client disconnect
        const onClose = () => {
            clientDisconnected = true;
            if (isComplete)
                return;
            log("subprocess.kill", {
                requestId,
                pid: subprocess.getPid(),
                reason: "client_disconnected",
            });
            subprocess.kill();
            if (fullResponse && cliInput._conversationId) {
                try {
                    conversationStore.addMessage(cliInput._conversationId, "assistant", fullResponse + "\n\n[Response truncated — client disconnected]");
                }
                catch (e) {
                    console.error("[Routes] Store error:", e);
                }
            }
            finish(false, true);
        };
        res.on("close", onClose);
        cleanup.add(() => res.removeListener("close", onClose));
        // Event handlers
        subprocess.on("content_delta", (event) => {
            lastActivityAt = Date.now(); // Reset stall timer
            const text = event.event?.delta?.text || "";
            fullResponse += text;
            if (clientDisconnected)
                return;
            if (text && !res.writableEnded) {
                if (isFirst && !firstByteTime) {
                    firstByteTime = Date.now();
                    const ttfb = firstByteTime - (cliInput._startTime || firstByteTime);
                    const spawnDelta = spawnTime - (cliInput._startTime || spawnTime);
                    const tokenDelta = firstByteTime - spawnTime;
                    log("request.start", {
                        requestId,
                        ttfbMs: ttfb,
                        spawnMs: spawnDelta,
                        firstTokenMs: tokenDelta,
                    });
                }
                res.write(buildChunk(text, lastModel, isFirst));
                isFirst = false;
            }
        });
        subprocess.on("assistant", (message) => {
            lastActivityAt = Date.now();
            lastModel = message.message.model;
            lastAssistantText = extractTextContent(message);
            lastAssistantError = message.error;
        });
        subprocess.on("result", (result) => {
            lastActivityAt = Date.now();
            const cliError = extractClaudeErrorFromResult(result, lastAssistantText, lastAssistantError);
            if (cliError) {
                log("request.error", { requestId, conversationId: cliInput._conversationId, reason: cliError.message });
                if (cliInput._conversationId && cliInput.isResume) {
                    sessionManager.markFailed(cliInput._conversationId);
                }
                try {
                    conversationStore.recordMetric("request_error", {
                        conversationId: cliInput._conversationId,
                        durationMs: Date.now() - (cliInput._startTime || Date.now()),
                        success: false,
                        error: cliError.message,
                        clientDisconnected,
                    });
                }
                catch (e) {
                    console.error("[Routes] Metric error:", e);
                }
                if (!clientDisconnected && !res.writableEnded) {
                    writeStreamingError(res, cliError);
                }
                finish(false);
                return;
            }
            // Phase 5c: Token validation and estimate fallback
            let usageData = null;
            if (result?.usage) {
                const promptTokens = result.usage.input_tokens || 0;
                const completionTokens = result.usage.output_tokens || 0;
                const validation = validateTokens(promptTokens, completionTokens, fullResponse.length);
                if (!validation.valid) {
                    log("token.validation_failed", {
                        requestId,
                        reason: validation.reason,
                        promptTokens,
                        completionTokens,
                        contentLength: fullResponse.length,
                    });
                    // Estimate tokens as fallback
                    const estimatedCompletion = estimateTokens(fullResponse);
                    usageData = {
                        prompt_tokens: promptTokens || 0,
                        completion_tokens: estimatedCompletion,
                        total_tokens: promptTokens + estimatedCompletion,
                    };
                }
                else {
                    usageData = {
                        prompt_tokens: promptTokens,
                        completion_tokens: completionTokens,
                        total_tokens: promptTokens + completionTokens,
                    };
                }
            }
            else if (fullResponse.length > 0) {
                // Phase 5c: Estimate tokens if not provided
                const estimatedCompletion = estimateTokens(fullResponse);
                usageData = {
                    prompt_tokens: 0,
                    completion_tokens: estimatedCompletion,
                    total_tokens: estimatedCompletion,
                };
            }
            try {
                if (fullResponse && cliInput._conversationId) {
                    conversationStore.addMessage(cliInput._conversationId, "assistant", fullResponse);
                }
                conversationStore.recordMetric("request_complete", {
                    conversationId: cliInput._conversationId,
                    durationMs: Date.now() - (cliInput._startTime || Date.now()),
                    success: true,
                    clientDisconnected,
                });
            }
            catch (e) {
                console.error("[Routes] Store error:", e);
            }
            // Mark session success
            if (cliInput._conversationId && cliInput.isResume) {
                sessionManager.markSuccess(cliInput._conversationId);
            }
            if (!clientDisconnected && !res.writableEnded) {
                const doneChunk = createDoneChunk(requestId, lastModel);
                if (usageData) {
                    doneChunk.usage = usageData;
                }
                res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
                res.write("data: [DONE]\n\n");
                res.end();
            }
            log("request.complete", {
                requestId,
                conversationId: cliInput._conversationId,
                model: lastModel,
                durationMs: Date.now() - (cliInput._startTime || Date.now()),
                responseLength: fullResponse.length,
                clientDisconnected,
            });
            finish(true);
        });
        subprocess.on("error", (error) => {
            logError("request.error", error, {
                requestId,
                conversationId: cliInput._conversationId,
            });
            try {
                conversationStore.recordMetric("request_error", {
                    conversationId: cliInput._conversationId,
                    durationMs: Date.now() - (cliInput._startTime || Date.now()),
                    success: false,
                    error: error.message,
                    clientDisconnected,
                });
            }
            catch (e) {
                console.error("[Routes] Metric error:", e);
            }
            if (!clientDisconnected && !res.writableEnded) {
                res.write(`data: ${JSON.stringify({
                    error: { message: error.message, type: "server_error", code: null },
                })}\n\n`);
                res.write("data: [DONE]\n\n");
                res.end();
            }
            finish(false);
        });
        subprocess.on("close", (code) => {
            if (!isComplete) {
                if (!clientDisconnected && !res.writableEnded) {
                    if (code !== 0) {
                        res.write(`data: ${JSON.stringify({
                            error: { message: `Process exited with code ${code}`, type: "server_error", code: null },
                        })}\n\n`);
                    }
                    res.write("data: [DONE]\n\n");
                    res.end();
                }
                finish(code === 0);
            }
        });
        // Start subprocess
        const startOpts = {
            model: cliInput.model,
            sessionId: cliInput.sessionId,
            systemPrompt: cliInput.systemPrompt,
            isResume: cliInput.isResume,
            thinkingBudget: cliInput.thinkingBudget,
        };
        subprocess.start(cliInput.prompt, startOpts).catch((err) => {
            logError("request.error", err, { requestId, reason: "subprocess_start_failed" });
            if (!clientDisconnected && !res.writableEnded) {
                res.write(`data: ${JSON.stringify({
                    error: { message: err.message, type: "server_error", code: null },
                })}\n\n`);
                res.write("data: [DONE]\n\n");
                res.end();
            }
            finish(false);
        });
    });
}
// ---------------------------------------------------------------------------
// Streaming handler
// ---------------------------------------------------------------------------
async function handleStreamingResponse(req, res, cliInput, requestId, registerCancel) {
    startStreamingResponse(res, requestId);
    // First attempt
    const result = await runStreamingSubprocess({
        cliInput,
        requestId,
        res,
        registerCancel,
        onStall: () => {
            if (cliInput._conversationId) {
                sessionManager.markFailed(cliInput._conversationId);
            }
        },
    });
    if (result.success || result.cancelled)
        return;
    // Retry once on failure (Phase 2a: clean retry without duplicated handlers)
    if (!res.writableEnded) {
        log("request.retry", { requestId, conversationId: cliInput._conversationId });
        // If resume failed, retry without resume
        const retryCli = { ...cliInput };
        if (retryCli.isResume && cliInput._conversationId) {
            sessionManager.markFailed(cliInput._conversationId);
            retryCli.isResume = false;
            // Get fresh session
            const { sessionId } = sessionManager.getOrCreate(cliInput._conversationId, cliInput.model);
            retryCli.sessionId = sessionId;
        }
        await new Promise(r => setTimeout(r, 1000)); // Brief backoff
        await runStreamingSubprocess({
            cliInput: retryCli,
            requestId,
            res,
            registerCancel,
            onStall: () => {
                if (cliInput._conversationId) {
                    sessionManager.markFailed(cliInput._conversationId);
                }
            },
        });
    }
}
// ---------------------------------------------------------------------------
// Non-streaming handler
// ---------------------------------------------------------------------------
async function handleNonStreamingResponse(res, cliInput, requestId, registerCancel) {
    const baseTimeout = getModelTimeout(cliInput.model);
    const timeout = cliInput.thinkingBudget ? baseTimeout * 3 : baseTimeout;
    return new Promise((resolve) => {
        const subprocess = new ClaudeSubprocess();
        const cleanup = new CleanupSet();
        let finalResult = null;
        let lastAssistantText = "";
        let lastAssistantError;
        let isComplete = false;
        registerCancel?.((error) => {
            if (isComplete)
                return;
            log("subprocess.kill", {
                requestId,
                conversationId: cliInput._conversationId,
                pid: subprocess.getPid(),
                reason: error.code || "cancelled",
            });
            subprocess.kill();
            isComplete = true;
            cleanup.runAll();
            respondWithError(res, error, false, requestId);
            resolve();
        });
        const timeoutId = setTimeout(() => {
            if (!isComplete) {
                log("request.timeout", { requestId, conversationId: cliInput._conversationId, timeoutMs: timeout });
                subprocess.kill();
                if (!res.headersSent) {
                    res.status(504).json({
                        error: { message: `Request timed out after ${timeout / 1000}s`, type: "timeout_error", code: null },
                    });
                }
                isComplete = true;
                cleanup.runAll();
                resolve();
            }
        }, timeout);
        cleanup.add(() => clearTimeout(timeoutId));
        subprocess.on("result", (result) => {
            finalResult = result;
        });
        subprocess.on("assistant", (message) => {
            lastAssistantText = extractTextContent(message);
            lastAssistantError = message.error;
        });
        subprocess.on("error", (error) => {
            isComplete = true;
            cleanup.runAll();
            logError("request.error", error, { requestId });
            if (!res.headersSent) {
                res.status(500).json({
                    error: { message: error.message, type: "server_error", code: null },
                });
            }
            resolve();
        });
        subprocess.on("close", (code) => {
            isComplete = true;
            cleanup.runAll();
            if (finalResult) {
                const cliError = extractClaudeErrorFromResult(finalResult, lastAssistantText, lastAssistantError);
                if (cliError) {
                    log("request.error", { requestId, conversationId: cliInput._conversationId, reason: cliError.message });
                    try {
                        conversationStore.recordMetric("request_error", {
                            conversationId: cliInput._conversationId,
                            durationMs: Date.now() - (cliInput._startTime || Date.now()),
                            success: false,
                            error: cliError.message,
                        });
                    }
                    catch (e) {
                        console.error("[Routes] Metric error:", e);
                    }
                    if (cliInput._conversationId && cliInput.isResume) {
                        sessionManager.markFailed(cliInput._conversationId);
                    }
                    if (!res.headersSent) {
                        sendJsonError(res, cliError);
                    }
                    resolve();
                    return;
                }
                try {
                    if (finalResult.result && cliInput._conversationId) {
                        conversationStore.addMessage(cliInput._conversationId, "assistant", finalResult.result);
                    }
                    conversationStore.recordMetric("request_complete", {
                        conversationId: cliInput._conversationId,
                        durationMs: Date.now() - (cliInput._startTime || Date.now()),
                        success: true,
                    });
                }
                catch (e) {
                    console.error("[Routes] Store error:", e);
                }
                if (cliInput._conversationId && cliInput.isResume) {
                    sessionManager.markSuccess(cliInput._conversationId);
                }
                if (!res.headersSent) {
                    res.json(cliResultToOpenai(finalResult, requestId));
                }
            }
            else if (!res.headersSent) {
                res.status(500).json({
                    error: {
                        message: `Claude CLI exited with code ${code} without response`,
                        type: "server_error",
                        code: null,
                    },
                });
            }
            resolve();
        });
        subprocess.start(cliInput.prompt, {
            model: cliInput.model,
            sessionId: cliInput.sessionId,
            systemPrompt: cliInput.systemPrompt,
            isResume: cliInput.isResume,
            thinkingBudget: cliInput.thinkingBudget,
        }).catch((error) => {
            cleanup.runAll();
            if (!res.headersSent) {
                res.status(500).json({
                    error: { message: error.message, type: "server_error", code: null },
                });
            }
            resolve();
        });
    });
}
// ---------------------------------------------------------------------------
// Models endpoint
// ---------------------------------------------------------------------------
export async function handleModels(_req, res) {
    const data = await modelAvailability.getPublicModelList();
    res.json({
        object: "list",
        data,
    });
}
// ---------------------------------------------------------------------------
// Enhanced health endpoint (Phase 4b)
// ---------------------------------------------------------------------------
export async function handleHealth(_req, res) {
    let metrics = null;
    let storeStats = null;
    let poolStatus = null;
    let recentErrors = [];
    let availability = null;
    try {
        metrics = conversationStore.getHealthMetrics(60);
        storeStats = conversationStore.getStats();
        recentErrors = conversationStore.getRecentErrors(5);
    }
    catch { /* store not initialized yet */ }
    try {
        poolStatus = subprocessPool.getStatus();
    }
    catch { /* pool not ready */ }
    try {
        availability = await modelAvailability.getSnapshot();
    }
    catch { /* availability probe failed */ }
    // Queue status
    const queueStatus = {};
    for (const [convId, entry] of conversationQueues) {
        if (entry.queue.length > 0 || entry.processing) {
            const oldestItem = entry.queue[0];
            queueStatus[convId] = {
                queued: entry.queue.length,
                processing: entry.processing,
                waitMs: oldestItem ? Date.now() - oldestItem.enqueuedAt : undefined,
            };
        }
    }
    // Subprocess registry
    const activePids = subprocessRegistry.getActivePids();
    // Session failure stats
    const failureStats = sessionManager.getFailureStats();
    res.json({
        status: "ok",
        provider: "claude-code-cli",
        timestamp: new Date().toISOString(),
        sessions: {
            active: sessionManager.size,
            failureStats,
        },
        subprocesses: {
            active: activePids.length,
            pids: activePids,
        },
        config: {
            sameConversationPolicy: runtimeConfig.sameConversationPolicy,
            debugQueues: runtimeConfig.debugQueues,
        },
        auth: availability?.auth ?? undefined,
        models: availability ? {
            checkedAt: new Date(availability.checkedAt).toISOString(),
            available: availability.available.map((model) => model.id),
            unavailable: availability.unavailable.map((entry) => ({
                id: entry.definition.id,
                code: entry.error.code,
                message: entry.error.message,
            })),
        } : undefined,
        pool: poolStatus,
        store: storeStats,
        metrics,
        recentErrors,
        stallDetections,
        queues: Object.keys(queueStatus).length > 0 ? queueStatus : undefined,
    });
}
//# sourceMappingURL=routes.js.map