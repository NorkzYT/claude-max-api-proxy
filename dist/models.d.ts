/**
 * Central model registry
 *
 * Single source of truth for supported models, CLI aliases, timeouts,
 * and the /v1/models endpoint. Add new models here — everything else
 * derives from this list.
 */
export type ModelFamily = "opus" | "sonnet" | "haiku";
export interface ModelDefinition {
    id: string;
    family: ModelFamily;
    alias: string;
    timeoutMs: number;
    /** Activity-based stall timeout — resets on each content_delta */
    stallTimeoutMs: number;
}
/**
 * Resolve a model string to its CLI alias.
 * Returns null if the model is not recognized.
 */
export declare function resolveModel(model: string): string | null;
/**
 * Resolve a request model string to its model family.
 */
export declare function resolveModelFamily(model: string): ModelFamily | null;
/**
 * Get timeout for a model string.
 * Falls back to 180s for unknown models.
 */
export declare function getModelTimeout(model: string): number;
/**
 * Get stall (activity) timeout for a model string.
 * Falls back to 60s for unknown models.
 */
export declare function getStallTimeout(model: string): number;
/**
 * Check if a model string is recognized.
 */
export declare function isValidModel(model: string): boolean;
/**
 * Normalize a CLI-reported model name to a canonical OpenAI-compatible ID.
 */
export declare function normalizeModelName(model: string): string;
/**
 * Get the OpenAI-compatible /v1/models response data.
 */
export declare function getModelList(definitions?: ModelDefinition[]): Array<{
    id: string;
    object: string;
    owned_by: string;
    created: number;
}>;
export declare function getModelDefinitions(): ModelDefinition[];
export declare function getCanonicalModelId(family: ModelFamily): string;
//# sourceMappingURL=models.d.ts.map