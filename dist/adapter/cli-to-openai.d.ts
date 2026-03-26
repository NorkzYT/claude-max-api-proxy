import type { ClaudeCliAssistant, ClaudeCliResult } from "../types/claude-cli.js";
import type { OpenAIChatResponse, OpenAIChatChunk } from "../types/openai.js";
/**
 * Rough token estimate: ~1 token per 4 characters for English text.
 * Phase 5c: Used for streaming token estimates and validation.
 */
export declare function estimateTokens(text: string): number;
/**
 * Extract text content from Claude CLI assistant message
 */
export declare function extractTextContent(message: ClaudeCliAssistant): string;
/**
 * Convert Claude CLI assistant message to OpenAI streaming chunk
 */
export declare function cliToOpenaiChunk(message: ClaudeCliAssistant, requestId: string, isFirst?: boolean): OpenAIChatChunk;
/**
 * Create a final "done" chunk for streaming
 * Phase 5c: Extended to support optional usage data in done chunk
 */
export interface OpenAIChatChunkWithUsage extends OpenAIChatChunk {
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}
export declare function createDoneChunk(requestId: string, model: string): OpenAIChatChunkWithUsage;
/**
 * Validate token counts against actual content.
 * Phase 5c: Ensures token counts are reasonable (at least some tokens if content exists).
 */
export declare function validateTokens(promptTokens: number, completionTokens: number, contentLength: number): {
    valid: boolean;
    reason?: string;
};
/**
 * Convert Claude CLI result to OpenAI non-streaming response
 */
export declare function cliResultToOpenai(result: ClaudeCliResult, requestId: string): OpenAIChatResponse;
//# sourceMappingURL=cli-to-openai.d.ts.map