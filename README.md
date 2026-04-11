# Claude Max API Proxy

Use a locally authenticated Claude Code CLI session as an OpenAI-compatible API server.

This project runs a local HTTP server that translates OpenAI-style `/v1/chat/completions` requests into Claude Code CLI subprocess calls. It is intended for tools such as OpenClaw, Continue.dev, scripts, and other OpenAI-compatible clients that you want to point at your own Claude CLI login instead of a separate API billing path.

## What This Project Does

- Exposes an OpenAI-compatible API at `http://127.0.0.1:3456/v1`
- Uses your existing `claude` CLI authentication on that machine
- Supports streaming and non-streaming chat completions
- Preserves conversation continuity when the client sends a stable `user` value
- Detects which Claude models are actually available to the current CLI account
- Applies queueing and cancellation rules per conversation to avoid indefinite hangs

## What Another Service Needs To Know

If you hand this repository to another service, agent, or installer, these are the important operational facts:

- This server depends on a working local `claude` CLI installation, not direct Anthropic API keys.
- The machine must already be authenticated with `claude auth login`.
- The authoritative source of available models is `GET /v1/models`.
- `/v1/models` is dynamic. It is not a fixed hard-coded promise that every listed model will work on every machine.
- If `GET /v1/models` returns `{"object":"list","data":[]}`, the proxy may be installed correctly, but the Claude CLI account on that machine does not currently have access to any configured models.
- Requests for the same conversation are coordinated by the `user` field. If the client wants multi-turn continuity, it must reuse the same `user` value.
- The default same-conversation policy is `latest-wins`. A new request for the same conversation cancels the older in-flight request and drops stale queued requests for that conversation.
- If a streaming client disconnects, the underlying Claude subprocess is killed immediately so the queue can unblock.
- The standalone server binds to `127.0.0.1` by default. It is intended for local use unless you deliberately place it behind your own reverse proxy or change the bind behavior in code.

## Requirements

- Node.js 22+ recommended for fresh installs
- npm
- Claude Code CLI installed globally
- A Claude account authenticated in the CLI on that machine
- Access to at least one supported Claude model through that CLI login

Install the CLI if needed:

```bash
npm install -g @anthropic-ai/claude-code
```

Authenticate if needed:

```bash
claude auth login
```

Verify authentication:

```bash
claude auth status
```

Verify the CLI binary exists:

```bash
claude --version
```

## Fast Install

```bash
git clone https://github.com/mattschwen/claude-max-api-proxy.git
cd claude-max-api-proxy
npm install
npm run build
npm test
npm start
```

Then validate in a second terminal:

```bash
curl http://127.0.0.1:3456/health
curl http://127.0.0.1:3456/v1/models
```

If `/v1/models` returns an empty `data` array, stop there and fix Claude CLI auth or account model access before connecting another client.

## Full Install Procedure

### 1. Install prerequisites

```bash
node --version
npm --version
claude --version
```

### 2. Verify Claude CLI authentication

```bash
claude auth status
```

If it is not logged in:

```bash
claude auth login
```

### 3. Clone the repository

```bash
git clone https://github.com/mattschwen/claude-max-api-proxy.git
cd claude-max-api-proxy
```

### 4. Install dependencies

```bash
npm install
```

### 5. Build the project

```bash
npm run build
```

### 6. Run tests

Tests run from the compiled `dist/` output:

```bash
npm test
```

### 7. Start the server

```bash
npm start
```

The standalone server will:

- verify the `claude` binary
- run `claude auth status`
- probe model availability
- print the active same-conversation policy
- warn if no accessible models were detected

You can also choose a custom port:

```bash
node dist/server/standalone.js 8080
```

### 8. Verify the health endpoint

```bash
curl http://127.0.0.1:3456/health
```

Important fields in the response:

- `status`
- `config.sameConversationPolicy`
- `config.debugQueues`
- `auth`
- `models.available`
- `models.unavailable`
- `queues`
- `subprocesses`
- `sessions`

Example:

```json
{
  "status": "ok",
  "provider": "claude-code-cli",
  "config": {
    "sameConversationPolicy": "latest-wins",
    "debugQueues": false
  },
  "auth": {
    "loggedIn": true
  },
  "models": {
    "available": ["claude-sonnet-4-6", "claude-opus-4-6"],
    "unavailable": []
  }
}
```

