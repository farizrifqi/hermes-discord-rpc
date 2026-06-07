# Hermes Discord RPC Companion

Show your [Hermes Agent](https://hermes-agent.nousresearch.com/) activity as **Discord Rich Presence** — see at a glance when your AI agent is working, what it's doing, and which model it's using.

![Demo](https://img.shields.io/badge/Discord-Rich%20Presence-5865F2?logo=discord)
![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs)
![License](https://img.shields.io/badge/License-MIT-blue)
![Status](https://img.shields.io/badge/Status-✅%20TESTED%20%26%20WORKING-green)

## Preview

![Discord RPC Preview](https://i.imgur.com/gzWXAIK.png)
![Console Preview](https://i.imgur.com/aHFcgqR.png)

> **⚠️ Proof-of-concept build.** The code was generated and dry-run verified (SQLite reads, payload construction). Expect bugs. Use at your own risk. This is a temporary companion while waiting for the official [`hermes-companion`](https://github.com/NousResearch/hermes-agent/issues/28893) plugin.

## Data Sources

### Primary: Gateway Hook (real-time)
When the Hermes Gateway Hook is installed, the companion receives live agent and session
events (`agent:start`, `agent:step`, `agent:end`, `session:start`, `session:end`) —
updates appear instantly while the agent is working, with tool names and iteration counts.

### Fallback: SQLite polling
Without the hook, the companion polls `state.db` every 15 seconds.
Sessions older than 30 minutes are ignored (stale session filtering).

## Installing the Gateway Hook (recommended)

For real-time presence updates, install the Hermes Gateway Hook:

```bash
# Copy the hook files to your Hermes hooks directory
cp -r hooks/discord-rpc-activity ~/.hermes/hooks/
```

Or manually create these two files:

**`~/.hermes/hooks/discord-rpc-activity/HOOK.yaml`:**
```yaml
name: discord-rpc-activity
description: Writes real-time agent activity to a JSON file for the Discord RPC companion
events:
  - agent:start
  - agent:step
  - agent:end
  - session:start
  - session:end
```

**`~/.hermes/hooks/discord-rpc-activity/handler.py`:**
See [`hooks/discord-rpc-activity/handler.py`](hooks/discord-rpc-activity/handler.py) in this repo.

After creating the hook files, restart your Hermes gateway. The hook creates
`~/.hermes/hooks/discord-rpc-activity/activity.json` on any of the five subscribed
events. The companion auto-detects this file and switches to real-time mode (you'll
see "live" in the presence text).

- **Real-time presence** — Shows active Hermes sessions on your Discord profile
- **Multi-task awareness** — Displays "N tasks in progress" when multiple sessions are active
- **Model info** — Shows which AI model is being used (e.g., `gpt-5.4-mini`, `grok-4.3`)
- **Elapsed time** — Session start time shown in Discord's built-in timer
- **Tool tracking** — Shows the most recently used tool
- **Minimal config** — Zero config for basic use; install the gateway hook for real-time updates
- **Auto-reconnect** — Handles Discord restarts and network issues gracefully
- **Rate-limit safe** — Respects Discord's 15-second presence update limit

## Prerequisites

- [Node.js](https://nodejs.org/) 18+ (LTS recommended)
- [Discord](https://discord.com/) desktop app running
- [Hermes Agent](https://hermes-agent.nousresearch.com/) v0.12+ (already running with active sessions)

## Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/nousresearch/hermes-discord-rpc.git
cd hermes-discord-rpc
```

### 2. Run the installer (Windows)

```bat
install.bat
```

This will:
- Install npm dependencies
- Create `.env` from the template
- Run a dry-run test

### 3. Create or choose a Discord Application

This repository ships with a working Client ID (shown in the next step) that you can use immediately for testing.  
If you prefer to use your own application:

1. Go to [https://discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **"New Application"**
3. Give it a name (e.g., "Hermes Agent")
4. Copy the **Application ID** (this is your Client ID)
5. *(Optional)* Go to **Rich Presence → Art Assets** and upload a logo image named `hermes-logo`

Paste your Client ID into `.env` as `DISCORD_CLIENT_ID` in the next step.

### 4. Configure your `.env`

Edit the `.env` file. A working Client ID is provided below — you can use it as-is or replace with your own:

```env
# Working Client ID (shown in test, usable for testing)
DISCORD_CLIENT_ID=1512988178229887218
HERMES_STATE_DB_PATH=%LOCALAPPDATA%\hermes\state.db
POLL_INTERVAL=2000
```

### 5. Start the companion

```bash
npm start
```

Your Discord profile should now show Hermes Agent activity!

## Configuration

| Variable | Description | Default |
|---|---|---|
| `DISCORD_CLIENT_ID` | Discord Application Client ID | *(required)* |
| `HERMES_STATE_DB_PATH` | Path to Hermes `state.db` | `%LOCALAPPDATA%\hermes\state.db` |
| `POLL_INTERVAL` | How often to check for changes (ms) | `2000` |
| `LOG_LEVEL` | Logging verbosity: `debug`, `info`, `warn`, `error` | `info` |
| `STALE_THRESHOLD_SECONDS` | Stale session threshold in seconds | `1800` |

## CLI Options

```bash
node src/index.js [options]

--client-id <id>       Discord Application Client ID
--db-path <path>       Path to Hermes state.db
--env <path>           Path to .env file
--poll-interval <ms>   Polling interval in ms
--verbose, -v          Enable debug logging
--dry-run, -n          Test mode (no Discord connection)
--help, -h             Show help
```

## Auto-Start on Windows

### Option A: Startup Folder

1. Press `Win + R`, type `shell:startup`, press Enter
2. Create a shortcut to `install.bat` or a batch file containing:
   ```bat
   cd /d %~dp0
   node src/index.js
   ```

### Option B: Task Scheduler

1. Open Task Scheduler (`taskschd.msc`)
2. Create Basic Task → Name: "Hermes Discord RPC"
3. Trigger: "When I log on"
4. Action: Start a program
   - Program: `node`
   - Arguments: `src/index.js`
   - Start in: `C:\path\to\hermes-discord-rpc`

## How It Works

The companion reads Hermes activity from two sources:

1. **Primary: Gateway Hook** — If the `discord-rpc-activity` hook is installed at
   `~/.hermes/hooks/discord-rpc-activity/`, Hermes writes real-time activity to a JSON
   file on each `agent:step`, `agent:end`, `session:start`, `session:end` event.
   The companion reads this file instantly — no polling, no stale sessions.

2. **Fallback: SQLite polling** — Without the hook, the companion polls `state.db`
   every 15 seconds. Sessions older than 30 minutes are ignored.

Three presence states:
- **Idle** — No active sessions → "💤 Idle — waiting for tasks"
- **Active** — Agent working → Shows platform, model, tool emoji, and task description
- With "live" badge when using the gateway hook

## Troubleshooting

### "Database not found"
Ensure Hermes Agent has been run at least once. Check that `state.db` exists at `%LOCALAPPDATA%\hermes\state.db`.

### "Failed to connect to Discord"
- Make sure Discord desktop app is running (not just the browser)
- Verify your Client ID is correct
- Try restarting Discord

### Presence not updating
- Check that `DISCORD_CLIENT_ID` is set correctly
- Run with `--verbose` to see debug output
- Run `npm test` (dry-run) to verify database reading works

### "better-sqlite3" build errors on Windows
```bash
npm install --global windows-build-tools
# or ensure you have Python and a C++ compiler:
npm config set python python3.11
npm rebuild better-sqlite3
```

## Architecture

```
src/
├── index.js          # Main entry, CLI parsing, polling loop
├── config.js         # Config loading from .env and CLI args
├── state-monitor.js  # SQLite polling, presence state builder
## How it detects multi-agent

The companion scans ALL Hermes profile databases to find the most recently active agent:
- Default: `%LOCALAPPDATA%\hermes\state.db`
- Profiles: `%LOCALAPPDATA%\hermes\profiles\*\state.db`
- Shows the profile name in presence: `🖥 coding-agent`, `🖥 xresearch`, etc.
- Use `EXCLUDED_PROFILES=routing-agent,hermes-admin` to skip noisy profiles

## License

MIT — see [LICENSE](LICENSE)
