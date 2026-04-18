/**
 * Token Gate: serialize `claude` CLI spawns around the OAuth refresh window.
 *
 * Background
 * ----------
 * The Claude CLI's OAuth refresh_token is rotated on every refresh: as soon as
 * a new pair is issued, the previous refresh_token becomes invalid. When
 * several `claude` subprocesses start concurrently and the access_token is
 * close to its TTL, each child may try to refresh independently. The first
 * POST wins; the others send a now-invalidated refresh_token and either
 * overwrite `.credentials.json` with a stale response, or the access_token
 * they just received gets superseded by the winner's write. The net result is
 * a "zombie" credential file that looks valid locally (fresh `expiresAt`) but
 * is already revoked server-side.
 *
 * Design
 * ------
 * - Exposes `runGated(fn)` that runs `fn()` through a cross-process mutex
 *   ONLY when `now` falls inside `[expiresAt - 30min, expiresAt + 5min]`.
 * - Outside that window we take the fast path (no serialization overhead).
 * - The mutex is a `proper-lockfile` directory lock on a sibling file in the
 *   credentials directory, so ANY process on the host sharing the mount —
 *   a host user's `claude` session and the containerized proxy's subprocess
 *   pool alike — serializes against the same inode. This closes the gap
 *   where the previous in-process mutex couldn't see a concurrent refresh
 *   performed by a sibling `claude` CLI running on the host.
 * - Credentials file is re-read on every call so refreshes performed by the
 *   CLI are visible immediately.
 * - Missing / malformed credentials file → fast path (fail-open to avoid
 *   deadlocking the proxy if the file is briefly absent).
 * - The host-side user can opt in via the `claude-gated` wrapper
 *   (openclaw-home/bin/claude-gated), which flocks the same file before
 *   exec'ing `claude`. Without it, the lock still serializes all
 *   in-container spawns (the bulk of refresh pressure) and reduces but
 *   does not eliminate the host/container race.
 */
import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { log, logError } from "../logger.js";

const REFRESH_LEAD_MS = 30 * 60 * 1000; // 30 minutes before expiry
const REFRESH_TAIL_MS = 5 * 60 * 1000; // 5 minutes after expiry (grace)
const LOCK_STALE_MS = 60 * 1000; // treat a held lock as stale after 60s
const LOCK_RETRIES = 10;
const LOCK_MIN_TIMEOUT_MS = 100;
const LOCK_MAX_TIMEOUT_MS = 3000;

interface ClaudeCredentials {
  claudeAiOauth?: {
    expiresAt?: number;
  };
}

export interface TokenGateOptions {
  credentialsPath?: string;
  leadMs?: number;
  tailMs?: number;
  now?: () => number;
  /**
   * Override the acquire function (tests). Given the path to the lock target,
   * resolves to a release function. Default uses `proper-lockfile.lock`.
   */
  acquire?: (lockTarget: string) => Promise<() => Promise<void>>;
}

/**
 * Default acquire: `proper-lockfile.lock` on the credentials file itself.
 * `proper-lockfile` lays down a `<path>.lock` sibling directory, which is
 * atomic across processes sharing the same mount.
 */
async function defaultAcquire(
  lockTarget: string,
): Promise<() => Promise<void>> {
  const release = await lockfile.lock(lockTarget, {
    stale: LOCK_STALE_MS,
    retries: {
      retries: LOCK_RETRIES,
      factor: 1.5,
      minTimeout: LOCK_MIN_TIMEOUT_MS,
      maxTimeout: LOCK_MAX_TIMEOUT_MS,
      randomize: true,
    },
    realpath: false,
  });
  return release;
}

export class TokenGate {
  private readonly credentialsPath: string;
  private readonly leadMs: number;
  private readonly tailMs: number;
  private readonly now: () => number;
  private readonly acquire: (
    lockTarget: string,
  ) => Promise<() => Promise<void>>;
  private watcher: fs.FSWatcher | null = null;
  private lastExpiresAt: number | null = null;

  constructor(options: TokenGateOptions = {}) {
    this.credentialsPath =
      options.credentialsPath ??
      path.join(process.env.HOME || "/tmp", ".claude", ".credentials.json");
    this.leadMs = options.leadMs ?? REFRESH_LEAD_MS;
    this.tailMs = options.tailMs ?? REFRESH_TAIL_MS;
    this.now = options.now ?? Date.now;
    this.acquire = options.acquire ?? defaultAcquire;
  }