### 9. Verify model availability

```bash
curl http://127.0.0.1:3456/v1/models
```

Expected shape:

```json
{
  "object": "list",
  "data": [
    {
      "id": "claude-sonnet-4-6",
      "object": "model",
      "owned_by": "anthropic",
      "created": 1710000000
    }
  ]
}
```

If the `data` array is empty, do not connect another service yet. The proxy is running, but this machine cannot currently use any configured Claude models through the CLI.

### 10. Send a non-streaming test request

```bash
curl -X POST http://127.0.0.1:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4",
    "messages": [
      { "role": "user", "content": "Reply with exactly: hello" }
    ]
  }'
```

### 11. Send a streaming test request

```bash
curl -N -X POST http://127.0.0.1:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4",
    "stream": true,
    "messages": [
      { "role": "user", "content": "Count from 1 to 5 slowly" }
    ]
  }'
```

## Connecting Another Service

### Generic OpenAI-compatible settings

Use these defaults for any OpenAI-compatible client:

| Setting | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:3456/v1` |
| API key | Any non-empty string |
| Chat endpoint | `/chat/completions` |
| Models | Whatever `GET /v1/models` returns |

Notes:

- The proxy ignores the API key, but many clients require one to be present.
- Use a model that is actually returned by `/v1/models`.
- Reuse a stable `user` value per chat thread if the client allows it.

### OpenClaw

Point OpenClaw at:

- Base URL: `http://127.0.0.1:3456/v1`
- API key: any placeholder string
- Model: one returned by `/v1/models`

Behavior that matters for OpenClaw:

- If OpenClaw sends another message for the same conversation while the first is still running, the default `latest-wins` policy cancels the older request.
- If you want strict per-conversation FIFO instead, set `CLAUDE_PROXY_SAME_CONVERSATION_POLICY=queue` before starting the server.
- If OpenClaw appears slow or returns nothing, check `/health`, then check whether the conversation is blocked in `queues`, whether queue debug logging is enabled, and whether the current Claude session actually has model access.

### Continue.dev example

```json
{
  "models": [
    {
      "title": "Claude via local CLI",
      "provider": "openai",
      "model": "claude-sonnet-4",
      "apiBase": "http://127.0.0.1:3456/v1",
      "apiKey": "local"
    }
  ]
}
```

### Python example

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:3456/v1",
    api_key="local"
)

response = client.chat.completions.create(
    model="claude-sonnet-4",
    messages=[
        {"role": "user", "content": "Say hello in one word."}
    ]
)

