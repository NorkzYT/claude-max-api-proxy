/**
 * Converts OpenAI chat request format to Claude CLI input
 */
import type { OpenAIChatRequest, OpenAIChatMessage } from "../types/openai.js";
export type ClaudeModel = string;
export interface CliInput {
    prompt: string;
    model: ClaudeModel;
    sessionId?: string;
    systemPrompt?: string;
    isResume?: boolean;
    thinkingBudget?: number;
    _conversationId?: string;
    _startTime?: number;
}
/**
 * Extract system messages and non-system messages separately.
 */
export declare function extractSystemAndPrompt(messages: OpenAIChatMessage[]): {
    systemPrompt: string | undefined;
    prompt: string;
};
/**
 * Extract only the last user message for resume mode.
 */
export declare function extractLastUserMessage(messages: OpenAIChatMessage[]): string;
/**
 * Convert OpenAI chat request to CLI input format
 */
export declare function openaiToCli(request: OpenAIChatRequest, isResume?: boolean, cliModel?: ClaudeModel): CliInput;
//# sourceMappingURL=openai-to-cli.d.ts.map