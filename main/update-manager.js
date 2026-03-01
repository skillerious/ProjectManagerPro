const path = require('path');
const fs = require('fs');
const AVAILABLE_CHANNELS = ['stable', 'beta', 'alpha'];

class UpdateManager {
  constructor({ logger, app, BrowserWindow }) {
    this.logger = logger;
    this.app = app;
    this.BrowserWindow = BrowserWindow;
    this.autoUpdater = null;
    this.initialized = false;
    this.disabledReason = '';
    this.channel = 'stable';

    this.state = {
      supported: false,
      checking: false,
      available: false,
      downloaded: false,
      downloadProgress: 0,
      currentVersion: app.getVersion(),
      latestVersion: '',
      channel: 'stable',
      availableChannels: [...AVAILABLE_CHANNELS],
      rollbackSupported: false,
      releaseDate: '',
      releaseNotes: '',
      lastCheckedAt: null,
      error: ''
    };
  }

  tryLoadAutoUpdater() {
    try {
      // eslint-disable-next-line global-require
      const { autoUpdater } = require('electron-updater');
      return autoUpdater;
    } catch (error) {
      this.disabledReason = `electron-updater unavailable: ${error.message}`;
      this.logger?.warn('Update manager disabled: electron-updater dependency not installed', {
        error: error.message
      });
      return null;
    }
  }

  updateFileExists() {
    try {
      const resourcesPath = process.resourcesPath || '';
      if (!resourcesPath) return false;
      const updateConfigPath = path.join(resourcesPath, 'app-update.yml');
      return fs.existsSync(updateConfigPath);
    } catch {
      return false;
    }
  }

  broadcastState() {
    const payload = { ...this.state };
    this.BrowserWindow.getAllWindows().forEach((window) => {
      if (!window || window.isDestroyed()) return;
      try {
        window.webContents.send('update-status', payload);
      } catch (error) {
        this.logger?.warn('Failed to broadcast update state', { error: error.message });
      }
    });
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.broadcastState();
  }

  normalizeChannel(channel) {
    const normalized = typeof channel === 'string' ? channel.trim().toLowerCase() : '';
    return AVAILABLE_CHANNELS.includes(normalized) ? normalized : 'stable';
  }

  applyChannel(channel, { allowDowngrade = false } = {}) {
    if (!this.autoUpdater) {
      return;
    }
    this.channel = this.normalizeChannel(channel);
    this.autoUpdater.channel = this.channel;
    this.autoUpdater.allowPrerelease = this.channel !== 'stable';
    this.autoUpdater.allowDowngrade = Boolean(allowDowngrade);
  }

  initialize({ channel = 'stable' } = {}) {
    if (this.initialized) {
      return this.state;
    }

    this.channel = this.normalizeChannel(channel);
    this.autoUpdater = this.tryLoadAutoUpdater();
    if (!this.autoUpdater) {
      this.setState({
        supported: false,
        channel: this.channel,
        error: this.disabledReason || 'Updates are unavailable in this build.'
      });
      this.initialized = true;
      return this.state;
    }

    const packaged = this.app.isPackaged;
    const hasUpdateConfig = this.updateFileExists();
    if (!packaged || !hasUpdateConfig) {
      const reason = !packaged
        ? 'Updates are only available in packaged builds.'
        : 'Update configuration is missing for this installation.';
      this.setState({
        supported: false,
        channel: this.channel,
        error: reason
      });
      this.initialized = true;
      return this.state;
    }

    this.autoUpdater.autoDownload = false;
    this.autoUpdater.autoInstallOnAppQuit = true;
    this.applyChannel(this.channel, { allowDowngrade: false });

    this.autoUpdater.on('checking-for-update', () => {
      this.setState({
        supported: true,
        checking: true,
        error: '',
        lastCheckedAt: new Date().toISOString()
      });
      this.logger?.info('Checking for updates...');
    });

    this.autoUpdater.on('update-available', (info) => {
      this.setState({
        supported: true,
        checking: false,
        available: true,
        downloaded: false,
        downloadProgress: 0,
        latestVersion: info?.version || '',
        releaseDate: info?.releaseDate || '',
        releaseNotes: this.normalizeReleaseNotes(info?.releaseNotes),
        error: ''
      });
      this.logger?.info('Update available', { version: info?.version || 'unknown' });
    });

    this.autoUpdater.on('update-not-available', () => {
      this.setState({
        supported: true,
        checking: false,
        available: false,
        downloaded: false,
        downloadProgress: 0,
        latestVersion: '',
        releaseDate: '',
        releaseNotes: '',
        error: ''
      });
      this.logger?.info('No updates available');
    });

    this.autoUpdater.on('download-progress', (progress) => {
      const percent = Number.isFinite(progress?.percent) ? progress.percent : 0;
      this.setState({
        supported: true,
        checking: false,
        available: true,
        downloaded: false,
        downloadProgress: Math.max(0, Math.min(100, percent))
      });
    });

    this.autoUpdater.on('update-downloaded', (info) => {
      this.setState({
        supported: true,
        checking: false,
        available: true,
        downloaded: true,
        downloadProgress: 100,
        latestVersion: info?.version || this.state.latestVersion
      });
      this.logger?.info('Update downloaded', { version: info?.version || this.state.latestVersion });
    });

    this.autoUpdater.on('error', (error) => {
      const message = error?.message || 'Update error';
      this.setState({
        supported: true,
        checking: false,
        error: message
      });
      this.logger?.warn('Auto-update error', { error: message });
    });

    this.setState({
      supported: true,
      channel: this.channel,
      availableChannels: [...AVAILABLE_CHANNELS],
      rollbackSupported: true,
      error: ''
    });

    this.initialized = true;
    return this.state;
  }

