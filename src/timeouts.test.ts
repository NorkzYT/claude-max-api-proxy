import test from "node:test";
import assert from "node:assert/strict";
import {
  readTimeoutPolicy,
  resolveHardTimeout,
  resolveServerTimeouts,
  resolveStallTimeout,
  type TimeoutPolicy,
} from "./timeouts.js";

function policy(overrides: Partial<TimeoutPolicy> = {}): TimeoutPolicy {
  return {
    reasoningMultiplier: 3,
    minHardMs: 1_800_000,
    minStallMs: 900_000,
    server: {
      requestTimeoutMs: 0,
      headersTimeoutMs: 65_000,
      keepAliveTimeoutMs: 75_000,
    },
    ...overrides,
  };
}

test("stall timeout floors every model to the 15-min default window", () => {
  const p = policy();
  // opus base 120000 x3 = 360000, still floored up to the 900000 minimum.
  assert.equal(resolveStallTimeout("opus", true, p), 900_000);
  // sonnet base 90000 x3 = 270000, floored up to 900000.
  assert.equal(resolveStallTimeout("sonnet", true, p), 900_000);
  // no reasoning: base alone is well under the floor.
  assert.equal(resolveStallTimeout("opus", false, p), 900_000);
});

test("a higher min-stall floor raises the window without code changes", () => {
  const p = policy({ minStallMs: 1_200_000 }); // 20 min
  assert.equal(resolveStallTimeout("sonnet", true, p), 1_200_000);
});

test("an absolute stall override bypasses the per-model base and multiplier", () => {
  const p = policy({ stallOverrideMs: 600_000, minStallMs: 300_000 });
  assert.equal(resolveStallTimeout("opus", true, p), 600_000);
  assert.equal(resolveStallTimeout("opus", false, p), 600_000);
});

test("hard timeout is always greater than the resolved stall window", () => {
  const p = policy();
  const stall = resolveStallTimeout("sonnet", true, p);
  const hard = resolveHardTimeout("sonnet", true, p);
  assert.ok(hard > stall, `expected hard ${hard} > stall ${stall}`);
  // opus base 1800000 x3 = 5400000 dominates the 30-min floor.
  assert.equal(resolveHardTimeout("opus", true, p), 5_400_000);
});

test("hard override is respected but never drops below the stall window", () => {
  const p = policy({ hardOverrideMs: 100_000, minHardMs: 100_000 });
  const hard = resolveHardTimeout("opus", true, p);
  const stall = resolveStallTimeout("opus", true, p);
  assert.ok(hard >= stall + 60_000);
});

test("server timeouts default to a disabled requestTimeout", () => {
  const s = resolveServerTimeouts(policy());
  assert.equal(s.requestTimeoutMs, 0);
  assert.equal(s.headersTimeoutMs, 65_000);
  assert.equal(s.keepAliveTimeoutMs, 75_000);
});

test("headersTimeout is clamped when requestTimeout is enabled and smaller", () => {
  const s = resolveServerTimeouts(
    policy({
      server: {
        requestTimeoutMs: 30_000,
        headersTimeoutMs: 65_000,
        keepAliveTimeoutMs: 75_000,
      },
    }),
  );
  assert.equal(s.headersTimeoutMs, 30_000);
});

test("readTimeoutPolicy parses env overrides and ignores invalid values", () => {
  const p = readTimeoutPolicy({
    CLAUDE_PROXY_MIN_STALL_TIMEOUT_MS: "600000",
    CLAUDE_PROXY_REASONING_TIMEOUT_MULTIPLIER: "2",
    CLAUDE_PROXY_HARD_TIMEOUT_MS: "not-a-number",
    CLAUDE_PROXY_SERVER_REQUEST_TIMEOUT_MS: "0",
  } as NodeJS.ProcessEnv);
  assert.equal(p.minStallMs, 600_000);
  assert.equal(p.reasoningMultiplier, 2);
  assert.equal(p.hardOverrideMs, undefined);
  assert.equal(p.server.requestTimeoutMs, 0);
});
