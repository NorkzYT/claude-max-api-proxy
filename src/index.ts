/**
 * Claude Code CLI Provider Plugin for Clawdbot
 *
 * Enables using Claude Max subscription through Claude Code CLI,
 * bypassing OAuth token scope restrictions.
 */
import { startServer, stopServer, getServer } from "./server/index.js";
import { verifyClaude, verifyAuth } from "./subprocess/manager.js";
import { modelAvailability } from "./model-availability.js";
import type { ModelDefinition } from "./models.js";
import { runtimeConfig } from "./config.js";

const PROVIDER_ID = "claude-code-cli";
const PROVIDER_LABEL = "Claude Code CLI";
const DEFAULT_PORT = 3456;
interface ModelDef {
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

function getModelName(model: ModelDefinition): string {
  if (model.family === "opus") return "Claude Opus";
  if (model.family === "haiku") return "Claude Haiku";
  return "Claude Sonnet";
}

function buildModelDefinition(model: ModelDefinition): ModelDef {
  return {
    id: model.id,
    name: getModelName(model),
    api: "openai-completions",
    reasoning: model.family === "opus",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  };
}

function emptyPluginConfigSchema(): { type: "object"; properties: Record<string, never>; additionalProperties: boolean } {
  return {
    type: "object",
    properties: {},
    additionalProperties: false,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PluginApi = any;

const claudeCodeCliPlugin = {
  id: "claude-code-cli-provider",
  name: "Claude Code CLI Provider",
  description: "Use Claude Max subscription via Claude Code CLI (bypasses OAuth restrictions)",
  configSchema: emptyPluginConfigSchema(),

  register(api: PluginApi): void {
    let serverPort = DEFAULT_PORT;

    api.registerProvider({
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      docsPath: "/providers/claude-code-cli",
      aliases: ["claude-cli", "claude-max"],
      envVars: [],
      auth: [
        {
          id: "local",
          label: "Local Claude CLI",
          hint: "Uses your existing Claude Code CLI authentication (from Claude Max)",
          kind: "custom",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          run: async (ctx: any) => {
            const spin = ctx.prompter.progress("Checking Claude CLI...");
            try {
              const cliCheck = await verifyClaude();
              if (!cliCheck.ok) {
                spin.stop("Claude CLI not found");
                await ctx.prompter.note("Install Claude Code: npm install -g @anthropic-ai/claude-code", "Installation");
                throw new Error(cliCheck.error);
              }
              spin.message("Claude CLI found, checking auth...");

              const authCheck = await verifyAuth();
              if (!authCheck.ok) {
                spin.stop("Not authenticated");
                await ctx.prompter.note("Run 'claude auth login' to authenticate with your Claude Max account", "Authentication");
                throw new Error(authCheck.error);
              }
              spin.message("Authenticated, checking model access...");

              const availability = await modelAvailability.getSnapshot(true);
              if (availability.available.length === 0) {
                spin.stop("No accessible models");
                await ctx.prompter.note(
                  availability.unavailable[0]?.error.message || "Claude CLI reported no accessible models for this account.",
                  "Model Access"
                );
                throw new Error("Claude CLI authentication succeeded, but no configured Claude models are accessible.");
              }

              spin.message("Models available, starting server...");

              const portInput = await ctx.prompter.text({
                message: "Local server port",
                initialValue: String(DEFAULT_PORT),
                validate: (v: string) => {
                  const p = parseInt(v, 10);
                  if (isNaN(p) || p < 1 || p > 65535) {
                    return "Enter a valid port (1-65535)";
                  }
                  return undefined;
                },
              });
              serverPort = parseInt(portInput, 10);

              await startServer({ port: serverPort });
              spin.stop("Claude CLI provider ready");

              const baseUrl = `http://127.0.0.1:${serverPort}/v1`;
              const availableModels = availability.available.map(buildModelDefinition);
              const defaultModel = `${PROVIDER_ID}/${availability.available[0].id}`;
              return {
                profiles: [
                  {
                    profileId: `${PROVIDER_ID}:local`,
                    credential: {
                      type: "token",
                      provider: PROVIDER_ID,
                      token: "local",
                    },
                  },
                ],
                configPatch: {
                  models: {
                    providers: {
                      [PROVIDER_ID]: {
                        baseUrl,
                        apiKey: "local",
                        api: "openai-completions",
                        authHeader: false,
                        models: availableModels,
                      },
                    },
                  },
                  agents: {
                    defaults: {
                      models: Object.fromEntries(
                        availability.available.map((model) => [`${PROVIDER_ID}/${model.id}`, {}])
                      ),
                    },
                  },
                },
                defaultModel,
                notes: [
                  "This uses your Claude Max subscription via Claude Code CLI.",
                  "Your OAuth token is used by the CLI, not exposed directly.",
                  `Local server running at http://127.0.0.1:${serverPort}`,
                  `Available models: ${availability.available.map((model) => model.id).join(", ")}`,
                  `Same-conversation policy: ${runtimeConfig.sameConversationPolicy}`,
                  "Keep the server running to use this provider.",
                ],
              };
            } catch (err) {
              spin.stop("Setup failed");
              throw err;
            }
          },
        },
      ],
    });

    api.on("plugin:unload", async () => {
      const server = getServer();
      if (server) {
        console.log("[ClaudeCodeCLI] Stopping server on plugin unload");
        await stopServer();
      }
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    api.registerCli?.((cli: any) => {
      cli
        .command("claude-cli:start [port]")
        .description("Start the Claude CLI proxy server")
        .action(async (port: string) => {
          const p = parseInt(port || String(DEFAULT_PORT), 10);
          await startServer({ port: p });
          console.log(`Server started on port ${p}`);
        });
      cli
        .command("claude-cli:stop")
        .description("Stop the Claude CLI proxy server")
        .action(async () => {
          await stopServer();
          console.log("Server stopped");
        });
      cli
        .command("claude-cli:status")
        .description("Check Claude CLI proxy server status")
        .action(() => {
          const server = getServer();
          if (server) {
            console.log(`Server is running on port ${serverPort}`);
          } else {
            console.log("Server is not running");
          }
        });
    });

    console.log("[ClaudeCodeCLI] Plugin registered");
  },
};

export default claudeCodeCliPlugin;
export { startServer, stopServer, getServer } from "./server/index.js";
export { ClaudeSubprocess, verifyClaude, verifyAuth } from "./subprocess/manager.js";
export { sessionManager } from "./session/manager.js";
export { conversationStore } from "./store/conversation.js";
export { subprocessPool } from "./subprocess/pool.js";
