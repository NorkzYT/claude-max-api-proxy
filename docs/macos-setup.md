# macOS Auto-Start Setup

Run the proxy as a managed LaunchAgent that starts at login, restarts on crash, and survives kills cleanly. The steps below generate the plist from your current shell environment, so there are no hardcoded paths to hand-edit.

## Why a LaunchAgent (not a LaunchDaemon)

The proxy shells out to the `claude` CLI, which reads OAuth credentials from your user keychain. A LaunchDaemon runs as root before login and cannot access your keychain, so the proxy must run as a LaunchAgent under your user account. Boot-time autostart therefore requires your user to be logged in (auto-login counts).

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
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

cat > "$HOME/Library/LaunchAgents/com.claude-max-api-proxy.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.claude-max-api-proxy</string>

    <key>ProgramArguments</key>
    <array>
      <string>$(command -v node)</string>
      <string>$(pwd)/dist/server/standalone.js</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$(pwd)</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
      <key>Crashed</key>
      <true/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>ExitTimeOut</key>
    <integer>30</integer>

    <key>ProcessType</key>
    <string>Interactive</string>

    <key>StandardOutPath</key>
    <string>$HOME/Library/Logs/claude-max-api-proxy.log</string>

    <key>StandardErrorPath</key>
    <string>$HOME/Library/Logs/claude-max-api-proxy.err.log</string>

    <key>EnvironmentVariables</key>
    <dict>
      <key>HOME</key>
      <string>$HOME</string>
      <key>PATH</key>
      <string>$(dirname "$(command -v node)"):$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
      <key>NODE_ENV</key>
      <string>production</string>
    </dict>
  </dict>
</plist>
PLIST
```

If you later move the repository, regenerate the plist from the new path so `WorkingDirectory` and `ProgramArguments` stay correct.

### Why each key is set this way

| Key | Purpose |
|---|---|
| `KeepAlive` dict (`Crashed=true`, `SuccessfulExit=false`) | Restarts on crash but not when you intentionally stop the process with a clean exit. Plain `KeepAlive=true` would fight you during maintenance. |
| `ThrottleInterval=10` | launchd waits 10 s between respawns. Without this, a port conflict (e.g. an orphaned prior process) produces a tight crash loop — thousands of respawns per minute. |
| `ExitTimeOut=30` | Gives the proxy up to 30 s to drain in-flight requests and shut down its subprocess pool before launchd escalates to SIGKILL. |
| `ProcessType=Interactive` | Tells macOS this is a foreground-priority user service, not a batch job. |
| `WorkingDirectory` | Ensures relative paths (e.g. the SQLite store) resolve inside the repo. |
| `StandardOutPath` / `StandardErrorPath` | `~/Library/Logs/…` is the standard macOS location and survives reboots (unlike `/tmp`). |
| `PATH` in `EnvironmentVariables` | launchd's default `PATH` is `/usr/bin:/bin:/usr/sbin:/sbin`, which does **not** include `claude`. The snippet above includes the directory that `node` lives in, which is typically the same directory `claude` is installed to. |

## Load the Service

```bash
# Validate syntax
plutil -lint "$HOME/Library/LaunchAgents/com.claude-max-api-proxy.plist"

# Load and start
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.claude-max-api-proxy.plist"

# Verify
launchctl print "gui/$(id -u)/com.claude-max-api-proxy" | grep -E '(state|pid|runs|last exit)'
curl http://127.0.0.1:3456/health
```

First boot warms the Claude CLI subprocess pool and probes which models your account can access. Expect 15–30 s before `/health` responds with `status: ok`.

## Management

```bash
# Detailed status
launchctl print "gui/$(id -u)/com.claude-max-api-proxy"

# Restart
launchctl kickstart -k "gui/$(id -u)/com.claude-max-api-proxy"

# Unload (until next login or manual reload)
launchctl bootout "gui/$(id -u)/com.claude-max-api-proxy"

# Reload after editing the plist
launchctl bootout "gui/$(id -u)/com.claude-max-api-proxy"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.claude-max-api-proxy.plist"

# Tail logs
tail -f "$HOME/Library/Logs/claude-max-api-proxy.log"
tail -f "$HOME/Library/Logs/claude-max-api-proxy.err.log"
```

## Uninstall

```bash
launchctl bootout "gui/$(id -u)/com.claude-max-api-proxy"
rm "$HOME/Library/LaunchAgents/com.claude-max-api-proxy.plist"
```

## Troubleshooting

### `runs = NNNN, last exit code = 1` with a high `runs` count

Usually a port conflict. Something else is holding `:3456` — often an orphaned prior instance after the LaunchAgent was reloaded.

```bash
# Find what's on the port
lsof -iTCP:3456 -sTCP:LISTEN

# Stop the agent and kill any stragglers
launchctl bootout "gui/$(id -u)/com.claude-max-api-proxy"
pkill -f 'claude-max-api-proxy/dist/server/standalone.js'
sleep 2
lsof -iTCP:3456   # should be empty

# Relaunch
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.claude-max-api-proxy.plist"
```

### `claude` CLI not found

launchd does not inherit your shell's `PATH`. Confirm the directory containing the `claude` binary is listed in the plist's `PATH`:

```bash
which claude
# Ensure that directory appears in <key>PATH</key> inside EnvironmentVariables.
```

### The service boots but `/health` never returns `ok`

Check the stderr log:

```bash
tail -40 "$HOME/Library/Logs/claude-max-api-proxy.err.log"
```

Common causes:
- Wrong path to `standalone.js` in `ProgramArguments`.
- Node version too old (`engines` requires Node ≥ 22).
- `claude auth login` was never run as this user.

### Restart takes ~30 seconds after a hard kill

Expected. When the proxy is killed with `SIGKILL`, the TCP socket on `:3456` enters `TIME_WAIT` for ~30 s. `ThrottleInterval=10` plus a few retries absorbs this window; the restart self-heals once the kernel releases the port.

### Finding the right paths

```bash
which node     # ProgramArguments[0]
which claude   # must be in PATH inside EnvironmentVariables
echo $HOME     # HOME
```
