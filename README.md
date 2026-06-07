# Hermes Discord RPC Companion

Show your [Hermes Agent](https://hermes-agent.nousresearch.com/) activity as **Discord Rich Presence** — see at a glance when your AI agent is working, what it's doing, and which model it's using.

![Demo](https://img.shields.io/badge/Discord-Rich%20Presence-5865F2?logo=discord)
![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs)
![License](https://img.shields.io/badge/License-MIT-blue)
![Status](https://img.shields.io/badge/Status-⚠️%20UNTESTED-red)

> **⚠️ UNTESTED — This is a pre-release / proof-of-concept build.**
> The code was generated and dry-run verified (SQLite reads, payload construction), but **has NOT been tested end-to-end with a live Discord connection**. Expect bugs. Use at your own risk. This is a temporary companion while waiting for the official [`hermes-companion`](https://github.com/NousResearch/hermes-agent/issues/28893) plugin.

## Features

- **Real-time presence** — Shows active Hermes sessions on your Discord profile
- **Multi-task awareness** — Displays "N tasks in progress" when multiple sessions are active
- **Model info** — Shows which AI model is being used (e.g., `gpt-5.4-mini`, `grok-4.3`)
- **Elapsed time** — Session start time shown in Discord's built-in timer
- **Tool tracking** — Shows the most recently used tool
- **Zero config** — Reads directly from Hermes's existing SQLite database
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

### 3. Create a Discord Application

1. Go to [https://discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **"New Application"**
3. Give it a name (e.g., "Hermes Agent")
4. Copy the **Application ID** (this is your Client ID)
5. *(Optional)* Go to **Rich Presence → Art Assets** and upload a logo image named `hermes-logo`

### 4. Configure your `.env`

Edit the `.env` file:

```env
DISCORD_CLIENT_ID=123456789012345678
HERMES_STATE_DB_PATH=C:\Users\YourName\AppData\Local\hermes\state.db
POLL_INTERVAL=10000
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
| `POLL_INTERVAL` | How often to check for changes (ms) | `10000` |
| `LOG_LEVEL` | Logging verbosity: `debug`, `info`, `warn`, `error` | `info` |
| `HERMES_API_URL` | Future: Hermes API server URL | *(disabled)* |

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

The companion reads from Hermes Agent's existing SQLite database (`state.db`):

- **Active sessions**: `SELECT * FROM sessions WHERE ended_at IS NULL`
- **Recent tools**: `SELECT tool_name FROM messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1`

Three presence states:
- **Idle** — No active sessions → "Idle — waiting for tasks"
- **Single task** — One session → Shows session title/last message + model + elapsed time
- **Multi-task** — Multiple sessions → "N tasks in progress"

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
└── discord-rpc.js    # Discord IPC connection & presence updates
```

### Data Source Priority
1. `activity.json` file (if `HERMES_ACTIVITY_FILE` is set)
2. Hermes API server (if `HERMES_API_URL` is set)
3. **SQLite database** (default, always works)

## License

MIT — see [LICENSE](LICENSE)
