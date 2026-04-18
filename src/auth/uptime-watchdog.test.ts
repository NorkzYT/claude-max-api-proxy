import test from "node:test";
import assert from "node:assert/strict";
import { resolveMaxUptimeMs, scheduleSelfRestart } from "./uptime-watchdog.js";

test("resolveMaxUptimeMs: returns null when env var is unset / empty / 0 / negative", () => {
  assert.equal(resolveMaxUptimeMs({}), null);
  assert.equal(resolveMaxUptimeMs({ CLAUDE_PROXY_MAX_UPTIME_HOURS: "" }), null);
  assert.equal(
    resolveMaxUptimeMs({ CLAUDE_PROXY_MAX_UPTIME_HOURS: "0" }),
    null,
  );
  assert.equal(
    resolveMaxUptimeMs({ CLAUDE_PROXY_MAX_UPTIME_HOURS: "-1" }),
    null,
  );
  assert.equal(
    resolveMaxUptimeMs({ CLAUDE_PROXY_MAX_UPTIME_HOURS: "not-a-number" }),
    null,
  );
});

test("resolveMaxUptimeMs: scales hours to milliseconds", () => {
  assert.equal(
    resolveMaxUptimeMs({ CLAUDE_PROXY_MAX_UPTIME_HOURS: "4" }),
    4 * 60 * 60 * 1000,
  );
  assert.equal(
    resolveMaxUptimeMs({ CLAUDE_PROXY_MAX_UPTIME_HOURS: "0.5" }),
    30 * 60 * 1000,
  );
});

test("scheduleSelfRestart: no-op when maxMs is null/<=0", () => {
  const calls: Array<{ fn: () => void; ms: number }> = [];
  const schedule = (fn: () => void, ms: number): NodeJS.Timeout => {
    calls.push({ fn, ms });
    return setTimeout(() => {}, 0) as NodeJS.Timeout;
  };
  const h1 = scheduleSelfRestart({ maxMs: null, schedule });
  const h2 = scheduleSelfRestart({ maxMs: 0, schedule });
  const h3 = scheduleSelfRestart({ maxMs: -1, schedule });
  assert.equal(h1, null);
  assert.equal(h2, null);
  assert.equal(h3, null);
  assert.equal(calls.length, 0);
});

test("scheduleSelfRestart: schedules within ±10% of target and exits with 0", async () => {
  const maxMs = 600_000; // 10 min, comfortably above the 60s floor
  let scheduled = 0;
  const schedule = (fn: () => void, ms: number): NodeJS.Timeout => {
    scheduled = ms;
    // Fire synchronously so we can assert the exit path.
    Promise.resolve().then(fn);
    return setTimeout(() => {}, 0) as NodeJS.Timeout;
  };
  let exited: number | null = null;
  const exit = (code: number): void => {
    exited = code;
  };
  scheduleSelfRestart({
    maxMs,
    schedule,
    exit,
    random: () => 0.5, // zero jitter
  });

  assert.equal(scheduled, maxMs);
  // Give the fn() scheduled inside the watchdog — plus the 100ms flush
  // setTimeout — a chance to run.
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(exited, 0);
});

test("scheduleSelfRestart: jitter stays within ±10% band", () => {
  const maxMs = 600_000; // 10 min, comfortably above the 60s floor
  const attempts = [0, 0.25, 0.5, 0.75, 1];
  for (const r of attempts) {
    let scheduled = 0;
    const schedule = (_fn: () => void, ms: number): NodeJS.Timeout => {
      scheduled = ms;
      return setTimeout(() => {}, 0) as NodeJS.Timeout;
    };
    scheduleSelfRestart({
      maxMs,
      schedule,
      exit: () => {},
      random: () => r,
    });
    assert.ok(
      scheduled >= maxMs * 0.9 && scheduled <= maxMs * 1.1,
      `scheduled ${scheduled} outside ±10% of ${maxMs} for random ${r}`,
    );
  }
});
