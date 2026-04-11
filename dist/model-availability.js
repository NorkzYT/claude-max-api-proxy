import { probeModelAvailability, verifyAuth } from "./claude-cli.inspect.js";
import { getModelDefinitions, getModelList, resolveModelFamily } from "./models.js";
const PROBE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_FAMILY_ORDER = ["sonnet", "opus", "haiku"];
function pickDefaultModel(available) {
    for (const family of DEFAULT_FAMILY_ORDER) {
        const match = available.find((definition) => definition.family === family);
        if (match)
            return match;
    }
    return available[0] ?? null;
}
class ModelAvailabilityManager {
    snapshot = null;
    refreshPromise = null;
    getCachedSnapshot() {
        return this.snapshot;
    }
    invalidate() {
        this.snapshot = null;
    }
    async getSnapshot(force = false) {
        const isFresh = this.snapshot && (Date.now() - this.snapshot.checkedAt) < PROBE_TTL_MS;
        if (!force && isFresh) {
            return this.snapshot;
        }
        if (this.refreshPromise) {
            return this.refreshPromise;
        }
        this.refreshPromise = this.refresh();
        try {
            this.snapshot = await this.refreshPromise;
            return this.snapshot;
        }
        finally {
            this.refreshPromise = null;
        }
    }
    async getPublicModelList() {
        const snapshot = await this.getSnapshot();
        return getModelList(snapshot.available);
    }
    async resolveRequestedModel(requestedModel) {
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
        const exact = snapshot.available.find((definition) => definition.id === normalized);
        if (exact)
            return exact;
        const family = resolveModelFamily(normalized);
        if (!family) {
            return null;
        }
        return snapshot.available.find((definition) => definition.family === family) ?? null;
    }
    async refresh() {
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
        const probes = await Promise.all(definitions.map(async (definition) => ({
            definition,
            result: await probeModelAvailability(definition.id),
        })));
        const available = [];
        const unavailable = [];
        for (const probe of probes) {
            if (probe.result.ok) {
                available.push(probe.definition);
            }
            else {
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
//# sourceMappingURL=model-availability.js.map