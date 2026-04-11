import test from "node:test";
import assert from "node:assert/strict";
import { parseSameConversationPolicy, readRuntimeConfig } from "./config.js";
test("parseSameConversationPolicy defaults to latest-wins", () => {
    assert.equal(parseSameConversationPolicy(undefined), "latest-wins");
    assert.equal(parseSameConversationPolicy("invalid"), "latest-wins");
});
test("parseSameConversationPolicy accepts queue", () => {
    assert.equal(parseSameConversationPolicy("queue"), "queue");
});
test("readRuntimeConfig parses booleans", () => {
    const config = readRuntimeConfig({
        CLAUDE_PROXY_SAME_CONVERSATION_POLICY: "queue",
        CLAUDE_PROXY_DEBUG_QUEUES: "true",
    });
    assert.deepEqual(config, {
        sameConversationPolicy: "queue",
        debugQueues: true,
    });
});
//# sourceMappingURL=config.test.js.map