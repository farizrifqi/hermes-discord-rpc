'use strict';

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

/**
 * StateMonitor reads Hermes agent activity from two sources:
 *
 * 1. PRIMARY: ~/.hermes/hooks/discord-rpc-activity/activity.json
 *    Written in real-time by the Hermes Gateway Hook on agent:step events.
 *    Watched via fs.watch for instant change detection.
 *    NOTE: Only fires for the default gateway process, not routed agents.
 *
 * 2. FALLBACK: SQLite state.db polling (ALL profiles)
 *    Scans the default state.db plus every profile's state.db to find the
 *    most recently active session across all agents. Each DB is tagged with
 *    its profile name so the presence label shows which agent is working.
 */

const ACTIVITY_FILE = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.hermes', 'hooks', 'discord-rpc-activity', 'activity.json'
);

const ACTIVITY_DIR = path.dirname(ACTIVITY_FILE);

// Default base path for Hermes data
const HERMES_BASE = path.join(
  process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'),
  'hermes'
);

// Simple path sanitizer for logs (scrubs username from paths)
function _sanitize(p) {
  if (!p) return p;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return p
    .replace(new RegExp(home.replace(/\\/g, '\\\\').replace(/:/g, '\\:'), 'gi'), '$HOME')
    .replace(/[A-Z]:\\Users\\[^\\]+\\/gi, 'C:\\Users\\User\\');
}

// Model name → friendly short name
const MODEL_ALIASES = {
  'openrouter/owl-alpha': 'OWL α',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'grok-4.3': 'Grok 4.3',
  'nvidia/nemotron-3-super-120b-a12b:free': 'Nemotron Super',
  'claude-sonnet-4-20250514': 'Claude Sonnet 4',
  'claude-opus-4-20250514': 'Claude Opus 4',
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'deepseek-v3': 'DeepSeek V3',
  'qwen-2.5-72b': 'Qwen 2.5 72B',
};

// Source → icon label
const SOURCE_ICONS = {
  'telegram': '💬',
  'tui': '🖥',
  'cli': '⌨️',
  'discord': '🎮',
  'slack': '💼',
  'signal': '📡',
  'whatsapp': '📱',
};

// Tool → emoji
const TOOL_EMOJI = {
  'web_search': '🔍', 'web': '🌐', 'terminal': '⚡',
  'read_file': '📄', 'write_file': '✍️', 'search_files': '🔎',
  'browser': '🌍', 'browser_console': '🖥', 'execute_code': '▶️',
  'memory': '🧠', 'todo': '✅', 'session_search': '📜',
  'fetch': '🌐', 'kanban_complete': '🏁', 'kanban_block': '🚧',
  'kanban_create': '📋', 'delegation': '🤝', 'clarify': '❓',
  'image_gen': '🎨', 'tts': '🔊', 'patch': '🔧',
};

class StateMonitor {
  constructor(config, logger) {
    this.config = config;
    this.log = logger;
    this._lastState = null;
    this._staleThreshold = (config.staleThresholdSeconds || 1800) * 1000;
    this._usingHook = false;
    this._hookWatcher = null;
    this._hookSubscribers = [];
    this._cachedHookData = null;
    // Map of profile name -> Database handle for each loaded state.db
    this._dbs = {};
    // Set of profile names to exclude from scanning
    this._excluded = new Set((config.excludedProfiles || []).map(s => s.trim()).filter(Boolean));
  }

  async connect() {
    // ---- Load all state.db files (default + all profiles) ----
    await this._loadAllDatabases();

    // ---- Hook file watcher ----
    if (fs.existsSync(ACTIVITY_FILE)) {
      this._usingHook = true;
      const initial = this._readHookActivity();
      if (initial) this._cachedHookData = initial;
    }
    this._startHookWatcher();
  }

