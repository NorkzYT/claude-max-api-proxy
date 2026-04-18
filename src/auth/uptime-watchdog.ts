/**
 * Preventive self-restart watchdog.
 *
 * After `maxMs` of continuous uptime, calls `process.exit(0)`. Docker's
 * `restart: unless-stopped` brings the container back up with a fresh
 * Node process — clean subprocess pool, no accumulated in-process state,
 * and a re-read of the credentials file.
 *
 * Rationale: even with `TokenGate` serialization, a host-side `claude`
 * session sharing `~/.claude/.credentials.json` can rotate the refresh
 * token while the container is mid-request. Once that happens the
 * container's in-flight state may be "zombie" — local file looks valid,
 * upstream 401s every call, and the only recovery was historically
 * `make rebuild-proxy`. Rolling the container every few hours keeps us
 * out of the zombie trap while the finer-grained cross-process lock
 * (token-gate.ts) has time to prove itself in soak.
 *
 * Configurable via env `CLAUDE_PROXY_MAX_UPTIME_HOURS`:
 *   - unset / empty / 0 / negative → watchdog disabled.
 *   - any positive number (float ok) → that many hours.
 *
 * The schedule is randomized within ±10% of the target to avoid fleet-wide
 * synchronized restarts when multiple proxies boot together.
 */
import { log } from "../logger.js";

const DEFAULT_MAX_UPTIME_HOURS = 4;

export interface UptimeWatchdogOptions {
  maxUptimeHours?: number;
  /** Test hook: override the scheduler. Default uses `setTimeout`. */
  schedule?: (fn: () => void, ms: number) => NodeJS.Timeout;
  /** Test hook: override the exit. Default uses `process.exit`. */
  exit?: (code: number) => void;
  /** Test hook: override jitter. Default uses `Math.random`. */
  random?: () => number;
}

/**
 * Resolve the configured uptime ceiling. Returns `null` when disabled.
 */
export function resolveMaxUptimeMs(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = env.CLAUDE_PROXY_MAX_UPTIME_HOURS;
  if (raw === undefined || raw === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed * 60 * 60 * 1000;
}

/**
 * Schedule a self-restart after `maxMs`. No-op when `maxMs` is null.
 * Returns the timer handle (for tests) or null when disabled.
 */
export function scheduleSelfRestart(
  options: UptimeWatchdogOptions & { maxMs?: number | null } = {},
): NodeJS.Timeout | null {
  const maxMs =
    options.maxMs ??
    (options.maxUptimeHours !== undefined
      ? options.maxUptimeHours * 60 * 60 * 1000
      : resolveMaxUptimeMs());
  if (maxMs === null || maxMs <= 0) {
    return null;
  }

  const schedule = options.schedule ?? setTimeout;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const random = options.random ?? Math.random;

  // ±10% jitter so co-located proxies don't restart in lockstep.
  const jitter = (random() * 0.2 - 0.1) * maxMs;
  const scheduledMs = Math.max(60_000, Math.floor(maxMs + jitter));

  log("server.self_restart", {
    phase: "scheduled",
    scheduledInMs: scheduledMs,
    maxUptimeMs: maxMs,
  });

  const timer = schedule(() => {
    log("server.self_restart", {
      phase: "firing",
      reason: "uptime_ceiling",
      scheduledMs,
    });
    // Give the log a tick to flush before we exit.
    setTimeout(() => exit(0), 100);
  }, scheduledMs);

  if (timer && typeof (timer as NodeJS.Timeout).unref === "function") {
    (timer as NodeJS.Timeout).unref();
  }
  return timer as NodeJS.Timeout;
}
