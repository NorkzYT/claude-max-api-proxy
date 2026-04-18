/**
 * Proactive OAuth refresh (defense in depth).
 *
 * Every REFRESH_CHECK_INTERVAL_MS, peek at the Claude credentials file. If
 * the access_token is due to expire within REFRESH_WHEN_WITHIN_MS, fire a
 * single lightweight `claude --print` through the token gate so the CLI
 * drives a fresh refresh while the proxy is otherwise idle. This shrinks
 * the window where a bursty Discord workload could race on the refresh.
 *
 * - Uses `runClaudeCommand` so the call is already gated.
 * - Idempotent start/stop so callers can guard against double-starts.
 * - Explicitly NOT started in unit tests; only `startServer` kicks it off.
 */
import fs from "node:fs";
import path from "node:path";
import { log, logError } from "../logger.js";
import { runClaudeCommand } from "../claude-cli.inspect.js";

const REFRESH_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const REFRESH_WHEN_WITHIN_MS = 2 * 60 * 60 * 1000; // 2 hours
const PROACTIVE_CALL_TIMEOUT_MS = 30_000;

interface ClaudeCredentials {
  claudeAiOauth?: {
    expiresAt?: number;
  };
}

function defaultCredentialsPath(): string {
  return path.join(process.env.HOME || "/tmp", ".claude", ".credentials.json");
}

function readExpiresAt(credentialsPath: string): number | null {
  try {
    const raw = fs.readFileSync(credentialsPath, "utf8");
    const parsed = JSON.parse(raw) as ClaudeCredentials;
    const expiresAt = parsed?.claudeAiOauth?.expiresAt;
    return typeof expiresAt === "number" && Number.isFinite(expiresAt)
      ? expiresAt
      : null;
  } catch {
    return null;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export async function runProactiveRefreshTick(
  credentialsPath: string = defaultCredentialsPath(),
  now: () => number = Date.now,
): Promise<void> {
  const expiresAt = readExpiresAt(credentialsPath);
  if (expiresAt === null) return;
  const msUntilExpiry = expiresAt - now();
  if (msUntilExpiry > REFRESH_WHEN_WITHIN_MS) return;

  try {
    const result = await runClaudeCommand(
      ["--print", "--model", "haiku", "--output-format", "json", "ok"],
      PROACTIVE_CALL_TIMEOUT_MS,
    );
    log("auth.proactive_refresh", {
      reason: "near_expiry",
      msUntilExpiry,
      exitCode: result.code,
      timedOut: result.timedOut,
    });
  } catch (err) {
    logError("auth.proactive_refresh", err, {
      reason: "spawn_failed",
      msUntilExpiry,
    });
  }
}

export function startProactiveRefresh(): void {
  if (timer) return;
  timer = setInterval(() => {
    runProactiveRefreshTick().catch((err) => {
      logError("auth.proactive_refresh", err, { reason: "tick_failed" });
    });
  }, REFRESH_CHECK_INTERVAL_MS);
  // Don't keep the Node event loop alive solely for this interval.
  if (typeof timer.unref === "function") {
    timer.unref();
  }
}

export function stopProactiveRefresh(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
