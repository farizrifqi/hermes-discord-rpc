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
 * Future-proof: also checks for hermes API server and activity.json file.
 */
class StateMonitor {
  constructor(config, logger) {
    this.config = config;
    this.log = logger;
    this.db = null;
    this._lastState = null;
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
   * Get active sessions (ended_at IS NULL)
   * Returns array of { id, source, title, started_at, model }
   */
  getActiveSessions() {
    if (!this.db) throw new Error('Not connected. Call connect() first.');

    const stmt = this.db.prepare(`
      SELECT id, source, title, started_at, model
      FROM sessions
      WHERE ended_at IS NULL AND archived = 0
      ORDER BY started_at DESC
    `);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }

  /**
   * Get the most recent user message content for a session
   * Returns string or null
   */
  getLastUserMessage(sessionId) {
    if (!this.db) return null;

    const stmt = this.db.prepare(`
      SELECT content FROM messages
      WHERE session_id = ? AND role = 'user'
      ORDER BY timestamp DESC
      LIMIT 1
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
   * Get recent tool activity for a session
   * Returns array of { tool_name, timestamp }
   */
  getRecentTools(sessionId, limit = 5) {
    if (!this.db) return [];

    const stmt = this.db.prepare(`
      SELECT tool_name, timestamp FROM messages
      WHERE session_id = ? AND tool_name IS NOT NULL AND tool_name != ''
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    stmt.bind([sessionId, limit]);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }

  /**
   * Build the current presence state from all available data sources.
   * Priority: activity.json file > API server > SQLite (default)
   */
  async getPresenceState() {
    // Future-proof: check activity file first
    if (this.config.activityFile) {
      try {
        const state = await this._fromActivityFile(this.config.activityFile);
        if (state) return state;
      } catch (e) {
        this.log.debug(`Activity file not available: ${e.message}`);
      }
    }

    // Future-proof: try API server
    if (this.config.apiUrl) {
      try {
        const state = await this._fromApi(this.config.apiUrl);
        if (state) return state;
      } catch (e) {
        this.log.debug(`API server not available: ${e.message}`);
      }
    }

    // Primary: SQLite database
    return this._fromDatabase();
  }

  _fromDatabase() {
    const sessions = this.getActiveSessions();

    if (sessions.length === 0) {
      const state = {
        status: 'idle',
        detail: 'Idle',
        details: 'Waiting for tasks',
        sessionId: null,
        model: null,
        startedAt: null,
        taskCount: 0,
        recentTool: null,
      };
      this._lastState = state;
      return state;
    }

    // Most recent session
    const primary = sessions[0];
    const taskCount = sessions.length;

    // Get display title: use session title, or last user message, or fallback
    let detail = primary.title;
    if (!detail) {
      const lastMsg = this.getLastUserMessage(primary.id);
      if (lastMsg) {
        // Truncate long messages
        detail = lastMsg.length > 60 ? lastMsg.slice(0, 57) + '...' : lastMsg;
      } else {
        detail = `Active session (${primary.source})`;
      }
    }

    // Get most recent tool used
    const recentTools = this.getRecentTools(primary.id, 1);
    const recentTool = recentTools.length > 0 ? recentTools[0].tool_name : null;

    const state = {
      status: 'active',
      detail: taskCount > 1 ? `${taskCount} tasks in progress` : detail,
      details: taskCount > 1 ? `${taskCount} tasks in progress` : detail,
      sessionId: primary.id,
      model: primary.model || 'Unknown model',
      startedAt: primary.started_at ? Math.floor(primary.started_at) : null,
      taskCount,
      recentTool,
      source: primary.source,
    };

    this._lastState = state;
    return state;
  }

  async _fromActivityFile(filePath) {
    const resolved = filePath.replace(/^~/, process.env.USERPROFILE || process.env.HOME || '');
    if (!fs.existsSync(resolved)) return null;

    const content = fs.readFileSync(resolved, 'utf-8');
    const data = JSON.parse(content);

    return {
      status: data.status || 'active',
      detail: data.detail || data.title || 'Working',
      details: data.details || data.title || 'Working',
      sessionId: data.sessionId || null,
      model: data.model || null,
      startedAt: data.startedAt || null,
      taskCount: data.taskCount || 1,
      recentTool: data.recentTool || null,
      source: 'activity-file',
    };
  }

  async _fromApi(apiUrl) {
    // Future implementation: fetch from Hermes API server
    const fetch = globalThis.fetch;
    if (!fetch) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(`${apiUrl}/sessions/active`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) return null;

    const data = await resp.json();
    if (!data.sessions || data.sessions.length === 0) {
      return {
        status: 'idle',
        detail: 'Idle',
        details: 'Waiting for tasks',
        sessionId: null,
        model: null,
        startedAt: null,
        taskCount: 0,
        recentTool: null,
        source: 'api',
      };
    }

    const primary = data.sessions[0];
    return {
      status: 'active',
      detail: primary.title || 'Working',
      details: primary.title || 'Working',
      sessionId: primary.id,
      model: primary.model || null,
      startedAt: primary.started_at ? Math.floor(primary.started_at) : null,
      taskCount: data.sessions.length,
      recentTool: null,
      source: 'api',
    };
  }

  getLastState() {
    return this._lastState;
  }
}

module.exports = { StateMonitor };