  /**
   * Read the OAuth expiresAt timestamp from the credentials file.
   * Returns `null` if the file is missing, unreadable, or malformed.
   */
  private readExpiresAt(): number | null {
    try {
      const raw = fs.readFileSync(this.credentialsPath, "utf8");
      const parsed = JSON.parse(raw) as ClaudeCredentials;
      const expiresAt = parsed?.claudeAiOauth?.expiresAt;
      return typeof expiresAt === "number" && Number.isFinite(expiresAt)
        ? expiresAt
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Whether `now` falls inside the refresh window. Exposed for tests.
   */
  isInRefreshWindow(): boolean {
    const expiresAt = this.readExpiresAt();
    if (expiresAt === null) return false;
    const now = this.now();
    return now >= expiresAt - this.leadMs && now <= expiresAt + this.tailMs;
  }

  /**
   * Run `fn` with token-refresh serialization applied only when necessary.
   *
   * Inside the refresh window: acquire a cross-process filesystem lock
   * (via `proper-lockfile`) held for the ENTIRE lifetime of `fn` (including
   * any streaming subprocess), so only one `claude` subprocess can drive a
   * refresh at a time — across the host boundary.
   *
   * Outside the window: fast-path — invoke `fn` directly.
   *
   * Lock failures fail-open: if the lock cannot be acquired (e.g., the lock
   * file is in a read-only mount), log and fall through to fn so we never
   * deadlock the proxy.
   */
  async runGated<T>(fn: () => Promise<T>): Promise<T> {
    const expiresAt = this.readExpiresAt();
    const now = this.now();
    const inWindow =
      expiresAt !== null &&
      now >= expiresAt - this.leadMs &&
      now <= expiresAt + this.tailMs;

    if (!inWindow) {
      return fn();
    }

    const msUntilExpiry = expiresAt !== null ? expiresAt - now : null;
    const enterStart = Date.now();
    let release: (() => Promise<void>) | null = null;
    let contended = false;

    try {
      release = await this.acquire(this.credentialsPath);
    } catch (err) {
      logError("auth.gate_contended", err, {
        msUntilExpiry,
        reason: "acquire_failed",
      });
      // Fail-open: run without the lock rather than deadlocking.
      return fn();
    }

    const acquireDurationMs = Date.now() - enterStart;
    contended = acquireDurationMs > LOCK_MIN_TIMEOUT_MS;

    log("auth.gate_entered", {
      msUntilExpiry,
      acquireDurationMs,
      contended,
    });

    const fnStart = Date.now();
    try {
      return await fn();
    } finally {
      const fnDurationMs = Date.now() - fnStart;
      try {
        await release();
      } catch (err) {
        logError("auth.gate_released", err, {
          fnDurationMs,
          reason: "release_failed",
        });
      }
      log("auth.gate_released", { fnDurationMs });
    }
  }

  /**
   * Start a best-effort watcher on the credentials file. Emits
   * `auth.credentials_changed` whenever the file's `expiresAt` differs from
   * the previously observed value. Safe to call multiple times (idempotent).
   *
   * The watcher is an optional diagnostic — if `fs.watch` throws (rare but
   * possible on some mount types), we log and move on.
   */
  startCredentialsWatcher(): void {
    if (this.watcher) return;
    this.lastExpiresAt = this.readExpiresAt();
    try {
      this.watcher = fs.watch(this.credentialsPath, () => {
        const next = this.readExpiresAt();
        if (next !== this.lastExpiresAt) {
          log("auth.credentials_changed", {
            prevExpiresAt: this.lastExpiresAt,
            nextExpiresAt: next,
            deltaMs:
              this.lastExpiresAt !== null && next !== null
                ? next - this.lastExpiresAt
                : null,
          });
          this.lastExpiresAt = next;
        }
      });
      if (typeof this.watcher.unref === "function") {
        this.watcher.unref();
      }
    } catch (err) {
      logError("auth.credentials_changed", err, {
        reason: "watch_failed",
      });
    }
  }

  stopCredentialsWatcher(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}

export const tokenGate = new TokenGate();
