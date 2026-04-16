/**
 * Auth retry helpers — shared by streaming and non-streaming chat handlers.
 *
 * Extracted into its own module so unit tests can import the helpers
 * without pulling in the full routes.ts graph (subprocess pool, session
 * manager, SQLite store) and its module-level `setInterval`s.
 */
import type { ClaudeProxyError } from "../claude-cli.inspect.js";

/**
 * True when an upstream Claude CLI failure looks like a revoked / expired
 * OAuth token. Matches the ClaudeProxyError code AND does a belt-and-braces
 * substring check on the raw message (Anthropic returns a very specific
 * string when a token has been invalidated server-side).
 */
export function isAuthError(error: ClaudeProxyError): boolean {
  if (error.code === "auth_required") return true;
  const msg = error.message || "";
  if (error.status === 401) return true;
  if (/Invalid authentication credentials/i.test(msg)) return true;
  if (/status:\s*401/i.test(msg)) return true;
  return false;
}

export interface AuthRetryShape {
  authErrored?: boolean;
  success?: boolean;
  cancelled?: boolean;
}

/**
 * Run `run(allowAuthRetry=true)` once. If the result reports an upstream
 * auth failure, invoke `onAuthFailure` (to invalidate caches) and re-run
 * exactly once with `allowAuthRetry=false`. Pure orchestration — the caller
 * owns the actual subprocess invocation and response-write side effects.
 *
 * Fires at most one retry per invocation. Does NOT loop.
 */
export async function withAuthRetry<R extends AuthRetryShape>(
  run: (allowAuthRetry: boolean) => Promise<R>,
  onAuthFailure: () => void,
): Promise<R> {
  const first = await run(true);
  if (!first.authErrored) return first;
  onAuthFailure();
  return run(false);
}
