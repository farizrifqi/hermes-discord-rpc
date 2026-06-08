#!/usr/bin/env node
'use strict';

const { loadConfig } = require('./config');
const { StateMonitor } = require('./state-monitor');
const { DiscordRPC } = require('./discord-rpc');

// ── Log sanitizer ─────────────────────────────────────────────
// Scrubs user-specific info from logs for safe screenshots/code images.
const USER_HOME = process.env.USERPROFILE || process.env.HOME || '';
function sanitize(str) {
  if (!str) return str;
  return str
    .replace(new RegExp(USER_HOME.replace(/\\/g, '\\\\').replace(/:/g, '\\:'), 'g'), '$HOME')
    .replace(/%LOCALAPPDATA%/g, '%APPDATA%')
    .replace(/C:\\Users\\[^\\]+\\/gi, 'C:\\Users\\User\\');
}

// ── Simple logger ──────────────────────────────────────────────
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function createLogger(level = 'info') {
  const minLevel = LOG_LEVELS[level] ?? 1;
  const fmt = (lvl, msg) => `[${lvl.toUpperCase()}] ${msg}`;
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
    } else if (arg === '--poll-interval' && argv[i + 1]) {
      args.pollInterval = argv[++i];
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
  --poll-interval <ms>   Polling interval in ms (default: 2000)
  --verbose, -v          Enable debug logging
  --dry-run, -n          Test mode: print presence state without Discord
  --help, -h             Show this help

Environment variables (or .env file):
  DISCORD_CLIENT_ID       Discord Application Client ID
  HERMES_STATE_DB_PATH    Path to Hermes state.db
  POLL_INTERVAL           Polling interval in ms (default: 2000)
  EXCLUDED_PROFILES       Comma-separated profiles to skip
  LOG_LEVEL               debug | info | warn | error
`);
}

// ── Icon helpers ───────────────────────────────────────────────
const STATUS_ICON = { active: '◉', idle: '○', error: '✕' };
const SRC_ICON   = { hook: '⚡', sqlite: '🔄' };

// ── Main loop ─────────────────────────────────────────────────
async function main() {
  const cliArgs = parseArgs(process.argv);

  if (cliArgs.help) {
    printHelp();
    process.exit(0);
  }

  const config = loadConfig(cliArgs);
  const log = createLogger(config.logLevel);

  // Initialize state monitor
  const monitor = new StateMonitor(config, log);

  log.info('━━━ Hermes Discord RPC Companion v1.0.0 ━━━');
  log.info(`  DB:   ${sanitize(config.dbPath)}`);
  log.info(`  Poll: ${config.pollInterval}ms`);
  log.info(`  Profiles: ${monitor.getProfileCount()}`);
  log.info('  Discord: waiting...');

  try {
    await monitor.connect();
  } catch (err) {
    log.error(err.message);
    process.exit(1);
  }

  // Dry run mode
  if (cliArgs.dryRun) {
    log.info('── dry run ──');
    try {
      const state = await monitor.getPresenceState();
      log.info(`  Status:   ${sanitize(state.status)}`);
      log.info(`  Agent:    ${sanitize(state.agentLabel || '-')}`);
      log.info(`  Task:     ${sanitize(state.detail || '-')}`);
      log.info(`  Model:    ${sanitize(state.model || 'N/A')}`);
      log.info(`  Tool:     ${sanitize(state.recentTool || 'N/A')}`);
      log.info(`  Source:   ${sanitize(state.profile || '-')} (${sanitize(state.dataSource || '-')})`);

      const rpc = new DiscordRPC(config, log);
      const activity = rpc._buildActivity(state);
      log.info('');
      log.info('Discord activity:');
      log.info(JSON.stringify(activity, null, 2));
    } catch (err) {
      log.error(`Error: ${err.message}`);
    }
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
    // reconnect handler will retry
  }

  // ── Hook event handler ──
  let lastSig = '';
  const signatureOf = (state) => [
    state.status || '-',
    state.profile || '-',
    state.agentLabel || '-',
    state.detail || '-',
    state.recentTool || '-',
    state.model || '-',
    state.dataSource || '-',
    state.iteration || 0,
    state.startedAt || 0,
    state.lastMsgMs || 0,
  ].join('|');

  monitor.onHookChange(async () => {
    if (shuttingDown) return;
    try {
      const state = await monitor.getPresenceState();
      const sig = signatureOf(state);
      if (sig !== lastSig) {
        lastSig = sig;
        const icon = STATUS_ICON[state.status] || '?';
        const srcIcon = SRC_ICON[state.dataSource] || '';
        log.info(`${srcIcon} ${icon} ${state.agentLabel || 'Idle'}${state.model ? `  [${state.model}]` : ''}`);
        await rpc.updatePresence(state);
      }
    } catch (err) {
      log.error(`Hook error: ${err.message}`);
    }
  });

  // ── Polling loop ──
  log.info('── watching ──');

  while (!shuttingDown) {
    try {
      const state = await monitor.getPresenceState();
      const sig = signatureOf(state);

      if (sig !== lastSig) {
        lastSig = sig;
        const icon = STATUS_ICON[state.status] || '?';
        const srcIcon = SRC_ICON[state.dataSource] || '';
        log.info(`${srcIcon} ${icon} ${state.agentLabel || 'Idle'}${state.model ? `  [${state.model}]` : ''}`);
        await rpc.updatePresence(state);
      } else {
        log.debug('no change');
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
