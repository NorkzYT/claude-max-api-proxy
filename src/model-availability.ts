import {
  probeModelAvailability,
  verifyAuth,
  type ClaudeAuthStatus,
  type ClaudeProxyError,
} from "./claude-cli.inspect.js";
import {
  getModelDefinitions,
  getModelList,
  resolveModelFamily,
  type ModelDefinition,
  type ModelFamily,
} from "./models.js";

const PROBE_TTL_MS = 10 * 60 * 1000;
// When verifyAuth fails, normally the PROBE_TTL_MS cache would hold the
// "no models available" state for 10 minutes even though a fresh token
// refresh might succeed. To avoid sticking requests behind that cache, we
// force a refresh attempt at most once every AUTH_RETRY_COOLDOWN_MS when an
// auth failure has been observed.
const AUTH_RETRY_COOLDOWN_MS = 60 * 1000;
const DEFAULT_FAMILY_ORDER: ModelFamily[] = ["sonnet", "opus", "haiku"];

export interface ModelAvailabilitySnapshot {
  checkedAt: number;
  auth: ClaudeAuthStatus | null;
  available: ModelDefinition[];
  unavailable: Array<{
    definition: ModelDefinition;
    error: ClaudeProxyError;
  }>;
}

function pickDefaultModel(
  available: ModelDefinition[],
): ModelDefinition | null {
  for (const family of DEFAULT_FAMILY_ORDER) {
    const match = available.find((definition) => definition.family === family);
    if (match) return match;
  }
  return available[0] ?? null;
}

class ModelAvailabilityManager {
  private snapshot: ModelAvailabilitySnapshot | null = null;
  private refreshPromise: Promise<ModelAvailabilitySnapshot> | null = null;
  private lastAuthRetryAt = 0;

  getCachedSnapshot(): ModelAvailabilitySnapshot | null {
    return this.snapshot;
  }

  invalidate(): void {
    this.snapshot = null;
  }

  /**
   * When the last snapshot shows the CLI as unauthenticated, the generic
   * PROBE_TTL_MS (10 min) cache keeps returning "no models" even after a
   * successful token refresh. Bypass the cache at most once per
   * AUTH_RETRY_COOLDOWN_MS so a healed token is picked up quickly without
   * hammering verifyAuth on every request.
   */
  private shouldForceAuthRetry(): boolean {
    if (!this.snapshot) return false;
    if (this.snapshot.auth?.loggedIn) return false;
    return Date.now() - this.lastAuthRetryAt >= AUTH_RETRY_COOLDOWN_MS;
  }

  async getSnapshot(force = false): Promise<ModelAvailabilitySnapshot> {
    const isFresh =
      this.snapshot && Date.now() - this.snapshot.checkedAt < PROBE_TTL_MS;
    const authRetry = this.shouldForceAuthRetry();
    if (authRetry) {
      this.lastAuthRetryAt = Date.now();
    }
    if (!force && !authRetry && isFresh) {
      return this.snapshot!;
    }

    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.refresh();
    try {
      this.snapshot = await this.refreshPromise;
      return this.snapshot;
    } finally {
      this.refreshPromise = null;
    }
  }

  async getPublicModelList(): Promise<
    Array<{ id: string; object: string; owned_by: string; created: number }>
  > {
    const snapshot = await this.getSnapshot();
    return getModelList(snapshot.available);
  }

  async resolveRequestedModel(
    requestedModel?: string,
  ): Promise<ModelDefinition | null> {
    const snapshot = await this.getSnapshot();
    if (snapshot.available.length === 0) {
      return null;
    }

    if (!requestedModel) {
      return pickDefaultModel(snapshot.available);
    }

    const normalized = requestedModel.startsWith("maxproxy/")
      ? requestedModel.slice("maxproxy/".length)
      : requestedModel.startsWith("claude-code-cli/")
        ? requestedModel.slice("claude-code-cli/".length)
        : requestedModel;

    const exact = snapshot.available.find(
      (definition) => definition.id === normalized,
    );
    if (exact) return exact;

    const family = resolveModelFamily(normalized);
    if (!family) {
      return null;
    }

    return (
      snapshot.available.find((definition) => definition.family === family) ??
      null
    );
  }

  private async refresh(): Promise<ModelAvailabilitySnapshot> {
    const authResult = await verifyAuth();
    const definitions = getModelDefinitions();

    if (!authResult.ok) {
      return {
        checkedAt: Date.now(),
        auth: authResult.status ?? null,
        available: [],
        unavailable: definitions.map((definition) => ({
          definition,
          error: {
            status: 401,
            type: "authentication_error",
            code: "auth_required",
            message: authResult.error || "Claude CLI is not authenticated",
          },
        })),
      };
    }

    const probes = await Promise.all(
      definitions.map(async (definition) => ({
        definition,
        result: await probeModelAvailability(definition.id),
      })),
    );

    const available: ModelDefinition[] = [];
    const unavailable: ModelAvailabilitySnapshot["unavailable"] = [];

    for (const probe of probes) {
      if (probe.result.ok) {
        available.push(probe.definition);
      } else {
        unavailable.push({
          definition: probe.definition,
          error: probe.result.error || {
            status: 502,
            type: "server_error",
            code: "claude_cli_error",
            message: `Claude CLI could not use model '${probe.definition.id}'`,
          },
        });
      }
    }

    return {
      checkedAt: Date.now(),
      auth: authResult.status ?? null,
      available,
      unavailable,
    };
  }
}

export const modelAvailability = new ModelAvailabilityManager();
