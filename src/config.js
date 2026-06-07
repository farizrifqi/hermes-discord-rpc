'use strict';

const fs = require('fs');
const path = require('path');

// Load .env file if it exists
function loadEnv(envPath) {
  const defaultPath = path.resolve(__dirname, '..', '.env');
  const targetPath = envPath || defaultPath;

  if (!fs.existsSync(targetPath)) {
    return {};
  }

  const env = {};
  const content = fs.readFileSync(targetPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    env[key] = value;
  }
  return env;
}

function loadConfig(cliArgs = {}) {
  const env = loadConfig.env || loadEnv(cliArgs.env);
  loadConfig.env = env; // cache

  const dbPath = cliArgs.dbPath || env.HERMES_STATE_DB_PATH || path.join(
    process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'),
    'hermes', 'state.db'
  );

  const clientId = cliArgs.clientId || env.DISCORD_CLIENT_ID || '';
  const pollInterval = parseInt(cliArgs.pollInterval || env.POLL_INTERVAL || '2000', 10);
  const apiUrl = cliArgs.apiUrl || env.HERMES_API_URL || null;
  const activityFile = cliArgs.activityFile || env.HERMES_ACTIVITY_FILE || null;
  const logLevel = cliArgs.logLevel || env.LOG_LEVEL || 'info';
  const staleThresholdSeconds = parseInt(
    cliArgs.staleThreshold || env.STALE_THRESHOLD_SECONDS || '1800', 10
  );

  // Resolve ~ and %VAR% in paths
  let resolvedDbPath = dbPath.replace(/^~/, process.env.USERPROFILE || process.env.HOME || '');
  resolvedDbPath = resolvedDbPath.replace(/%([^%]+)%/g, (_, name) => process.env[name] || '');

  return {
    clientId,
    dbPath: resolvedDbPath,
    pollInterval: Math.max(pollInterval, 1000), // minimum 1s — Discord rate-limit is handled separately in discord-rpc.js
    apiUrl,
    activityFile,
    logLevel,
    staleThresholdSeconds,
  };
}

module.exports = { loadConfig, loadEnv };
