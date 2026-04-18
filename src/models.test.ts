import test from "node:test";
import assert from "node:assert/strict";
import { getModelList, resolveModelFamily } from "./models.js";

test("resolveModelFamily handles provider-prefixed model ids", () => {
  assert.equal(resolveModelFamily("claude-code-cli/claude-haiku-4"), "haiku");
  assert.equal(resolveModelFamily("maxproxy/claude-opus-4"), "opus");
  assert.equal(
    resolveModelFamily("claude-max-api-proxy/claude-sonnet-4-6"),
    "sonnet",
  );
});

test("getModelList can render a filtered model list", () => {
  const models = getModelList([{ id: "claude-sonnet-4", family: "sonnet", alias: "sonnet", timeoutMs: 1, stallTimeoutMs: 1 }]);
  assert.deepEqual(models.map((model) => model.id), ["claude-sonnet-4"]);
});
