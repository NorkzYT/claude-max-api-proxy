import test from "node:test";
import assert from "node:assert/strict";
import { isAuthError, withAuthRetry } from "./auth-retry.js";

test("isAuthError: matches auth_required code", () => {
  assert.equal(
    isAuthError({
      status: 401,
      type: "authentication_error",
      code: "auth_required",
      message: "Claude CLI is not authenticated",
    }),
    true,
  );
});

test("isAuthError: matches Anthropic 'Invalid authentication credentials'", () => {
  assert.equal(
    isAuthError({
      status: 502,
      type: "server_error",
      code: "claude_cli_error",
      message:
        'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
    }),
    true,
  );
});

test("isAuthError: matches raw 'status: 401'", () => {
  assert.equal(
    isAuthError({
      status: 502,
      type: "server_error",
      code: "claude_cli_error",
      message: "Something bad happened (status: 401)",
    }),
    true,
  );
});

test("isAuthError: returns false for unrelated errors", () => {
  assert.equal(
    isAuthError({
      status: 429,
      type: "rate_limit_error",
      code: "rate_limited",
      message: "Too many requests",
    }),
    false,
  );
  assert.equal(
    isAuthError({
      status: 400,
      type: "invalid_request_error",
      code: "model_unavailable",
      message: "There's an issue with the selected model",
    }),
    false,
  );
});

test("withAuthRetry: no retry when first attempt succeeds", async () => {
  const calls: boolean[] = [];
  let invalidated = 0;
  const result = await withAuthRetry(
    async (allowAuthRetry) => {
      calls.push(allowAuthRetry);
      return { success: true };
    },
    () => {
      invalidated++;
    },
  );
  assert.deepEqual(calls, [true]);
  assert.equal(invalidated, 0);
  assert.deepEqual(result, { success: true });
});

test("withAuthRetry: no retry when first attempt non-auth-failed", async () => {
  const calls: boolean[] = [];
  let invalidated = 0;
  const result = await withAuthRetry(
    async (allowAuthRetry) => {
      calls.push(allowAuthRetry);
      return { success: false };
    },
    () => {
      invalidated++;
    },
  );
  assert.deepEqual(calls, [true]);
  assert.equal(invalidated, 0);
  assert.deepEqual(result, { success: false });
});

test("withAuthRetry: invalidates cache and retries exactly once on auth failure", async () => {
  const calls: boolean[] = [];
  let invalidated = 0;
  const result = await withAuthRetry(
    async (allowAuthRetry) => {
      calls.push(allowAuthRetry);
      // First call: auth error. Second call: success.
      if (calls.length === 1) {
        return { authErrored: true, success: false };
      }
      return { success: true };
    },
    () => {
      invalidated++;
    },
  );
  // Exactly one retry → two calls total.
  assert.deepEqual(calls, [true, false]);
  // invalidate() called exactly once, before the retry.
  assert.equal(invalidated, 1);
  assert.deepEqual(result, { success: true });
});

test("withAuthRetry: does not loop — if retry also auth-fails, still returns after 2 calls", async () => {
  const calls: boolean[] = [];
  let invalidated = 0;
  const result = await withAuthRetry(
    async (allowAuthRetry) => {
      calls.push(allowAuthRetry);
      return { authErrored: true, success: false };
    },
    () => {
      invalidated++;
    },
  );
  // First call gets authErrored: true (because allowAuthRetry=true). Second
  // call's runner will also report authErrored=true here BUT it's ignored
  // — we stop after one retry regardless.
  assert.equal(calls.length, 2);
  assert.equal(calls[0], true);
  assert.equal(calls[1], false);
  assert.equal(invalidated, 1);
  // Shape is what the second run returned (orchestration is agnostic).
  assert.equal(result.authErrored, true);
});
