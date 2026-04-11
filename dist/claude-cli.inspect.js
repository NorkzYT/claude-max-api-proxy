import { spawn } from "child_process";
import { extractTextContent } from "./adapter/cli-to-openai.js";
import { isAssistantMessage, isResultMessage } from "./types/claude-cli.js";
const DEFAULT_COMMAND_TIMEOUT_MS = 10000;
const PROBE_PROMPT = "Reply with exactly: OK";
const CLEAN_CLAUDE_ENV = (() => {
    const env = { ...process.env };
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_SESSION;
    delete env.CLAUDE_CODE_PARENT;
    return env;
})();
export function getCleanClaudeEnv() {
    return { ...CLEAN_CLAUDE_ENV };
}
export function parseClaudeJsonOutput(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        return [];
    try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
            return parsed;
        }
        return [parsed];
    }
    catch {
        const messages = [];
        for (const line of trimmed.split(/\r?\n/)) {
            const candidate = line.trim();
            if (!candidate)
                continue;
            try {
                messages.push(JSON.parse(candidate));
            }
            catch {
                // Ignore non-JSON log lines emitted alongside structured output.
            }
        }
        return messages;
    }
}
export function parseAuthStatus(raw) {
    try {
        const parsed = JSON.parse(raw.trim());
        if (typeof parsed.loggedIn !== "boolean") {
            return null;
        }
        return parsed;
    }
    catch {
        return null;
    }
}
function extractAssistantErrorType(messages) {
    const assistant = messages.find(isAssistantMessage);
    return assistant?.error;
}
function extractAssistantText(messages) {
    const assistant = messages.find(isAssistantMessage);
    if (!assistant)
        return "";
    return extractTextContent(assistant);
}
function looksLikeCliError(message) {
    return /issue with the selected model|not authenticated|auth login|authentication|rate limit|budget|permission denied|invalid request/i.test(message);
}
export function classifyClaudeError(message, rawType) {
    const normalized = message.trim() || "Claude CLI request failed";
    const lower = normalized.toLowerCase();
    const isModelError = /selected model|may not exist|do not have access|don't have access/i.test(normalized);
    if (isModelError) {
        return {
            status: 400,
            type: "invalid_request_error",
            code: "model_unavailable",
            message: normalized,
            rawType,
        };
    }
    if (/not authenticated|auth login|authentication|logged out|oauth|token/i.test(lower)) {
        return {
            status: 401,
            type: "authentication_error",
            code: "auth_required",
            message: normalized,
            rawType,
        };
    }
    if (/rate limit|too many requests|budget/i.test(lower)) {
        return {
            status: 429,
            type: "rate_limit_error",
            code: "rate_limited",
            message: normalized,
            rawType,
        };
    }
    if (rawType === "invalid_request") {
        return {
            status: 400,
            type: "invalid_request_error",
            code: "invalid_request",
            message: normalized,
            rawType,
        };
    }
    return {
        status: 502,
        type: "server_error",
        code: "claude_cli_error",
        message: normalized,
        rawType,
    };
}
export function extractClaudeErrorFromMessages(messages) {
    const result = messages.find(isResultMessage);
    const assistantMessage = extractAssistantText(messages);
    const assistantError = extractAssistantErrorType(messages);
    if (result) {
        return extractClaudeErrorFromResult(result, assistantMessage, assistantError);
    }
    if (assistantError || looksLikeCliError(assistantMessage)) {
        return classifyClaudeError(assistantMessage, assistantError);
    }
    return null;
}
export function extractClaudeErrorFromResult(result, assistantText = "", assistantError) {
    const message = (assistantText || result.result || "").trim();
    if (!result.is_error && result.subtype !== "error" && !assistantError && !looksLikeCliError(message)) {
        return null;
    }
    return classifyClaudeError(message || "Claude CLI request failed", assistantError);
}
export async function runClaudeCommand(args, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    return new Promise((resolve) => {
        const proc = spawn("claude", args, {
            stdio: ["ignore", "pipe", "pipe"],
            env: getCleanClaudeEnv(),
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timeoutId = setTimeout(() => {
            timedOut = true;
            try {
                proc.kill("SIGTERM");
            }
            catch {
                // ignore
            }
        }, timeoutMs);
        proc.stdout?.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        proc.stderr?.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        proc.on("error", () => {
            clearTimeout(timeoutId);
            resolve({ stdout, stderr, code: null, signal: null, timedOut });
        });
        proc.on("close", (code, signal) => {
            clearTimeout(timeoutId);
            resolve({ stdout, stderr, code, signal, timedOut });
        });
    });
}
export async function verifyClaude() {
    const result = await runClaudeCommand(["--version"], 5000);
    if (result.code === 0) {
        return { ok: true, version: result.stdout.trim() };
    }
    return {
        ok: false,
        error: "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code",
    };
}
export async function verifyAuth() {
    const result = await runClaudeCommand(["auth", "status"], 5000);
    const raw = result.stdout.trim() || result.stderr.trim();
    const status = parseAuthStatus(raw);
    if (!status) {
        return {
            ok: false,
            error: "Claude CLI authentication status could not be determined",
        };
    }
    if (!status.loggedIn) {
        return {
            ok: false,
            error: "Claude CLI is not authenticated. Run: claude auth login",
            status,
        };
    }
    return { ok: true, status };
}
export async function probeModelAvailability(model) {
    const result = await runClaudeCommand([
        "--print",
        "--output-format",
        "json",
        "--model",
        model,
        PROBE_PROMPT,
    ], 15000);
    const messages = parseClaudeJsonOutput(result.stdout);
    const error = extractClaudeErrorFromMessages(messages);
    if (error) {
        return { ok: false, model, error };
    }
    const initMessage = messages.find((message) => message.type === "system" && message.subtype === "init");
    return {
        ok: result.code === 0,
        model,
        resolvedModel: initMessage?.model,
        error: result.code === 0 ? undefined : classifyClaudeError(result.stderr.trim() || result.stdout.trim() || `Claude CLI exited with code ${result.code}`),
    };
}
//# sourceMappingURL=claude-cli.inspect.js.map