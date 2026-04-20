# Linux systemd User-Service Setup

This guide shows how to run `claude-max-api-proxy` as a `systemd --user` service. A user service is the recommended Linux setup because the Claude CLI authentication lives in your user account, not in root-owned system state.

## Prerequisites

From the repository root:

```bash
npm install
npm run build
claude auth login
```

## Create the service

Run this from the repository root so `$(pwd)` resolves to the checked-out project path:

```bash
mkdir -p "$HOME/.config/systemd/user"

cat > "$HOME/.config/systemd/user/claude-max-api-proxy.service" <<EOF
[Unit]
Description=claude-max-api-proxy
After=network.target

[Service]
Type=simple
WorkingDirectory=$(pwd)
ExecStart=$(command -v node) $(pwd)/dist/server/standalone.js
Restart=on-failure
RestartSec=5
Environment=HOME=%h
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF
```

If you later move the repository, regenerate the unit file from the new path.

## Enable and start it

```bash
systemctl --user daemon-reload
systemctl --user enable --now claude-max-api-proxy.service

# Verify
systemctl --user status claude-max-api-proxy.service
curl http://127.0.0.1:3456/health
```

## Management commands

```bash
# Restart
systemctl --user restart claude-max-api-proxy.service

# Stop
systemctl --user stop claude-max-api-proxy.service

# Follow logs
journalctl --user -u claude-max-api-proxy.service -f
```

## Uninstall

```bash
systemctl --user disable --now claude-max-api-proxy.service
rm "$HOME/.config/systemd/user/claude-max-api-proxy.service"
systemctl --user daemon-reload
```

## Troubleshooting

Common issues:

- `npm run build` was never run, so `dist/server/standalone.js` does not exist yet.
- `claude` is not available on the service `PATH`.
- Your user service manager is not running. On some distros you may need `loginctl enable-linger "$USER"` for background startup outside active login sessions.

Useful checks:

```bash
command -v node
command -v claude
journalctl --user -u claude-max-api-proxy.service -n 100 --no-pager
```
