/**
 * Centralized request-timeout policy.
 *
 * Single source of truth for how long the proxy waits before force-stopping a
 * Claude CLI subprocess (hard + stall timeouts) and for the underlying Node
 * HTTP server socket timeouts. Per-model *base* values live in models.ts; this
 * module layers the env-tunable *policy* (reasoning multiplier, absolute
 * overrides, and minimum floors) on top, so a long-"thinking" request gets a
 * generous, configurable window instead of being cut at a hidden default.
 *
 * Why this exists: previously the reasoning multiplier (x3) was hardcoded in
 * chat-execution.ts and the Node HTTP server inherited Node's default
 * `requestTimeout` of 300000ms (5 min) because it was never set. Both are now
 * here, env-driven, so new machines reproduce behavior without code changes —
 * the defaults alone guarantee a 15-minute idle ("thinking") window.
 *
 * Every knob is read once at module load. Resolver functions accept an optional
 * `policy` argument so they stay pure and unit-testable.
 */
import { getModelTimeout, getStallTimeout } from "./models.js";

function parseOptionalPositiveInt(
  value: string | undefined,
): number | undefined {
  if (value == null || value.trim() === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parsePositiveIntWithDefault(
  value: string | undefined,
  fallback: number,
): number {
  return parseOptionalPositiveInt(value) ?? fallback;
}

/** Server socket timeouts allow 0 ("disabled" in Node's http server). */
function parseNonNegativeIntWithDefault(
  value: string | undefined,
  fallback: number,
): number {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePositiveFloatWithDefault(
  value: string | undefined,
  fallback: number,
): number {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface ServerTimeouts {
  /** Node http.Server.requestTimeout. 0 disables (removes Node's 5-min default). */
  requestTimeoutMs: number;
  /** Node http.Server.headersTimeout. */
  headersTimeoutMs: number;
  /** Node http.Server.keepAliveTimeout. */
  keepAliveTimeoutMs: number;
}

export interface TimeoutPolicy {
  /** Multiplier applied to base hard/stall timeouts when reasoning is active. */
  reasoningMultiplier: number;
  /** Absolute hard timeout (ms). Bypasses per-model base + multiplier when set. */
  hardOverrideMs?: number;
  /** Absolute stall timeout (ms). Bypasses per-model base + multiplier when set. */
  stallOverrideMs?: number;
  /** Lower bound for the effective hard (overall) timeout. */
  minHardMs: number;
  /** Lower bound for the effective stall (idle / "thinking") timeout. */
  minStallMs: number;
  server: ServerTimeouts;
}

// --- Defaults (overridable via env) ---------------------------------------
// The min-stall floor is the headline knob: it guarantees a request can sit
// with no output for this long before being force-stopped, regardless of model
// or reasoning state. 15 min by default so long thinking phases "finish
// properly" instead of dying at the old ~5-6 min mark.
const DEFAULT_REASONING_MULTIPLIER = 3;
const DEFAULT_MIN_STALL_MS = 900_000; // 15 min idle/"thinking" window
const DEFAULT_MIN_HARD_MS = 1_800_000; // 30 min overall floor
const DEFAULT_HARD_STALL_BUFFER_MS = 60_000; // hard must exceed stall by >= this
const DEFAULT_SERVER_REQUEST_TIMEOUT_MS = 0; // disable Node's 5-min default
const DEFAULT_SERVER_HEADERS_TIMEOUT_MS = 65_000;
const DEFAULT_SERVER_KEEPALIVE_TIMEOUT_MS = 75_000;

export function readTimeoutPolicy(
  env: NodeJS.ProcessEnv = process.env,
): TimeoutPolicy {
  return {
    reasoningMultiplier: parsePositiveFloatWithDefault(
      env.CLAUDE_PROXY_REASONING_TIMEOUT_MULTIPLIER,
      DEFAULT_REASONING_MULTIPLIER,
    ),
    hardOverrideMs: parseOptionalPositiveInt(env.CLAUDE_PROXY_HARD_TIMEOUT_MS),
    stallOverrideMs: parseOptionalPositiveInt(env.CLAUDE_PROXY_STALL_TIMEOUT_MS),
    minHardMs: parsePositiveIntWithDefault(
      env.CLAUDE_PROXY_MIN_HARD_TIMEOUT_MS,
      DEFAULT_MIN_HARD_MS,
    ),
    minStallMs: parsePositiveIntWithDefault(
      env.CLAUDE_PROXY_MIN_STALL_TIMEOUT_MS,
      DEFAULT_MIN_STALL_MS,
    ),
    server: {
      requestTimeoutMs: parseNonNegativeIntWithDefault(
        env.CLAUDE_PROXY_SERVER_REQUEST_TIMEOUT_MS,
        DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
      ),
      headersTimeoutMs: parseNonNegativeIntWithDefault(
        env.CLAUDE_PROXY_SERVER_HEADERS_TIMEOUT_MS,
        DEFAULT_SERVER_HEADERS_TIMEOUT_MS,
      ),
      keepAliveTimeoutMs: parseNonNegativeIntWithDefault(
        env.CLAUDE_PROXY_SERVER_KEEPALIVE_TIMEOUT_MS,
        DEFAULT_SERVER_KEEPALIVE_TIMEOUT_MS,
      ),
    },
  };
}

export const timeoutPolicy = readTimeoutPolicy();

/**
 * Effective stall (idle / "thinking") timeout for a model. This is the maximum
 * time the subprocess may emit no activity before being force-stopped.
 */
export function resolveStallTimeout(
  model: string,
  hasReasoning: boolean,
  policy: TimeoutPolicy = timeoutPolicy,
): number {
  const base =
    policy.stallOverrideMs ??
    getStallTimeout(model) * (hasReasoning ? policy.reasoningMultiplier : 1);
  return Math.max(Math.round(base), policy.minStallMs);
}

/**
 * Effective hard (overall) timeout for a model. Always strictly greater than
 * the resolved stall timeout so the idle detector fires first on a stuck run.
 */
export function resolveHardTimeout(
  model: string,
  hasReasoning: boolean,
  policy: TimeoutPolicy = timeoutPolicy,
): number {
  const base =
    policy.hardOverrideMs ??
    getModelTimeout(model) * (hasReasoning ? policy.reasoningMultiplier : 1);
  const stall = resolveStallTimeout(model, hasReasoning, policy);
  return Math.max(
    Math.round(base),
    policy.minHardMs,
    stall + DEFAULT_HARD_STALL_BUFFER_MS,
  );
}

/**
 * Node HTTP server socket timeouts. headersTimeout is clamped to requestTimeout
 * when the latter is enabled (Node rejects headersTimeout > requestTimeout).
 */
export function resolveServerTimeouts(
  policy: TimeoutPolicy = timeoutPolicy,
): ServerTimeouts {
  const server = { ...policy.server };
  if (
    server.requestTimeoutMs > 0 &&
    server.headersTimeoutMs > server.requestTimeoutMs
  ) {
    server.headersTimeoutMs = server.requestTimeoutMs;
  }
  return server;
}