  normalizeReleaseNotes(releaseNotes) {
    if (!releaseNotes) return '';
    if (Array.isArray(releaseNotes)) {
      return releaseNotes
        .map((entry) => {
          if (!entry) return '';
          if (typeof entry === 'string') return entry;
          return entry.note || '';
        })
        .filter(Boolean)
        .join('\n\n');
    }
    if (typeof releaseNotes === 'string') {
      return releaseNotes;
    }
    if (typeof releaseNotes === 'object') {
      return releaseNotes.note || '';
    }
    return '';
  }

  getState() {
    return { ...this.state };
  }

  async checkForUpdates() {
    if (!this.autoUpdater || !this.state.supported) {
      return {
        success: false,
        state: this.getState(),
        error: this.state.error || 'Updates are unavailable.'
      };
    }

    try {
      await this.autoUpdater.checkForUpdates();
      return { success: true, state: this.getState() };
    } catch (error) {
      const message = error?.message || 'Failed to check for updates';
      this.setState({ checking: false, error: message });
      return { success: false, state: this.getState(), error: message };
    }
  }

  setChannel(channel) {
    const normalized = this.normalizeChannel(channel);
    this.channel = normalized;
    if (!this.autoUpdater || !this.state.supported) {
      this.setState({
        channel: normalized
      });
      return { success: false, state: this.getState(), error: this.state.error || 'Updates are unavailable.' };
    }

    this.applyChannel(normalized, { allowDowngrade: false });
    this.setState({
      channel: normalized,
      available: false,
      downloaded: false,
      downloadProgress: 0,
      latestVersion: '',
      releaseDate: '',
      releaseNotes: '',
      error: ''
    });
    return { success: true, state: this.getState() };
  }

  async rollbackToStable() {
    if (!this.autoUpdater || !this.state.supported) {
      return { success: false, state: this.getState(), error: this.state.error || 'Updates are unavailable.' };
    }

    this.applyChannel('stable', { allowDowngrade: true });
    this.setState({
      channel: 'stable',
      checking: true,
      error: ''
    });

    try {
      await this.autoUpdater.checkForUpdates();
      return { success: true, state: this.getState() };
    } catch (error) {
      const message = error?.message || 'Failed to check rollback channel';
      this.setState({
        checking: false,
        error: message
      });
      return { success: false, state: this.getState(), error: message };
    }
  }

  async downloadUpdate() {
    if (!this.autoUpdater || !this.state.supported) {
      return {
        success: false,
        state: this.getState(),
        error: this.state.error || 'Updates are unavailable.'
      };
    }

    if (!this.state.available) {
      return { success: false, state: this.getState(), error: 'No update is available to download.' };
    }

    try {
      await this.autoUpdater.downloadUpdate();
      return { success: true, state: this.getState() };
    } catch (error) {
      const message = error?.message || 'Failed to download update';
      this.setState({ error: message });
      return { success: false, state: this.getState(), error: message };
    }
  }

  installUpdate() {
    if (!this.autoUpdater || !this.state.supported) {
      return { success: false, state: this.getState(), error: 'Updates are unavailable.' };
    }

    if (!this.state.downloaded) {
      return { success: false, state: this.getState(), error: 'No downloaded update is ready to install.' };
    }

    setImmediate(() => {
      try {
        this.autoUpdater.quitAndInstall(false, true);
      } catch (error) {
        this.logger?.warn('Failed to quit and install update', { error: error.message });
      }
    });

    return { success: true, state: this.getState() };
  }
}

module.exports = {
  UpdateManager
};