  /**
   * Discover and load ALL state.db files:
   * - Default: %LOCALAPPDATA%\hermes\state.db  (profile = "default")
   * - Profiles: %LOCALAPPDATA%\hermes\profiles\<name>\state.db
   */
  async _loadAllDatabases() {
    const SQL = await initSqlJs();
    this._sql = SQL;
    const dbPaths = this._discoverDatabasePaths();
    const loaded = [];
    const skipped = [];

    for (const { profile, dbPath } of dbPaths) {
      if (this._excluded.has(profile)) {
        skipped.push(profile);
        continue;
      }
      try {
        const buffer = fs.readFileSync(dbPath);
        const db = new SQL.Database(buffer);
        this._dbs[profile] = db;
        loaded.push(profile);
      } catch (e) {
        this.log.warn(`Failed to load ${profile}: ${e.message}`);
      }
    }

    const summary = `Profiles: ${loaded.length}`;
    if (loaded.length > 0) {
      const names = loaded.length <= 5
        ? loaded.join(', ')
        : `${loaded.slice(0, 3).join(', ')}, ... +${loaded.length - 3} more`;
      this.log.info(`  ${summary} (${names})`);
    } else {
      this.log.info(`  ${summary}`);
    }
    if (skipped.length > 0) {
      this.log.info(`  Excluded: ${skipped.join(', ')}`);
    }
    this._lastRefresh = Date.now();
  }

  // Re-read all state.db files from disk so the polling loop picks up
  // new sessions/messages written by the running Hermes agent.
  // Uses a time gate (_refreshIntervalMs) to avoid re-reading on every
  // single poll cycle — defaults to every 5 seconds.
  _refreshDatabases() {
    if (!this._sql) return;
    const now = Date.now();
    const interval = this._refreshIntervalMs || 5000;
    if (now - this._lastRefresh < interval) return;

    const dbPaths = this._discoverDatabasePaths();
    for (const { profile, dbPath } of dbPaths) {
      if (this._excluded.has(profile)) continue;
      try {
        const buffer = fs.readFileSync(dbPath);
        const db = new this._sql.Database(buffer);
        if (this._dbs[profile]) {
          try { this._dbs[profile].close(); } catch (e) { /* ignore */ }
        }
        this._dbs[profile] = db;
      } catch (e) {
        this.log.debug(`Refresh failed for ${profile}: ${e.message}`);
      }
    }
    this._lastRefresh = now;
  }

  _discoverDatabasePaths() {
    const results = [];

    const defaultDb = path.join(HERMES_BASE, 'state.db');
    if (fs.existsSync(defaultDb)) {
      results.push({ profile: 'default', dbPath: defaultDb });
    }

    const profilesDir = path.join(HERMES_BASE, 'profiles');
    if (fs.existsSync(profilesDir)) {
      let dirs;
      try { dirs = fs.readdirSync(profilesDir); } catch (e) { dirs = []; }
      for (const dir of dirs) {
        const dbPath = path.join(profilesDir, dir, 'state.db');
        if (fs.existsSync(dbPath)) {
          results.push({ profile: dir, dbPath });
        }
      }
    }

    return results;
  }

  _closeAllDatabases() {
    for (const [profile, db] of Object.entries(this._dbs)) {
      try { db.close(); } catch (e) { /* ignore */ }
    }
    this._dbs = {};
  }

  // ---- Hook watcher ----

  _startHookWatcher() {
    try {
      let watchTarget = ACTIVITY_DIR;
      while (watchTarget && !fs.existsSync(watchTarget)) {
        watchTarget = path.dirname(watchTarget);
      }
      if (!watchTarget) return;

      this._hookWatcher = fs.watch(watchTarget, { persistent: true }, (eventType, filename) => {
        if (filename && path.basename(filename) !== path.basename(ACTIVITY_FILE)) return;

        if (this._watchDebounceTimer) clearTimeout(this._watchDebounceTimer);
        this._watchDebounceTimer = setTimeout(() => {
          this._watchDebounceTimer = null;
          try {
            const data = this._readHookActivity();
            if (data) {
              this._cachedHookData = data;
              this._usingHook = true;
              for (const cb of this._hookSubscribers) {
                try { cb(data); } catch (e) { /* ignore */ }
              }
            }
          } catch (e) {
            this.log.debug(`Hook file read error: ${e.message}`);
          }
        }, 100);
      });
      this.log.info(`  Hook:   watching ${_sanitize(watchTarget)}`);
    } catch (e) {
      this.log.warn(`Could not start file watcher: ${e.message}`);
    }
  }

  onHookChange(callback) {
    this._hookSubscribers.push(callback);
  }

  disconnect() {
    this._closeAllDatabases();
    if (this._hookWatcher) { this._hookWatcher.close(); this._hookWatcher = null; }
    if (this._watchDebounceTimer) { clearTimeout(this._watchDebounceTimer); this._watchDebounceTimer = null; }
    this._hookSubscribers = [];
  }

