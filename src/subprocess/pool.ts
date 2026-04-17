/**
 * Subprocess Warm-up Pool
 *
 * Pre-spawns Claude CLI processes so requests don't pay cold-start cost.
 */
import { spawn } from "child_process";
import { getCleanClaudeEnv } from "../claude-cli.inspect.js";
import { tokenGate } from "../auth/token-gate.js";
import { log, logError } from "../logger.js";

const POOL_SIZE = 5;
const WARMUP_INTERVAL_MS = 30 * 1000;
// Only log warm success when the duration spikes past this threshold. The
// per-cycle happy-path success fires every 30s and has zero diagnostic
// value — it buried structured events in `docker logs`.
const WARM_SLOW_THRESHOLD_MS = 2000;

class SubprocessPool {
  private warmedAt = 0;
  private warming = false;

  async warm(): Promise<void> {
    if (this.warming) return;
    this.warming = true;
    const isInitial = this.warmedAt === 0;
    const start = Date.now();
    try {
      const promises: Promise<void>[] = [];
      for (let i = 0; i < POOL_SIZE; i++) {
        promises.push(this.spawnQuick());
      }
      await Promise.allSettled(promises);
      if (isInitial) {
        await this.warmDeep();
      }
      this.warmedAt = Date.now();
      const durationMs = Date.now() - start;
      if (isInitial || durationMs >= WARM_SLOW_THRESHOLD_MS) {
        log("pool.warmed", {
          poolSize: POOL_SIZE,
          deepWarm: isInitial,
          durationMs,
        });
      }
    } catch (err) {
      logError("pool.warm_failed", err, { poolSize: POOL_SIZE });
    } finally {
      this.warming = false;
    }
  }

  private spawnQuick(): Promise<void> {
    return new Promise<void>((resolve) => {
      const proc = spawn("claude", ["--version"], {
        stdio: "pipe",
        env: getCleanClaudeEnv(),
      });
      proc.on("close", () => resolve());
      proc.on("error", () => resolve());
      setTimeout(() => {
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
        resolve();
      }, 5000);
    });
  }

  private warmDeep(): Promise<void> {
    // warmDeep is auth-touching (spawns `claude --print ...`) so route it
    // through the token gate. Outside the refresh window this is a no-op;
    // inside the window it serializes with request-path spawns so only one
    // subprocess can drive the refresh_token rotation at a time.
    return tokenGate.runGated<void>(
      () =>
        new Promise<void>((resolve) => {
          try {
            const proc = spawn(
              "claude",
              [
                "--print",
                "--output-format",
                "stream-json",
                "--model",
                "haiku",
                "hi",
              ],
              { stdio: "pipe", env: getCleanClaudeEnv() },
            );
            let done = false;
            const finish = (): void => {
              if (done) return;
              done = true;
              try {
                proc.kill();
              } catch {
                /* ignore */
              }
              // proc.kill() does not guarantee immediate exit — wait for the
              // real close event before releasing the gate.
            };
            // Only release the gate on actual process exit/error so the
            // mutex is held for the full lifetime of this refresh-capable
            // spawn.
            proc.on("close", () => {
              done = true;
              resolve();
            });
            proc.on("error", () => {
              done = true;
              resolve();
            });
            proc.stdout?.on("data", finish);
            setTimeout(finish, 10000);
          } catch {
            resolve();
          }
        }),
    );
  }

  isWarm(): boolean {
    return Date.now() - this.warmedAt < WARMUP_INTERVAL_MS;
  }

  getStatus(): {
    warmedAt: string | null;
    isWarm: boolean;
    poolSize: number;
    warming: boolean;
  } {
    return {
      warmedAt: this.warmedAt ? new Date(this.warmedAt).toISOString() : null,
      isWarm: this.isWarm(),
      poolSize: POOL_SIZE,
      warming: this.warming,
    };
  }
}

export const subprocessPool = new SubprocessPool();

subprocessPool
  .warm()
  .catch((err) => logError("pool.warm_failed", err, { phase: "initial" }));

setInterval(() => {
  if (!subprocessPool.isWarm()) {
    subprocessPool
      .warm()
      .catch((err) => logError("pool.warm_failed", err, { phase: "interval" }));
  }
}, WARMUP_INTERVAL_MS);
