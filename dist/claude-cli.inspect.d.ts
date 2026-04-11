import type { ClaudeCliMessage, ClaudeCliResult } from "./types/claude-cli.js";
export interface ClaudeCommandResult {
    stdout: string;
    stderr: string;
    code: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
}
export interface ClaudeAuthStatus {
    loggedIn: boolean;
    authMethod?: string;
    apiProvider?: string;
}
export interface ClaudeProxyError {
    status: number;
    type: string;
    code: string | null;
    message: string;
    rawType?: string;
}
export interface ModelProbeResult {
    ok: boolean;
    model: string;
    resolvedModel?: string;
    error?: ClaudeProxyError;
}
export declare function getCleanClaudeEnv(): NodeJS.ProcessEnv;
export declare function parseClaudeJsonOutput(raw: string): ClaudeCliMessage[];
export declare function parseAuthStatus(raw: string): ClaudeAuthStatus | null;
export declare function classifyClaudeError(message: string, rawType?: string): ClaudeProxyError;
export declare function extractClaudeErrorFromMessages(messages: ClaudeCliMessage[]): ClaudeProxyError | null;
export declare function extractClaudeErrorFromResult(result: ClaudeCliResult, assistantText?: string, assistantError?: string): ClaudeProxyError | null;
export declare function runClaudeCommand(args: string[], timeoutMs?: number): Promise<ClaudeCommandResult>;
export declare function verifyClaude(): Promise<{
    ok: boolean;
    error?: string;
    version?: string;
}>;
export declare function verifyAuth(): Promise<{
    ok: boolean;
    error?: string;
    status?: ClaudeAuthStatus;
}>;
export declare function probeModelAvailability(model: string): Promise<ModelProbeResult>;
//# sourceMappingURL=claude-cli.inspect.d.ts.map