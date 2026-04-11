export type SameConversationPolicy = "latest-wins" | "queue";
export declare function parseSameConversationPolicy(value: string | undefined): SameConversationPolicy;
export interface ProxyRuntimeConfig {
    sameConversationPolicy: SameConversationPolicy;
    debugQueues: boolean;
}
export declare function readRuntimeConfig(env?: NodeJS.ProcessEnv): ProxyRuntimeConfig;
export declare const runtimeConfig: ProxyRuntimeConfig;
//# sourceMappingURL=config.d.ts.map