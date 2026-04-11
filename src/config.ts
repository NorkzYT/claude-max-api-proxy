export type SameConversationPolicy = "latest-wins" | "queue";

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null || value.trim() === "") return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

export function parseSameConversationPolicy(value: string | undefined): SameConversationPolicy {
  const normalized = value?.trim().toLowerCase();
  return normalized === "queue" ? "queue" : "latest-wins";
}

export interface ProxyRuntimeConfig {
  sameConversationPolicy: SameConversationPolicy;
  debugQueues: boolean;
}

export function readRuntimeConfig(env: NodeJS.ProcessEnv = process.env): ProxyRuntimeConfig {
  return {
    sameConversationPolicy: parseSameConversationPolicy(env.CLAUDE_PROXY_SAME_CONVERSATION_POLICY),
    debugQueues: parseBoolean(env.CLAUDE_PROXY_DEBUG_QUEUES, false),
  };
}

export const runtimeConfig = readRuntimeConfig();
