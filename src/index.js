#!/usr/bin/env node
'use strict';

const { loadConfig } = require('./config');
const { StateMonitor } = require('./state-monitor');
const { DiscordRPC } = require('./discord-rpc');

// ── Simple logger ──────────────────────────────────────────────
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function createLogger(level = 'info') {
  const minLevel = LOG_LEVELS[level] ?? 1;
  const fmt = (lvl, msg) => `[${new Date().toISOString()}] [${lvl.toUpperCase()}] ${msg}`;
  return {
    debug: (msg) => { if (minLevel <= 0) console.log(fmt('debug', msg)); },
    info:  (msg) => { if (minLevel <= 1) console.log(fmt('info',  msg)); },
    warn:  (msg) => { if (minLevel <= 2) console.warn(fmt('warn',  msg)); },
    error: (msg) => { if (minLevel <= 3) console.error(fmt('error', msg)); },
  };
}

// ── CLI arg parsing ───────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--verbose' || arg === '-v') {
      args.logLevel = 'debug';
    } else if (arg === '--dry-run' || arg === '-n') {
      args.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--env' && argv[i + 1]) {
      args.env = argv[++i];
    } else if (arg === '--db-path' && argv[i + 1]) {
      args.dbPath = argv[++i];
    } else if (arg === '--client-id' && argv[i + 1]) {
      args.clientId = argv[++i];
    } else if (arg === '--poll-interval' && argv[i + 1]) {
      args.pollInterval = argv[++i];
    } else if (arg === '--api-url' && argv[i + 1]) {
      args.apiUrl = argv[++i];
    } else if (arg === '--activity-file' && argv[i + 1]) {
      args.activityFile = argv[++i];
    }
  }
  return args;
}

function printHelp() {
  console.log(`
Hermes Discord RPC Companion
Shows your Hermes Agent activity as Discord Rich Presence.

Usage:
  node src/index.js [options]

Options:
  --client-id <id>       Discord Application Client ID
  --db-path <path>       Path to Hermes state.db
  --env <path>           Path to .env file (default: .env in project root)
  --poll-interval <ms>   Polling interval in ms (default: 10000, min: 5000)
  --api-url <url>        Hermes API server URL (future-proofing)
  --activity-file <path> Path to activity.json (future-proofing)
  --verbose, -v          Enable debug logging
  --dry-run, -n          Test mode: print presence state without Discord
  --help, -h             Show this help

Environment variables (or .env file):
  DISCORD_CLIENT_ID       Discord Application Client ID
  HERMES_STATE_DB_PATH    Path to Hermes state.db
  POLL_INTERVAL           Polling interval in ms
  LOG_LEVEL               debug | info | warn | error
`);
}

// ── Main loop ─────────────────────────────────────────────────
async function main() {
  const cliArgs = parseArgs(process.argv);

  if (cliArgs.help) {
    printHelp();
    process.exit(0);
  }

  const config = loadConfig(cliArgs);
  const log = createLogger(config.logLevel);

  log.info('═══════════════════════════════════════════');
  log.info('  Hermes Discord RPC Companion v1.0.0');
  log.info('═══════════════════════════════════════════');
  log.info(`  DB Path:      ${config.dbPath}`);
  log.info(`  Poll Interval: ${config.pollInterval}ms`);
  log.info(`  Client ID:    ${config.clientId ? config.clientId.slice(0, 8) + '...' : '(not set)'}`);
  log.info(`  Dry Run:      ${cliArgs.dryRun ? 'YES' : 'NO'}`);
  log.info('═══════════════════════════════════════════');

  // Initialize state monitor
  const monitor = new StateMonitor(config, log);

  try {
    await monitor.connect();
  } catch (err) {
    log.error(err.message);
    process.exit(1);
  }

  // Dry run mode: just print state and exit
  if (cliArgs.dryRun) {
    log.info('Dry run mode — checking state...');
    try {
      const state = await monitor.getPresenceState();
      log.info(`Status:     ${state.status}`);
      log.info(`Detail:     ${state.detail}`);
      log.info(`Model:      ${state.model || 'N/A'}`);
      log.info(`Tasks:      ${state.taskCount}`);
      log.info(`Session:    ${state.sessionId || 'N/A'}`);
      log.info(`Started At: ${state.startedAt ? new Date(state.startedAt * 1000).toISOString() : 'N/A'}`);
      log.info(`Recent Tool:${state.recentTool || 'N/A'}`);

      // Also show what Discord would see
      const rpc = new DiscordRPC(config, log);
      const activity = rpc._buildActivity(state);
      log.info('');
      log.info('Discord activity that would be set:');
      log.info(JSON.stringify(activity, null, 2));
    } catch (err) {
      log.error(`Error: ${err.message}`);
    }
    // Use process.exit to avoid sql.js cleanup assertion on Windows
    process.exit(0);
  }

  // Initialize Discord RPC
  const rpc = new DiscordRPC(config, log);

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down...`);

    // Clear presence before disconnecting
    try {
      if (rpc.connected) {
        await rpc.client.setActivity({
          details: 'Hermes Agent',
          state: 'Shutting down...',
          largeImageKey: 'hermes-logo',
          largeImageText: 'Hermes Agent',
        });
      }
    } catch (e) { /* ignore */ }

    await rpc.disconnect();
    monitor.disconnect();
    log.info('Goodbye!');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  // Handle Windows signals
  if (process.platform === 'win32') {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('SIGINT', () => shutdown('SIGINT'));
    rl.on('SIGTERM', () => shutdown('SIGTERM'));
  }

  // Connect to Discord
  try {
    await rpc.connect();
  } catch (err) {
    log.error(err.message);
    // Don't exit — the reconnect handler will retry
  }

  // ── Event-driven hook updates ──
  // When the hook file changes, update presence immediately (no poll delay).
  // This is the primary real-time path.
  let hookStateStr = '';
  monitor.onHookChange(async (hookData) => {
    if (shuttingDown) return;
    try {
      const state = await monitor.getPresenceState();
      const stateStr = JSON.stringify(state);
      if (stateStr !== hookStateStr) {
        hookStateStr = stateStr;
        log.info(`[hook] Status=${state.status} profile=${state.profile || '-'} detail=${(state.detail || '').slice(0, 60)}`);
        await rpc.updatePresence(state);
      }
    } catch (err) {
      log.error(`[hook] Update error: ${err.message}`);
    }
  });

  // ── Polling loop (always runs) ──
  // Continuously polls all profile databases to detect state changes.
  // Runs alongside the hook watcher — hook is instant, polling is the safety net.
  log.info('Starting presence polling loop...');
  let lastStateStr = '';

  while (!shuttingDown) {
    try {
      const state = await monitor.getPresenceState();
      const stateStr = JSON.stringify(state);

      if (stateStr !== lastStateStr) {
        log.info(`[poll] Status=${state.status} profile=${state.profile || '-'} src=${state.dataSource} detail=${(state.detail || '').slice(0, 60)}`);
        lastStateStr = stateStr;
        hookStateStr = stateStr; // keep hook tracker in sync
        await rpc.updatePresence(state);
      } else {
        log.debug('State unchanged');
      }
    } catch (err) {
      log.error(`Polling error: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, config.pollInterval));
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
