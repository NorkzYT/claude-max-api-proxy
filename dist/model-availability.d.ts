import { type ClaudeAuthStatus, type ClaudeProxyError } from "./claude-cli.inspect.js";
import { type ModelDefinition } from "./models.js";
export interface ModelAvailabilitySnapshot {
    checkedAt: number;
    auth: ClaudeAuthStatus | null;
    available: ModelDefinition[];
    unavailable: Array<{
        definition: ModelDefinition;
        error: ClaudeProxyError;
    }>;
}
declare class ModelAvailabilityManager {
    private snapshot;
    private refreshPromise;
    getCachedSnapshot(): ModelAvailabilitySnapshot | null;
    invalidate(): void;
    getSnapshot(force?: boolean): Promise<ModelAvailabilitySnapshot>;
    getPublicModelList(): Promise<Array<{
        id: string;
        object: string;
        owned_by: string;
        created: number;
    }>>;
    resolveRequestedModel(requestedModel?: string): Promise<ModelDefinition | null>;
    private refresh;
}
export declare const modelAvailability: ModelAvailabilityManager;
export {};
//# sourceMappingURL=model-availability.d.ts.map