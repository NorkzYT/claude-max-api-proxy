# Claude Max API Proxy

**Turn your $200/month Claude Max subscription into a full OpenAI-compatible API — no extra cost.**

A lightweight local proxy that wraps the Claude Code CLI as an OpenAI-compatible API server. Any app that speaks the OpenAI format can use your Claude Max subscription directly.

---

## Why?

- You already pay for **Claude Max** ($200/month) and want to use it everywhere
- You use **OpenClaw**, **Continue.dev**, or other tools that need an API endpoint
- You want to use Claude in scripts and workflows without per-message API costs

Anthropic blocks third-party apps from using your Max subscription's OAuth tokens directly. But the Claude Code CLI *is* allowed to use them. This proxy bridges that gap.

---

## Quick Start

### Prerequisites

- **Node.js 20+** — [nodejs.org](https://nodejs.org)
- **Claude Code CLI** — installed and authenticated:
  ```bash
  npm install -g @anthropic-ai/claude-code
  claude auth login
  ```
- **Claude Max subscription** ($200/month plan from Anthropic)

### Install & Run

```bash
git clone https://github.com/mattschwen/claude-max-api-proxy.git
cd claude-max-api-proxy
npm install
npm start
```

The server starts on `http://localhost:3456`. Keep the terminal open.

### Verify

```bash
# Health check
curl http://localhost:3456/health

# Send a message
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4", "messages": [{"role": "user", "content": "Hello!"}]}'

# Streaming
curl -N -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4", "messages": [{"role": "user", "content": "Tell me a joke"}], "stream": true}'
```

---

## Connect Your Apps

Point any OpenAI-compatible app at the proxy:

| Setting | Value |
|---------|-------|
| **API Base URL** | `http://localhost:3456/v1` |
| **API Key** | Any string (the proxy ignores it) |
| **Model** | `claude-opus-4`, `claude-sonnet-4`, or `claude-haiku-4` |

### OpenClaw

Set the API endpoint in OpenClaw's settings to `http://localhost:3456/v1` with any API key.

### Continue.dev (VS Code)

```json
{
  "models": [{
    "title": "Claude (Max)",
    "provider": "openai",
    "model": "claude-sonnet-4",
    "apiBase": "http://localhost:3456/v1",
    "apiKey": "not-needed"
  }]
}
```

### Python

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3456/v1", api_key="not-needed")
response = client.chat.completions.create(
    model="claude-sonnet-4",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
```

---

## Available Models

| Model ID | Family | Best For |
|----------|--------|----------|
| `claude-opus-4-6` / `claude-opus-4` | Opus | Complex reasoning, analysis, coding |
| `claude-sonnet-4-6` / `claude-sonnet-4` | Sonnet | General use, balanced speed and capability |
| `claude-haiku-4-5` / `claude-haiku-4` | Haiku | Quick questions, simple tasks |

You can also use bare aliases: `opus`, `sonnet`, `haiku`.

---

## Reliability Features

The proxy is built for long-running, production-like use with aggressive reliability measures:

### Activity-Based Stall Detection
Each model has an activity timeout that resets on every content token. If a subprocess stops producing output, it's killed and the queue unblocks — no more 30-minute hangs.

| Model | Activity Timeout | Hard Timeout |
|-------|-----------------|-------------|
| Opus | 120s | 30min |
| Sonnet | 60s | 10min |
| Haiku | 30s | 2min |

### Kill Escalation
Stuck processes that ignore SIGTERM are escalated to SIGKILL after a 5-second grace period, preventing zombie processes.

### Per-Conversation Queue
Requests for the same conversation are serialized (FIFO). Different conversations run in parallel. Each queue slot has an absolute timeout to prevent permanent blocking.

### Session Resume with Failure Tracking
The proxy automatically resumes Claude CLI sessions for multi-turn conversations. If resume fails twice consecutively, the session is invalidated and a fresh one is created — no silent stalls.

### Retry Logic
On subprocess failure, the proxy retries once with a fresh session (no resume). Each attempt gets its own clean event handler wiring.

### Graceful Shutdown
On SIGTERM/SIGINT: stops accepting new connections, waits up to 30s for in-flight requests, kills remaining subprocesses, saves session state, then exits cleanly.

### Structured Logging
All key events emit structured JSON logs: `subprocess.spawn`, `subprocess.stall`, `subprocess.kill`, `request.complete`, `session.invalidate`, etc.

---

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check with subprocess counts, queue status, stall stats, session failure rates |
| `/v1/models` | GET | List available Claude models |
| `/v1/chat/completions` | POST | Chat completions (streaming and non-streaming) |

### Extended Thinking

Pass the `thinking` parameter to enable extended thinking mode:

```json
{
  "model": "claude-opus-4",
  "messages": [{"role": "user", "content": "Solve this complex problem..."}],
  "thinking": {"type": "enabled", "budget_tokens": 10000},
  "stream": true
}
```

Timeouts are automatically tripled when extended thinking is active.

### Conversation Continuity

Set the `user` field to a stable conversation ID to maintain context across requests:

```json
{
  "model": "claude-sonnet-4",
  "user": "my-conversation-123",
  "messages": [{"role": "user", "content": "Follow-up question..."}]
}
```

The proxy uses Claude CLI's `--resume` flag to continue the conversation without replaying history.

---

## Architecture

```
Your App (OpenClaw, Continue.dev, Python, etc.)
    |
    v
  HTTP Request (OpenAI format)
    |
    v
  This Proxy (localhost:3456)
    |
    v
  Claude Code CLI (subprocess per request)
    |
    v
  Claude Max subscription (via OAuth)
    |
    v
  Anthropic's API
    |
    v
  Response streams back to your app
```

Key internals:
- **Express server** with SSE streaming and keepalive
- **Per-conversation FIFO queue** for request serialization
- **Subprocess manager** with structured event parsing
- **Session manager** with disk persistence and TTL
- **SQLite conversation store** for message history and metrics
- **Warm-up pool** that pre-heats the OS process cache

---

## Auto-Start on macOS

See [docs/macos-setup.md](docs/macos-setup.md) for LaunchAgent configuration.

---

## Development

```bash
# Build from TypeScript sources
npm run build

# Watch mode
npm run dev

# Run
npm start

# Custom port
node dist/server/standalone.js 8080
```

The TypeScript sources are in `src/`, compiled output in `dist/`.

---

## Troubleshooting

### "Claude CLI not found"

```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

### Port 3456 already in use

```bash
# Find what's using it
lsof -i :3456

# Use a different port
node dist/server/standalone.js 3457
```

### Subprocess hangs / no response

Check the structured logs — stall detection should auto-kill hung processes. If issues persist, check `/health` for active subprocess PIDs and queue status.

### Streaming gives no output

Use the `-N` flag with curl to disable buffering:
```bash
curl -N -X POST http://localhost:3456/v1/chat/completions ...
```

---

## Security

- **No API keys stored** — authentication handled by Claude CLI's secure keychain
- **Localhost only** — binds to `127.0.0.1` by default
- **No shell execution** — all subprocesses spawned with `spawn()`, not `exec()`
- **No secrets in source** — environment variables cleaned before subprocess spawn

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
