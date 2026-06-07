'use strict';

const { Client } = require('discord-rpc');

/**
 * DiscordRPC manages the Discord IPC connection and presence updates.
 * Handles reconnection, rate limiting, and graceful shutdown.
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

  /**
   * Connect to Discord via IPC
   */
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

  /**
   * Update Discord Rich Presence with current state.
   * Respects rate limiting (1 update per 15s).
   */
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
      this.log.debug(`Presence updated: ${activity.details}`);
      return true;
    } catch (err) {
      this.log.error(`Failed to update presence: ${err.message}`);
      return false;
    }
  }

  /**
   * Build Discord activity object from presence state
   */
  _buildActivity(state) {
    const activity = {
      details: 'Hermes Agent',
      state: 'Idle — waiting for tasks',
      largeImageKey: 'hermes-logo',
      largeImageText: 'Hermes Agent',
      instance: false,
    };

    if (state.status === 'idle') {
      activity.state = 'Idle — waiting for tasks';
      activity.startTimestamp = undefined;
    } else if (state.status === 'active') {
      if (state.taskCount > 1) {
        activity.state = `${state.taskCount} tasks in progress`;
        activity.details = 'Hermes Agent';
      } else {
        // Single task: show the detail
        const detail = state.detail || 'Working';
        // Discord has a 128-char limit for state
        activity.state = detail.length > 128 ? detail.slice(0, 125) + '...' : detail;
        activity.details = state.model ? `Model: ${state.model}` : 'Hermes Agent';
      }

      // Show elapsed time from session start
      if (state.startedAt) {
        activity.startTimestamp = state.startedAt * 1000; // convert to ms
      }

      // Show recent tool as small image text
      if (state.recentTool) {
        activity.smallImageKey = 'tool-icon';
        activity.smallImageText = `Using: ${state.recentTool}`;
      }
    }

    return activity;
  }

  /**
   * Disconnect from Discord
   */
  async disconnect() {
    this._destroyed = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.client) {
      try {
        await this.client.destroy();
      } catch (e) {
        // ignore
      }
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
        // Exponential backoff
        this._currentReconnectDelay = Math.min(
          this._currentReconnectDelay * 2,
          this._maxReconnectDelay
        );
        this._scheduleReconnect();
      }
    }, this._currentReconnectDelay);

    // Exponential backoff
    this._currentReconnectDelay = Math.min(
      this._currentReconnectDelay * 2,
      this._maxReconnectDelay
    );
  }
}

module.exports = { DiscordRPC };
