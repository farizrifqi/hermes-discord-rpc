'use strict';

const { Client } = require('discord-rpc');

/**
 * DiscordRPC manages the Discord IPC connection and presence updates.
 *
 * Presence layout:
 *   details        — top line: platform + model (e.g. "💬 Telegram · GPT-5.4 Mini")
 *   state          — bottom line: what it's doing (task + tool)
 *   largeImageKey  — "hermes-logo"
 *   largeImageText — hover text for big image
 *   smallImageKey  — tool icon
 *   smallImageText — "🔧 tool_name"
 */

class DiscordRPC {
  constructor(config, logger) {
    this.config = config;
    this.log = logger;
    this.client = null;
    this.connected = false;
    this.lastUpdate = 0;
    this._minInterval = 15000;
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
      this.log.debug('Not connected, skipping');
      return false;
    }

    const now = Date.now();
    const elapsed = now - this.lastUpdate;

    if (elapsed < this._minInterval) {
      const wait = this._minInterval - elapsed;
      this.log.debug(`Rate limited: waiting ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
    }

    if (this._destroyed) return false;

    try {
      const activity = this._buildActivity(state);
      await this.client.setActivity(activity);
      this.lastUpdate = Date.now();
      this.log.info(`✓ Presence: "${activity.state}" [${activity.largeImageText}]`);
      return true;
    } catch (err) {
      this.log.error(`Failed to update: ${err.message}`);
      return false;
    }
  }

  _buildActivity(state) {
    const activity = {
      details: 'Hermes Agent',
      state: '💤 Idle — waiting for tasks',
      largeImageKey: 'hermes-logo',
      largeImageText: 'Hermes Agent',
      instance: false,
    };

    if (state.status === 'idle') {
      activity.largeImageText = 'Hermes Agent — Idle';
      delete activity.smallImageKey;
      delete activity.smallImageText;

    } else if (state.status === 'active') {
      // Top line: agent label (platform + model)
      activity.details = state.agentLabel || 'Hermes Agent';

      // Bottom line: tool + task
      const parts = [];
      if (state.toolEmoji && state.recentTool) {
        parts.push(`${state.toolEmoji} ${state.recentTool}`);
      }
      if (state.detail && state.detail !== 'Working...') {
        parts.push(state.detail);
      }
      if (parts.length === 0 && state.recentTool) {
        parts.push(`Using ${state.recentTool}`);
      }

      activity.state = parts.join(' — ') || 'Working...';

      // Discord 128-char limit
      if (activity.state.length > 128) activity.state = activity.state.slice(0, 125) + '...';
      if (activity.details.length > 128) activity.details = activity.details.slice(0, 125) + '...';

      // Large image hover
      activity.largeImageText = state.model ? `Model: ${state.model}` : 'Hermes Agent';

      // Iteration badge (shows agent:step count)
      if (state.iteration > 0) {
        activity.largeImageText += ` · Step ${state.iteration}`;
      }

      // Data source indicator
      if (state.dataSource === 'hook') {
        activity.largeImageText += ' · live';
      }

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

    return activity;
  }

  async disconnect() {
    this._destroyed = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this.client) {
      try { await this.client.destroy(); } catch (e) { /* ignore */ }
      this.client = null;
    }
    this.connected = false;
    this.log.info('Discord RPC disconnected');
  }

  _scheduleReconnect() {
    if (this._destroyed || this._reconnectTimer) return;
    this.log.info(`Reconnecting in ${this._currentReconnectDelay / 1000}s...`);
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this._destroyed) return;
      try {
        await this.connect();
      } catch (e) {
        this._currentReconnectDelay = Math.min(this._currentReconnectDelay * 2, this._maxReconnectDelay);
        this._scheduleReconnect();
      }
    }, this._currentReconnectDelay);
    this._currentReconnectDelay = Math.min(this._currentReconnectDelay * 2, this._maxReconnectDelay);
  }
}

module.exports = { DiscordRPC };
