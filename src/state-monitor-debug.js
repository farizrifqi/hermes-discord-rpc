'use strict';

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

/**
 * StateMonitor polls the Hermes SQLite database for active sessions
 * and recent activity, then builds a presence state object.
 *
 * Uses sql.js (pure JS SQLite) — no native compilation needed.
 *
 * Detects truly active sessions by checking recent message timestamps,
 * not just ended_at (which Hermes often leaves NULL for stale sessions).
 */

// Model name → friendly display name
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

// Source → human label
const SOURCE_LABELS = {
  'telegram': '💬 Telegram',
  'tui': '🖥 TUI',
  'cli': '⌨️ CLI',
  'discord': '🎮 Discord',
  'slack': '💼 Slack',
  'signal': '📡 Signal',
  'whatsapp': '📱 WhatsApp',
};

// Tool → emoji for visual flair
const TOOL_EMOJI = {
  'web_search': '🔍',
  'web': '🌐',
  'terminal': '⚡',
  'read_file': '📄',
  'write_file': '✍️',
  'search_files': '🔎',
  'browser': '🌍',
  'browser_console': '🖥',
  'execute_code': '▶️',
  'memory': '🧠',
  'todo': '✅',
  'session_search': '📜',
  'fetch': '🌐',
  'kanban_complete': '🏁',
  'kanban_block': '🚧',
  'kanban_create': '📋',
  'delegation': '🤝',
  'clarify': '❓',
  'image_gen': '🎨',
  'tts': '🔊',
};

class StateMonitor {
  constructor(config, logger) { console.log("CTOR:", typeof config, typeof logger, Object.keys(config || {}));
    this.config = logger;
    this.log = logger;
    this.db = null;
    this._lastState = null;
    this._staleThreshold = (config.staleThresholdSeconds || 1800) * 1000; // default 30min
  }

  async connect() {
    if (!fs.existsSync(this.config.dbPath)) {
      throw new Error(`Database not found at: ${this.config.dbPath}\nEnsure Hermes Agent has been run at least once.`);
    }

    const SQL = await initSqlJs();
    const buffer = fs.readFileSync(this.config.dbPath);
    this.db = new SQL.Database(buffer);
    this.log.info(`Connected to Hermes state DB: ${this.config.dbPath}`);
  }

  disconnect() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Get sessions with recent activity (truly active, not just ended_at IS NULL)
   */
  getTrulyActiveSessions(now = Date.now()) {
    if (!this.db) throw new Error('Not connected. Call connect() first.');

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
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }

  /**
   * Get the most recent user message content for a session
   */
  getLastUserMessage(sessionId) {
    if (!this.db) return null;

    const stmt = this.db.prepare(`
      SELECT content FROM messages
      WHERE session_id = ? AND role = 'user'
      ORDER BY timestamp DESC LIMIT 1
    `);
    stmt.bind([sessionId]);
    let result = null;
    if (stmt.step()) {
      const row = stmt.getAsObject();
      result = row.content;
    }
    stmt.free();
    return result;
  }

  /**
   * Get the last N tool calls for a session (chronological)
   */
  getRecentTools(sessionId, limit = 3) {
    if (!this.db) return [];

    const stmt = this.db.prepare(`
      SELECT tool_name, timestamp FROM messages
      WHERE session_id = ? AND tool_name IS NOT NULL AND tool_name != ''
      ORDER BY timestamp DESC LIMIT ?
    `);
    stmt.bind([sessionId, limit]);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows.reverse(); // chronological order
  }

  /**
   * Get the most recent message (any role) for a session
   */
  getLastMessage(sessionId) {
    if (!this.db) return null;

    const stmt = this.db.prepare(`
      SELECT role, content, tool_name, timestamp FROM messages
      WHERE session_id = ?
      ORDER BY timestamp DESC LIMIT 1
    `);
    stmt.bind([sessionId]);
    let result = null;
    if (stmt.step()) {
      result = stmt.getAsObject();
    }
    stmt.free();
    return result;
  }

