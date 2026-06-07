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
 *
 * 2. FALLBACK: SQLite state.db (polled)
 *    Used when the hook file doesn't exist (hook not installed) or is stale.
 */

const ACTIVITY_FILE = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.hermes', 'hooks', 'discord-rpc-activity', 'activity.json'
);

const ACTIVITY_DIR = path.dirname(ACTIVITY_FILE);

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
    this.db = null;
    this._lastState = null;
    this._staleThreshold = (config.staleThresholdSeconds || 1800) * 1000;
    this._usingHook = false;
    this._hookWatcher = null;
    this._hookSubscribers = [];
    this._cachedHookData = null;
  }

  async connect() {
    // Always try SQLite as fallback
    if (fs.existsSync(this.config.dbPath)) {
      try {
        const SQL = await initSqlJs();
        const buffer = fs.readFileSync(this.config.dbPath);
        this.db = new SQL.Database(buffer);
        this.log.info(`SQLite fallback ready: ${this.config.dbPath}`);
      } catch (e) {
        this.log.warn(`SQLite load failed: ${e.message}`);
      }
    }

    // Check if hook file exists or directory exists (hook may not have written yet)
    if (fs.existsSync(ACTIVITY_FILE)) {
      this._usingHook = true;
      this.log.info(`Hook activity file detected: ${ACTIVITY_FILE}`);
      // Read initial state
      const initial = this._readHookActivity();
      if (initial) this._cachedHookData = initial;
    } else if (fs.existsSync(ACTIVITY_DIR)) {
      this.log.info(`Hook directory exists but no activity file yet — watching for creation: ${ACTIVITY_DIR}`);
    } else {
      this.log.info('No hook activity file — using SQLite polling only');
      this.log.info('Install the gateway hook for real-time updates:');
      this.log.info('  ~/.hermes/hooks/discord-rpc-activity/');
    }

    // Set up file watcher for real-time hook events
    this._startHookWatcher();
  }

  /**
   * Watch the hook activity directory for file changes.
   * This gives instant updates instead of waiting for the next poll cycle.
   */
  _startHookWatcher() {
    try {
      // Watch the directory so we detect file creation too
      const watchTarget = fs.existsSync(ACTIVITY_DIR) ? ACTIVITY_DIR : path.dirname(ACTIVITY_DIR);
      this._hookWatcher = fs.watch(watchTarget, { persistent: true }, (eventType, filename) => {
        if (filename && filename !== path.basename(ACTIVITY_FILE)) return;

        // Debounce rapid events (agent:step fires frequently)
        if (this._watchDebounceTimer) clearTimeout(this._watchDebounceTimer);
        this._watchDebounceTimer = setTimeout(() => {
          this._watchDebounceTimer = null;
          try {
            const data = this._readHookActivity();
            if (data) {
              this._cachedHookData = data;
              this._usingHook = true;
              // Notify all subscribers (the main loop)
              for (const cb of this._hookSubscribers) {
                try { cb(data); } catch (e) { /* ignore subscriber errors */ }
              }
            }
          } catch (e) {
            this.log.debug(`Hook file read error: ${e.message}`);
          }
        }, 100); // 100ms debounce
      });
      this.log.info(`File watcher active on: ${watchTarget}`);
    } catch (e) {
      this.log.warn(`Could not start file watcher: ${e.message}`);
    }
  }

  /**
   * Subscribe to hook file change events.
   * callback(hookData) is called whenever the hook file is updated.
   */
  onHookChange(callback) {
    this._hookSubscribers.push(callback);
  }

  disconnect() {
    if (this.db) { this.db.close(); this.db = null; }
    if (this._hookWatcher) {
      this._hookWatcher.close();
      this._hookWatcher = null;
    }
    if (this._watchDebounceTimer) {
      clearTimeout(this._watchDebounceTimer);
      this._watchDebounceTimer = null;
    }
    this._hookSubscribers = [];
  }

  /**
   * Read activity from the hook file (real-time, primary source).
   * Returns null if hook file is missing or stale.
   */
  _readHookActivity() {
    try {
      if (!fs.existsSync(ACTIVITY_FILE)) return null;

      const raw = fs.readFileSync(ACTIVITY_FILE, 'utf-8');
      const data = JSON.parse(raw);
      const now = Date.now();
      const age = now - (data.timestamp || 0) * 1000;

      // If hook data is older than stale threshold, it's stale
      if (age > this._staleThreshold) {
        this._usingHook = false;
        return null;
      }

      this._usingHook = true;
      return data;
    } catch (e) {
      this._usingHook = false;
      return null;
    }
  }

  /**
   * Get truly active sessions from SQLite (fallback).
   */
  _getTrulyActiveSessions(now = Date.now()) {
    if (!this.db) return [];

    const stmt = this.db.prepare(`
      SELECT s.id, s.source, s.title, s.started_at, s.model,
             MAX(m.timestamp) * 1000 as last_msg_ms,
             (SELECT m2.tool_name FROM messages m2
              WHERE m2.session_id = s.id AND m2.tool_name IS NOT NULL AND m2.tool_name != ''
              ORDER BY m2.timestamp DESC LIMIT 1) as last_tool
      FROM sessions s
      LEFT JOIN messages m ON m.session_id = s.id
      WHERE s.ended_at IS NULL AND s.archived = 0
      GROUP BY s.id
      HAVING last_msg_ms > ?
      ORDER BY last_msg_ms DESC
    `);
    stmt.bind([now - this._staleThreshold]);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  async getPresenceState() {
    // ── PRIMARY: Hook activity file ──
    const hook = this._readHookActivity();
    if (hook && hook.status === 'active') {
      const sourceIcon = SOURCE_ICONS[hook.platform] || '💻';
      const toolEmoji = hook.tool ? (TOOL_EMOJI[hook.tool] || '🔧') : null;
      // Use profile name if available (e.g. "coding-agent"), fallback to platform
      const agentName = hook.profile || hook.platform;

      const state = {
        status: 'active',
        detail: hook.title || 'Working...',
        agentLabel: `${sourceIcon} ${agentName}`,
        model: MODEL_ALIASES[hook.model] || hook.model || null,
        startedAt: hook.timestamp ? Math.floor(hook.timestamp) : null,
        activeCount: 1,
        recentTool: hook.tool || null,
        toolEmoji,
        source: hook.platform,
        iteration: hook.iteration || 0,
        dataSource: 'hook',
      };
      this._lastState = state;
      return state;
    }

    if (hook && hook.status === 'idle') {
      const state = {
        status: 'idle',
        detail: 'Waiting for tasks',
        agentLabel: null,
        model: null,
        startedAt: null,
        activeCount: 0,
        recentTool: null,
        toolEmoji: null,
        source: null,
        iteration: 0,
        dataSource: 'hook',
      };
      this._lastState = state;
      return state;
    }

    // ── FALLBACK: SQLite polling ──
    const active = this._getTrulyActiveSessions();

    if (active.length === 0) {
      const state = {
        status: 'idle',
        detail: 'Waiting for tasks',
        agentLabel: null,
        model: null,
        startedAt: null,
        activeCount: 0,
        recentTool: null,
        toolEmoji: null,
        source: null,
        iteration: 0,
        dataSource: 'sqlite',
      };
      this._lastState = state;
      return state;
    }

    const primary = active[0];
    const sourceIcon = SOURCE_ICONS[primary.source] || '💻';
    const toolEmoji = primary.last_tool ? (TOOL_EMOJI[primary.last_tool] || '🔧') : null;

    const state = {
      status: 'active',
      detail: primary.title || `Active (${primary.source})`,
      agentLabel: `${sourceIcon} ${primary.source}`,
      model: MODEL_ALIASES[primary.model] || primary.model || null,
      startedAt: primary.started_at ? Math.floor(primary.started_at) : null,
      activeCount: active.length,
      recentTool: primary.last_tool || null,
      toolEmoji,
      source: primary.source,
      iteration: 0,
      dataSource: 'sqlite',
    };
    this._lastState = state;
    return state;
  }

  getLastState() { return this._lastState; }
  isUsingHook() { return this._usingHook; }
}

module.exports = { StateMonitor, ACTIVITY_FILE, MODEL_ALIASES, TOOL_EMOJI, SOURCE_ICONS };