print(response.choices[0].message.content)
```

## Available Models

The code recognizes a known set of model IDs, but the public list is filtered at runtime by real CLI access checks.

Known model IDs in the codebase:

- `claude-opus-4-6`
- `claude-opus-4`
- `claude-opus-4-5`
- `claude-sonnet-4-6`
- `claude-sonnet-4`
- `claude-sonnet-4-5`
- `claude-haiku-4-5`
- `claude-haiku-4`

Accepted family aliases:

- `opus`
- `sonnet`
- `haiku`

Accepted provider-style prefixes:

- `maxproxy/...`
- `claude-code-cli/...`

Important rule:

- The set of recognized IDs in code is not the same thing as the set of usable IDs on the current machine.
- The usable list is the result of runtime probing and is exposed by `GET /v1/models`.

## Runtime Configuration

Set environment variables before starting the server.

### Same conversation policy

```bash
export CLAUDE_PROXY_SAME_CONVERSATION_POLICY=latest-wins
```

Supported values:

- `latest-wins` (default)
- `queue`

Meaning:

- `latest-wins`: a newer request for the same conversation cancels the active request and drops older queued requests for that conversation.
- `queue`: requests for the same conversation are processed in order without superseding each other.

### Queue debug logging

```bash
export CLAUDE_PROXY_DEBUG_QUEUES=true
```

Supported values:

- `true`
- `false` (default)

When enabled, the proxy emits extra structured log events for:

- `queue.enqueue`
- `queue.drop`
- `queue.blocked`
- `request.cancel`

### Example startup with explicit config

```bash
export CLAUDE_PROXY_SAME_CONVERSATION_POLICY=latest-wins
export CLAUDE_PROXY_DEBUG_QUEUES=true
npm start
```

## Request Behavior

### Conversation continuity

The proxy uses the OpenAI-style `user` field as the conversation key.

If you want follow-up turns to continue the same Claude CLI session, reuse the same `user` value:

```json
{
  "model": "claude-sonnet-4",
  "user": "chat-123",
  "messages": [
    { "role": "user", "content": "Remember this number: 17" }
  ]
}
```

Then later:

```json
{
  "model": "claude-sonnet-4",
  "user": "chat-123",
  "messages": [
    { "role": "user", "content": "What number did I ask you to remember?" }
  ]
}
```

If `user` is omitted, the proxy treats the request as a new conversation and assigns an internal request ID.

### Same-conversation cancellation policy

Default behavior is `latest-wins`.

That means:

- only one active request per conversation
- a new request for the same conversation supersedes stale work
- older queued requests for that conversation are dropped

This is the main reason a client can appear to stop the first request when a second message is sent before the first completes. That is intentional under the default policy.

### Streaming disconnect behavior

If the client closes the streaming response, the proxy kills the Claude subprocess immediately. This prevents a dead or abandoned stream from holding the conversation queue open.

## Reliability And Safety Features

### Activity-based stall detection

The proxy resets the stall timer whenever content arrives. If the subprocess stops producing output long enough, it is killed and the queue is unblocked.

Current stall timeouts:

| Family | Stall timeout |
| --- | --- |
| Opus | 120s |
| Sonnet | 90s |
| Haiku | 45s |

### Hard request timeouts

The proxy also enforces absolute wall-clock timeouts:

| Family | Hard timeout |
| --- | --- |
| Opus | 30 minutes |
| Sonnet | 10 minutes |
| Haiku | 2 minutes |

If extended thinking is enabled, these timeouts are multiplied by 3.

### Resume failure tracking

The proxy resumes Claude CLI sessions for multi-turn conversations. If resume fails twice consecutively for a conversation, the session is invalidated and a fresh one is created on the next request.

### Retry behavior

On subprocess failure, the proxy retries once with a fresh session rather than assuming resume is still safe.

### Queue depth protection

Per conversation, the proxy rejects requests when too many are already queued instead of allowing unbounded backlog growth.

### Graceful shutdown

On `SIGINT` or `SIGTERM`, the standalone server:

- stops accepting new connections
- waits briefly for active requests
- kills remaining subprocesses
- saves session state
- exits cleanly

## API Reference

### `GET /health`

Returns runtime state for operations and troubleshooting.

Includes:

- current config
- auth snapshot
- model availability snapshot
- session failure stats
- active subprocesses
- queue state
- conversation store metrics
- recent errors

### `GET /v1/models`

Returns the currently accessible models for the authenticated Claude CLI account.

Example:

```bash
curl http://127.0.0.1:3456/v1/models
```

### `POST /v1/chat/completions`

OpenAI-compatible chat endpoint.

Minimal request:

```json
{
  "model": "claude-sonnet-4",
  "messages": [
    { "role": "user", "content": "Hello" }
  ]
}
```

Streaming request:

```json
{
  "model": "claude-sonnet-4",
  "stream": true,
  "messages": [
    { "role": "user", "content": "Write a haiku about local proxies." }
  ]
}
```

Extended thinking request:

```json
{
  "model": "claude-opus-4",
  "stream": true,
  "thinking": {
    "type": "enabled",
    "budget_tokens": 10000
  },
  "messages": [
    { "role": "user", "content": "Solve this carefully." }
  ]
}
```

## Logs

The proxy emits structured JSON-style events for request lifecycle and operational behavior.

Common events include:

- `request.start`
- `request.complete`
- `request.error`
- `request.cancel`
- `queue.enqueue`
- `queue.drop`
- `queue.blocked`
- `queue.timeout`
- `subprocess.stall`
- `subprocess.kill`
- `session.created`
- `session.invalidate`
- `session.resume_fail`

Enable extra queue-related visibility with:

```bash
export CLAUDE_PROXY_DEBUG_QUEUES=true
```

## File Locations And Persistence

This project writes state into the current user's home directory:

- Session map: `~/.claude-code-cli-sessions.json`
- Conversation store: `~/.claude-proxy-conversations.db`

What they are used for:

- `~/.claude-code-cli-sessions.json`: maps conversation IDs to Claude CLI session IDs and tracks resume failure counts
- `~/.claude-proxy-conversations.db`: stores conversation metadata, message history, and request metrics

If you move this project to another machine, the repo alone is not the whole runtime state. The new machine also needs its own Claude CLI login and, if continuity matters, any persisted state you intend to carry over.

## Development

```bash
npm install
npm run build
npm test
npm start
```

## Troubleshooting

### `claude: command not found`

Install the CLI:

```bash
npm install -g @anthropic-ai/claude-code
```

Then verify:

```bash
claude --version
```

### `claude auth status` says not logged in

Authenticate:

```bash
claude auth login
```

Then re-check:

```bash
claude auth status
```

### `/v1/models` returns an empty list

This is the most important operational failure mode to understand.

It means one of these is true:

- Claude CLI is not authenticated
- the authenticated CLI account cannot access any configured models
- model probing failed and nothing usable was detected

Check:

```bash
claude auth status
curl http://127.0.0.1:3456/health
curl http://127.0.0.1:3456/v1/models
```

Look specifically at:

- `auth.loggedIn`
- `models.available`
- `models.unavailable`

### Chat requests fail with `model_unavailable`

The client is asking for a recognized model ID that this machine's CLI account cannot currently use.

Fix:

- query `GET /v1/models`
- choose one of the returned IDs
- update the client config to use that ID

### OpenClaw is slow or sometimes returns nothing

Check these in order:

1. Confirm the request model is actually listed in `/v1/models`.
2. Confirm the client is reusing a stable conversation identifier only when it really wants the same conversation.
3. Check whether a newer same-conversation request is canceling the older one under `latest-wins`.
4. Enable queue debug logs:

```bash
export CLAUDE_PROXY_DEBUG_QUEUES=true
npm start
```

5. Inspect `/health` for:

- `queues`
- `subprocesses`
- `stallDetections`
- `models.available`

### Sending a second message stops the first one

That is expected under the default policy if both messages belong to the same conversation.

Current default:

```bash
export CLAUDE_PROXY_SAME_CONVERSATION_POLICY=latest-wins
```

If you want strict FIFO behavior instead:

```bash
export CLAUDE_PROXY_SAME_CONVERSATION_POLICY=queue
```

Then restart the server.

### The port is already in use

Start on another port:

```bash
node dist/server/standalone.js 8080
```

Then use:

```text
http://127.0.0.1:8080/v1
```

### Streaming looks idle for too long

Check `/health` and logs for stall detection or queue backlog.

Important details:

- Sonnet stall timeout is 90 seconds
- Opus stall timeout is 120 seconds
- Haiku stall timeout is 45 seconds
- extended thinking increases time budgets

If the client disconnects mid-stream, the subprocess is killed immediately by design.

## Auto-Start On macOS

See [docs/macos-setup.md](docs/macos-setup.md).

## Security Notes

- This proxy is designed for local use and binds to `127.0.0.1` by default.
- It trusts the local machine's Claude CLI login.
- It does not require a real API key from the client.
- If you expose it beyond localhost, put proper network controls in front of it.
- Anyone who can reach the proxy can attempt to use your local Claude CLI session.

## Handoff Checklist For Another Service

1. Install Node.js and npm.
2. Install Claude Code CLI with `npm install -g @anthropic-ai/claude-code`.
3. Run `claude auth login` on the target machine.
4. Verify with `claude auth status`.
5. Clone this repository.
6. Run `npm install`.
7. Run `npm run build`.
8. Run `npm test`.
9. Start the server with `npm start`.
10. Verify `GET /health`.
11. Verify `GET /v1/models`.
12. Do not proceed if `/v1/models` is empty.
13. Configure the downstream client to use `http://127.0.0.1:3456/v1` and any placeholder API key.
14. Use a model that actually appears in `/v1/models`.
15. If the client depends on conversation continuity, make sure it sends a stable `user` value.
16. If same-conversation interruptions are undesirable, set `CLAUDE_PROXY_SAME_CONVERSATION_POLICY=queue` before startup.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
