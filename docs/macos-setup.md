# macOS Auto-Start Setup

This guide shows how to run `claude-max-api-proxy` automatically at login with a LaunchAgent. The steps below avoid hardcoded home-directory paths by generating the plist from your current shell environment.

## Prerequisites

From the repository root:

```bash
npm install
npm run build
claude auth login
```

## Create the LaunchAgent

Run this from the repository root so `$(pwd)` resolves to the checked-out project path:

```bash
mkdir -p "$HOME/Library/LaunchAgents"

cat > "$HOME/Library/LaunchAgents/com.claude-max-api-proxy.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.claude-max-api-proxy</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>WorkingDirectory</key>
    <string>$(pwd)</string>

    <key>ProgramArguments</key>
    <array>
      <string>$(command -v node)</string>
      <string>$(pwd)/dist/server/standalone.js</string>
    </array>

    <key>StandardOutPath</key>
    <string>/tmp/claude-max-api-proxy.log</string>

    <key>StandardErrorPath</key>
    <string>/tmp/claude-max-api-proxy.err.log</string>

    <key>EnvironmentVariables</key>
    <dict>
      <key>HOME</key>
      <string>$HOME</string>
      <key>PATH</key>
      <string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
  </dict>
</plist>
PLIST
```

If you later move the repository, regenerate the plist from the new path so `WorkingDirectory` and `ProgramArguments` stay correct.

## Load the service

```bash
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.claude-max-api-proxy.plist"

# Verify
launchctl list | grep claude-max-api-proxy
curl http://127.0.0.1:3456/health
```

## Management commands

```bash
# Check status
launchctl list | grep claude-max-api-proxy

# Restart
launchctl kickstart -k "gui/$(id -u)/com.claude-max-api-proxy"

# Stop temporarily
launchctl bootout "gui/$(id -u)/com.claude-max-api-proxy"

# Start again
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.claude-max-api-proxy.plist"

# View logs
tail -f /tmp/claude-max-api-proxy.log
tail -f /tmp/claude-max-api-proxy.err.log
```

## Uninstall

```bash
launchctl bootout "gui/$(id -u)/com.claude-max-api-proxy"
rm "$HOME/Library/LaunchAgents/com.claude-max-api-proxy.plist"
```

## Troubleshooting

### Service starts but the health check fails

```bash
cat /tmp/claude-max-api-proxy.err.log
```

Common issues:

- `npm run build` was never run, so `dist/server/standalone.js` does not exist yet.
- `claude` is not on the LaunchAgent `PATH`.
- `node` moved after the plist was created.

### Check the resolved paths

```bash
command -v node
command -v claude
pwd
echo "$HOME"
```