  /**
   * Derive a friendly "agent" label from the session source + model
   */
  deriveAgentLabel(source, model) {
    const modelShort = MODEL_ALIASES[model] || (model ? model.split('/').pop().split(':')[0] : null);
    const sourceLabel = SOURCE_LABELS[source] || source;

    if (modelShort) {
      return `${sourceLabel} · ${modelShort}`;
    }
    return sourceLabel;
  }

  /**
   * Build the current presence state.
   */
  async getPresenceState() {
    const now = Date.now();
    const active = this.getTrulyActiveSessions(now);

    // ── Idle ──
    if (active.length === 0) {
      const state = {
        status: 'idle',
        statusLabel: 'Idle',
        detail: 'Waiting for tasks',
        details: 'Waiting for tasks',
        agentLabel: null,
        model: null,
        startedAt: null,
        activeCount: 0,
        recentTool: null,
        toolEmoji: null,
        source: null,
        sessionInfo: null,
      };
      this._lastState = state;
      return state;
    }

    // ── Single active session ──
    if (active.length === 1) {
      const s = active[0];
      const agentLabel = this.deriveAgentLabel(s.source, s.model);
      const toolEmoji = s.last_tool ? (TOOL_EMOJI[s.last_tool] || '🔧') : null;

      // Build an informative "what am I doing" string
      let detail = s.title;
      if (!detail) {
        // Try last user message
        const lastUser = this.getLastUserMessage(s.id);
        if (lastUser) {
          detail = lastUser.length > 80 ? lastUser.slice(0, 77) + '...' : lastUser;
        } else {
          // Try last assistant message (truncated)
          const lastMsg = this.getLastMessage(s.id);
          if (lastMsg && lastMsg.content) {
            detail = lastMsg.content.length > 80 ? lastMsg.content.slice(0, 77) + '...' : lastMsg.content;
          } else {
            detail = 'Active session';
          }
        }
      }

      const ageMin = s.last_msg_ms ? Math.round((now - s.last_msg_ms) / 60000) : null;

      const state = {
        status: 'active',
        statusLabel: 'Active',
        detail: detail,
        details: detail,
        agentLabel,
        model: MODEL_ALIASES[s.model] || s.model || null,
        startedAt: s.started_at ? Math.floor(s.started_at) : null,
        activeCount: 1,
        recentTool: s.last_tool || null,
        toolEmoji,
        source: s.source,
        sessionInfo: {
          ageMinutes: ageMin,
          lastTool: s.last_tool,
        },
      };
      this._lastState = state;
      return state;
    }

    // ── Multiple active sessions ──
    // Show the most interesting one
    const primary = active[0];
    const agentLabel = this.deriveAgentLabel(primary.source, primary.model);
    const toolEmoji = primary.last_tool ? (TOOL_EMOJI[primary.last_tool] || '🔧') : null;

    // Askewt sessions by source
    const sourceCount = {};
    for (const s of active) {
      sourceCount[s.source] = (sourceCount[s.source] || 0) + 1;
    }
    const sourceSummary = Object.entries(sourceCount)
      .map(([src, cnt]) => `${SOURCE_LABELS[src] || src}: ${cnt}`)
      .join(' · ');

    const state = {
      status: 'active',
      statusLabel: 'Multi-tasking',
      detail: `${active.length} active sessions`,
      details: sourceSummary,
      agentLabel,
      model: MODEL_ALIASES[primary.model] || primary.model || null,
      startedAt: primary.started_at ? Math.floor(primary.started_at) : null,
      activeCount: active.length,
      recentTool: primary.last_tool || null,
      toolEmoji,
      source: primary.source,
      sessionInfo: {
        sourceBreakdown: sourceCount,
        primaryAgeMin: primary.last_msg_ms ? Math.round((now - primary.last_msg_ms) / 60000) : null,
      },
    };
    this._lastState = state;
    return state;
  }

  getLastState() {
    return this._lastState;
  }
}

module.exports = { StateMonitor, MODEL_ALIASES, TOOL_EMOJI };
