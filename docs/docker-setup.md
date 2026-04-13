# Docker Setup

Run the proxy in a container. The image builds from source, installs the Claude CLI, and runs as a non-root user.

## Prerequisites

- Docker and Docker Compose
- Claude Code CLI installed and authenticated on the host (`claude auth login`)

## Quick Start

```bash
cp .env.example .env
# Edit .env — set REPOS_DIR to your repos directory
docker compose up -d
```

The proxy starts on port 3456. Verify it works:

```bash
curl http://localhost:3456/health
curl http://localhost:3456/v1/models
```

## Configuration

All settings go in `.env`. See `.env.example` for defaults.

| Variable             | Default          | Description                                                |
| -------------------- | ---------------- | ---------------------------------------------------------- |
| `PORT`               | `3456`           | Port the proxy listens on                                  |
| `REPOS_DIR`          | `/opt/repos`     | Host directory with your repos, mounted into the container |
| `CLAUDE_CONFIG_DIR`  | `~/.claude`      | Path to your Claude CLI config directory                   |
| `CLAUDE_CONFIG_FILE` | `~/.claude.json` | Path to your Claude CLI config file                        |
| `PUID`               | `1000`           | User ID the container process runs as                      |
| `PGID`               | `1000`           | Group ID the container process runs as                     |

### File permissions

The container runs as a non-root user (Claude CLI requires this). Set `PUID` and `PGID` to match your host user so the container can read your Claude credentials and write to your repos:

```bash
# Find your UID/GID
id -u  # e.g. 1000
id -g  # e.g. 1000
```

Add to `.env`:

```
PUID=1000
PGID=1000
```

### Persistent data

The `docker-compose.yml` creates a named volume (`claude-max-proxy-data`) for the SQLite database and session state. This data persists across container restarts.

To reset it:

```bash
docker compose down -v
```

## Use with other containers

The proxy binds to `0.0.0.0` inside the container. Other containers on the same Docker network can reach it by container name:

```
http://claude-max-proxy:3456/v1
```

To add the proxy to another project's Docker network, create a compose override or add the proxy's network as external:

```yaml
# In your other project's docker-compose.yml
services:
  your-service:
    networks:
      - default
      - claude-proxy

networks:
  claude-proxy:
    name: claude-max-proxy_default
    external: true
```

Then use `http://claude-max-proxy:3456/v1` as the base URL from your service.

## Rebuilding

After pulling updates:

```bash
docker compose up -d --build
```

## Logs

```bash
docker compose logs -f
```

## Security

The proxy does not authenticate clients. Any container or process that can reach port 3456 can use your Claude Max plan. Only expose it on trusted networks.
