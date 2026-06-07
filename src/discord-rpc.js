'use strict';

const { Client } = require('discord-rpc');

/**
 * DiscordRPC manages the Discord IPC connection and presence updates.
 *
 * Presence layout:
 *   details  = "Hermes Agent"  (always — this is the app name)
 *   state    = what it's doing right now (changes dynamically)
 *   largeImageKey  = "hermes-logo"
 *   largeImageText = agent label (model + source)
 *   smallImageKey  = tool emoji icon (when a tool was recently used)
 *   smallImageText = "🔧 tool_name"
 */

class DiscordRPC {
  constructor(config, logger) {
    this.config = config;
    this.log = logger;
    this.client = null;
    this.connected = false;
    this.lastUpdate = 0;
    this._minInterval = 15000; // Discord rate limit: 1 update per 15s
    this._reconnectDelay = 5000;
    this._maxReconnectDelay = 60000;
    this._currentReconnectDelay = this._reconnectDelay;
    this._reconnectTimer = null;
    this._destroyed = false;
  }

  async connect() {
    if (this._destroyed) return;

    if (!this.config.clientId || this.config.clientId === 'your_client_id_here') {
      throw new Error(
        'Discord Client ID not configured.\n' +
        '1. Go to https://discord.com/developers/applications\n' +
        '2. Create a new application\n' +
        '3. Copy the Application ID\n' +
        '4. Set DISCORD_CLIENT_ID in your .env file\n' +
        'See README.md for full setup instructions.'
      );
    }

    this.client = new Client({ transport: 'ipc' });

    this.client.on('ready', () => {
      this.connected = true;
      this._currentReconnectDelay = this._reconnectDelay;
      this.log.info(`Discord RPC connected as: ${this.client.user?.username || 'Unknown'}`);
    });

    this.client.on('disconnected', () => {
      this.connected = false;
      this.log.warn('Discord RPC disconnected');
      this._scheduleReconnect();
    });

    try {
      await this.client.login({ clientId: this.config.clientId });
    } catch (err) {
      this.log.error(`Failed to connect to Discord: ${err.message}`);
      this._scheduleReconnect();
    }
  }

  async updatePresence(state) {
    if (!this.connected || !this.client) {
      this.log.debug('Not connected to Discord, skipping presence update');
      return false;
    }

    const now = Date.now();
    const elapsed = now - this.lastUpdate;

    if (elapsed < this._minInterval) {
      const wait = this._minInterval - elapsed;
      this.log.debug(`Rate limited: waiting ${wait}ms before next update`);
      await new Promise(r => setTimeout(r, wait));
    }

    if (this._destroyed) return false;

    try {
      const activity = this._buildActivity(state);
      await this.client.setActivity(activity);
      this.lastUpdate = Date.now();
      this.log.info(`Presence: "${activity.state}" | ${activity.largeImageText}`);
      return true;
    } catch (err) {
      this.log.error(`Failed to update presence: ${err.message}`);
      return false;
    }
  }

  /**
   * Build Discord Rich Presence activity from state.
   *
   * Discord Rich Presence fields:
   *   details        — top line (128 char max) — "Hermes Agent"
   *   state          — bottom line (128 char max) — what it's doing
   *   largeImageKey  — big image asset key
   *   largeImageText — hover text for big image — agent/model info
   *   smallImageKey  — small image asset key (tool icon)
   *   smallImageText — hover text for small image — tool name
   *   startTimestamp — shows elapsed time clock
   *   instance       — whether it's an instance
   */
  _buildActivity(state) {
    const activity = {
      details: 'Hermes Agent',
      state: 'Idle — waiting for tasks',
      largeImageKey: 'hermes-logo',
      largeImageText: 'Hermes Agent by Nous Research',
      instance: false,
    };

    if (state.status === 'idle') {
      // ── Idle state ──
      activity.state = '💤 Idle — waiting for tasks';
      activity.largeImageText = 'Hermes Agent — Idle';
      activity.startTimestamp = undefined;
      delete activity.smallImageKey;
      delete activity.smallImageText;

    } else if (state.status === 'active') {
      if (state.activeCount > 1) {
        // ── Multi-tasking ──
        activity.state = `⚡ ${state.activeCount} sessions active`;
        activity.details = 'Hermes Agent';
        activity.largeImageText = state.agentLabel || 'Multi-session';

        // Show the most recent tool across all sessions
        if (state.recentTool) {
          const emoji = state.toolEmoji || '🔧';
          activity.smallImageText = `${emoji} ${state.recentTool}`;
        } else {
          delete activity.smallImageKey;
          delete activity.smallImageText;
        }

        if (state.startedAt) {
          activity.startTimestamp = state.startedAt * 1000;
        }

      } else {
        // ── Single session — show the interesting stuff ──
        const detail = state.detail || 'Working...';
        const toolStr = state.recentTool
          ? `${state.toolEmoji || '🔧'} ${state.recentTool}`
          : null;

        // Bottom line: task description or tool being used
        if (toolStr && detail !== 'Active session') {
          activity.state = `${toolStr} — ${detail}`;
        } else if (toolStr) {
          activity.state = `${toolStr}`;
        } else {
          activity.state = detail;
        }

        // Truncate to Discord's 128-char limit
        if (activity.state.length > 128) {
          activity.state = activity.state.slice(0, 125) + '...';
        }

        // Top line: agent label
        activity.details = state.agentLabel || 'Hermes Agent';

        // Large image hover: model name
        activity.largeImageText = state.model
          ? `Model: ${state.model}`
          : 'Hermes Agent';

        // Small image: tool
        if (state.recentTool) {
          activity.smallImageText = `${state.toolEmoji || '🔧'} ${state.recentTool}`;
        } else {
          delete activity.smallImageKey;
          delete activity.smallImageText;
        }

        // Elapsed time
        if (state.startedAt) {
          activity.startTimestamp = state.startedAt * 1000;
        }
      }
    }

    return activity;
  }

  async disconnect() {
    this._destroyed = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.client) {
      try {
        await this.client.destroy();
      } catch (e) { /* ignore */ }
      this.client = null;
    }
    this.connected = false;
    this.log.info('Discord RPC disconnected');
  }

  _scheduleReconnect() {
    if (this._destroyed) return;
    if (this._reconnectTimer) return;

    this.log.info(`Reconnecting in ${this._currentReconnectDelay / 1000}s...`);
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this._destroyed) return;

      try {
        await this.connect();
      } catch (e) {
        this._currentReconnectDelay = Math.min(
          this._currentReconnectDelay * 2,
          this._maxReconnectDelay
        );
        this._scheduleReconnect();
      }
    }, this._currentReconnectDelay);

    this._currentReconnectDelay = Math.min(
      this._currentReconnectDelay * 2,
      this._maxReconnectDelay
    );
  }
}

module.exports = { DiscordRPC };