  _readHookActivity() {
    try {
      if (!fs.existsSync(ACTIVITY_FILE)) return null;
      const raw = fs.readFileSync(ACTIVITY_FILE, 'utf-8');
      const data = JSON.parse(raw);
      const now = Date.now();
      const age = now - (data.timestamp || 0) * 1000;
      if (age > this._staleThreshold) { this._usingHook = false; return null; }
      this._usingHook = true;
      return data;
    } catch (e) {
      this._usingHook = false;
      return null;
    }
  }

  // ---- Multi-profile session scanning ----

  _queryProfileSessions(db, profile, now) {
    try {
      const cutoff = now - this._staleThreshold;
      const stmt = db.prepare(`
        SELECT s.id, s.source, s.title, s.started_at, s.model,
               MAX(m.timestamp) * 1000 as last_msg_ms,
               (SELECT m2.tool_name FROM messages m2
                WHERE m2.session_id = s.id AND m2.tool_name IS NOT NULL AND m2.tool_name != ''
                ORDER BY m2.timestamp DESC LIMIT 1) as last_tool
        FROM sessions s
        LEFT JOIN messages m ON m.session_id = s.id
        WHERE s.archived = 0
        GROUP BY s.id
        HAVING last_msg_ms > ?
        ORDER BY last_msg_ms DESC
      `);
      stmt.bind([cutoff]);
      const rows = [];
      while (stmt.step()) {
        const row = stmt.getAsObject();
        row._profile = profile;
        rows.push(row);
      }
      stmt.free();
      return rows;
    } catch (e) {
      return [];
    }
  }

  _getMostActiveSession(now = Date.now()) {
    let best = null;

    for (const [profile, db] of Object.entries(this._dbs)) {
      const sessions = this._queryProfileSessions(db, profile, now);
      if (sessions.length === 0) continue;

      const top = sessions[0];
      if (!best || (top.last_msg_ms || 0) > (best.last_msg_ms || 0)) {
        best = top;
      }
    }

    return best;
  }

  // ---- Presence state builder ----

  async getPresenceState() {
    const now = Date.now();

    // ── PRIMARY: Hook activity file ──
    const hook = this._readHookActivity();
    if (hook && hook.status === 'active') {
      const sourceIcon = SOURCE_ICONS[hook.platform] || '💻';
      const toolEmoji = hook.tool ? (TOOL_EMOJI[hook.tool] || '🔧') : null;

      const state = {
        status: 'active',
        detail: hook.title || 'Working...',
        agentLabel: `${sourceIcon} ${hook.platform}`,
        model: MODEL_ALIASES[hook.model] || hook.model || null,
        startedAt: hook.timestamp ? Math.floor(hook.timestamp) : null,
        activeCount: 1,
        recentTool: hook.tool || null,
        toolEmoji,
        source: hook.platform,
        iteration: hook.iteration || 0,
        dataSource: 'hook',
        profile: null,
        lastSeen: now,
      };
      this._lastState = state;
      return state;
    }

    // ── FALLBACK: Multi-profile SQLite scan ──
    this._refreshDatabases();
    const primary = this._getMostActiveSession(now);

    if (!primary) {
      this._lastState = {
        status: 'idle',
        detail: 'Waiting for tasks',
        agentLabel: null, model: null, startedAt: null,
        activeCount: 0, recentTool: null, toolEmoji: null,
        source: null, iteration: 0, dataSource: 'sqlite', profile: null,
        lastSeen: now,
      };
      return this._lastState;
    }

    const sourceIcon = SOURCE_ICONS[primary.source] || '💻';
    const toolEmoji = primary.last_tool ? (TOOL_EMOJI[primary.last_tool] || '🔧') : null;

    const state = {
      status: 'active',
      detail: primary.title || `Active (${primary.source})`,
      agentLabel: `${sourceIcon} ${primary._profile}`,
      model: MODEL_ALIASES[primary.model] || primary.model || null,
      startedAt: primary.started_at ? Math.floor(primary.started_at) : null,
      activeCount: 1,
      recentTool: primary.last_tool || null,
      toolEmoji,
      source: primary.source,
      iteration: 0,
      dataSource: 'sqlite',
      profile: primary._profile,
      lastSeen: now,
    };
    this._lastState = state;
    return state;
  }

  getLastState() { return this._lastState; }
  isUsingHook() { return this._usingHook; }
  getProfileCount() { return Object.keys(this._dbs).length; }
}

module.exports = { StateMonitor, ACTIVITY_FILE, MODEL_ALIASES, TOOL_EMOJI, SOURCE_ICONS };
