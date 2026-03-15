const path = require('path');
const fs = require('fs');
const https = require('https');

const AVAILABLE_CHANNELS = ['stable', 'beta', 'alpha'];
const GITHUB_UPDATE_OWNER = 'skillerious';
const GITHUB_UPDATE_REPO = 'ProjectManagerPro';
const GITHUB_RELEASES_URL = `https://github.com/${GITHUB_UPDATE_OWNER}/${GITHUB_UPDATE_REPO}/releases`;
const GITHUB_RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_UPDATE_OWNER}/${GITHUB_UPDATE_REPO}/releases?per_page=30`;
const GITHUB_API_ACCEPT = 'application/vnd.github+json';
const GITHUB_API_VERSION = '2022-11-28';
const GITHUB_REQUEST_TIMEOUT_MS = 15000;
const MAX_RELEASE_RESPONSE_BYTES = 3 * 1024 * 1024;
const MAX_RELEASE_NOTES_LENGTH = 12000;
const TEST_UPDATE_DOWNLOAD_URL = 'https://ash-speed.hetzner.com/1GB.bin';
const TEST_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const TEST_DOWNLOAD_MAX_REDIRECTS = 5;

class UpdateManager {
  constructor({ logger, app, BrowserWindow }) {
    this.logger = logger;
    this.app = app;
    this.BrowserWindow = BrowserWindow;
    this.autoUpdater = null;
    this.initialized = false;
    this.disabledReason = '';
    this.channel = 'stable';
    this.checkForUpdatesInFlight = null;
    this.downloadUpdateInFlight = null;
    this.downloadTestInFlight = null;

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
      releasePageUrl: GITHUB_RELEASES_URL,
      error: ''
    };
  }

  tryLoadAutoUpdater() {
    try {
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

  getUnavailableMessage(baseMessage = 'Updates are unavailable.') {
    return `${baseMessage} Latest releases: ${GITHUB_RELEASES_URL}`;
  }

  getAutomaticUpdateUnavailableError() {
    return this.state.error
      || this.getUnavailableMessage(this.disabledReason || 'Automatic update downloads are unavailable in this build.');
  }

  buildGitHubRequestHeaders() {
    const version = this.state.currentVersion || this.app.getVersion() || '0.0.0';
    return {
      Accept: GITHUB_API_ACCEPT,
      'User-Agent': `ProjectManagerPro-Updater/${version}`,
      'X-GitHub-Api-Version': GITHUB_API_VERSION
    };
  }

  normalizeVersionString(versionValue) {
    if (versionValue === null || versionValue === undefined) {
      return '';
    }

    const rawVersion = String(versionValue).trim();
    if (!rawVersion) {
      return '';
    }

    const match = rawVersion.match(/v?\d+(?:[._]\d+){0,3}(?:-[0-9A-Za-z._-]+)?(?:\+[0-9A-Za-z._-]+)?/i);
    const candidate = match && match[0]
      ? match[0]
      : rawVersion.replace(/^v/i, '');

    return candidate
      .replace(/^v/i, '')
      .replace(/_/g, '.');
  }

  parseVersion(versionValue) {
    const normalized = this.normalizeVersionString(versionValue);
    if (!normalized) {
      return null;
    }

    const [coreAndPrerelease] = normalized.split('+', 1);
    const separatorIndex = coreAndPrerelease.indexOf('-');
    const corePart = separatorIndex >= 0
      ? coreAndPrerelease.slice(0, separatorIndex)
      : coreAndPrerelease;
    const prereleasePart = separatorIndex >= 0
      ? coreAndPrerelease.slice(separatorIndex + 1)
      : '';

    const coreSegments = corePart.split('.');
    if (coreSegments.length === 0 || coreSegments.length > 4) {
      return null;
    }

    if (coreSegments.some((segment) => !/^\d+$/.test(segment))) {
      return null;
    }

    const core = coreSegments.map((segment) => Number(segment));
    while (core.length < 4) {
      core.push(0);
    }

    const prerelease = prereleasePart
      ? prereleasePart.split('.').filter(Boolean).map((segment) => segment.toLowerCase())
      : [];

    return { core, prerelease };
  }

  comparePrerelease(leftPrerelease, rightPrerelease) {
    const left = Array.isArray(leftPrerelease) ? leftPrerelease : [];
    const right = Array.isArray(rightPrerelease) ? rightPrerelease : [];

    if (left.length === 0 && right.length === 0) {
      return 0;
    }

    if (left.length === 0) {
      return 1;
    }

    if (right.length === 0) {
      return -1;
    }

    const segmentCount = Math.max(left.length, right.length);
    for (let index = 0; index < segmentCount; index += 1) {
      const leftSegment = left[index];
      const rightSegment = right[index];

      if (leftSegment === undefined) {
        return -1;
      }
      if (rightSegment === undefined) {
        return 1;
      }
      if (leftSegment === rightSegment) {
        continue;
      }

      const leftNumeric = /^\d+$/.test(leftSegment);
      const rightNumeric = /^\d+$/.test(rightSegment);
      if (leftNumeric && rightNumeric) {
        return Number(leftSegment) - Number(rightSegment);
      }
      if (leftNumeric) {
        return -1;
      }
      if (rightNumeric) {
        return 1;
      }

      const lexicalCompare = leftSegment.localeCompare(rightSegment, undefined, { sensitivity: 'base' });
      if (lexicalCompare !== 0) {
        return lexicalCompare;
      }
    }

    return 0;
  }

  compareVersions(leftVersion, rightVersion) {
    const left = this.parseVersion(leftVersion);
    const right = this.parseVersion(rightVersion);

    if (!left && !right) {
      if (!leftVersion && !rightVersion) return 0;
      if (leftVersion && !rightVersion) return 1;
      if (!leftVersion && rightVersion) return -1;
      return String(leftVersion).localeCompare(String(rightVersion), undefined, { numeric: true, sensitivity: 'base' });
    }
    if (left && !right) return 1;
    if (!left && right) return -1;

    for (let index = 0; index < left.core.length; index += 1) {
      const diff = left.core[index] - right.core[index];
      if (diff !== 0) {
        return diff;
      }
    }

    return this.comparePrerelease(left.prerelease, right.prerelease);
  }

  isVersionGreater(candidateVersion, currentVersion) {
    return this.compareVersions(candidateVersion, currentVersion) > 0;
  }

  extractReleaseVersion(release) {
    if (!release || typeof release !== 'object') {
      return '';
    }

    const tag = typeof release.tag_name === 'string' ? release.tag_name.trim() : '';
    if (tag) {
      return this.normalizeVersionString(tag);
    }

    const name = typeof release.name === 'string' ? release.name.trim() : '';
    return this.normalizeVersionString(name);
  }

  inferReleaseStage(release) {
    const label = `${release?.tag_name || ''} ${release?.name || ''}`.toLowerCase();
    const parsedVersion = this.parseVersion(this.extractReleaseVersion(release));
    const prereleaseIds = parsedVersion?.prerelease || [];

    const hasAlpha = label.includes('alpha')
      || prereleaseIds.some((value) => value === 'alpha' || value.startsWith('alpha') || value === 'a');
    if (hasAlpha) {
      return 'alpha';
    }

    const hasBeta = label.includes('beta')
      || prereleaseIds.some((value) => value === 'beta' || value.startsWith('beta') || value === 'b');
    if (hasBeta) {
      return 'beta';
    }

    const hasRc = label.includes('rc')
      || prereleaseIds.some((value) => value === 'rc' || value.startsWith('rc'));
    if (hasRc) {
      return 'rc';
    }

    if (release?.prerelease || prereleaseIds.length > 0) {
      return 'prerelease';
    }

    return 'stable';
  }

  releaseMatchesChannel(release, channel) {
    if (!release || typeof release !== 'object' || release.draft) {
      return false;
    }

    const stage = this.inferReleaseStage(release);
    if (channel === 'stable') {
      return stage === 'stable';
    }

    if (channel === 'beta') {
      return stage !== 'alpha';
    }

    return true;
  }

  compareReleaseCandidates(left, right) {
    const versionComparison = this.compareVersions(
      this.extractReleaseVersion(left),
      this.extractReleaseVersion(right)
    );
    if (versionComparison !== 0) {
      return versionComparison;
    }

    const leftDate = Date.parse(left?.published_at || left?.created_at || '') || 0;
    const rightDate = Date.parse(right?.published_at || right?.created_at || '') || 0;
    if (leftDate !== rightDate) {
      return leftDate - rightDate;
    }

    const leftTag = typeof left?.tag_name === 'string' ? left.tag_name : '';
    const rightTag = typeof right?.tag_name === 'string' ? right.tag_name : '';
    return leftTag.localeCompare(rightTag, undefined, { numeric: true, sensitivity: 'base' });
  }

  selectReleaseForChannel(releases, channel = this.channel) {
    if (!Array.isArray(releases)) {
      return null;
    }

    const normalizedChannel = this.normalizeChannel(channel);
    const candidates = releases.filter((release) => this.releaseMatchesChannel(release, normalizedChannel));
    if (candidates.length === 0) {
      return null;
    }

    return candidates.reduce((best, candidate) => (
      this.compareReleaseCandidates(candidate, best) > 0 ? candidate : best
    ));
  }

  fetchJson(url, redirectCount = 0) {
    return new Promise((resolve, reject) => {
      const request = https.get(url, { headers: this.buildGitHubRequestHeaders() }, (response) => {
        const statusCode = Number(response.statusCode || 0);

        if ([301, 302, 307, 308].includes(statusCode) && response.headers.location) {
          if (redirectCount >= 4) {
            response.resume();
            reject(new Error('Update service redirected too many times.'));
            return;
          }

          const redirectUrl = new URL(response.headers.location, url).toString();
          response.resume();
          this.fetchJson(redirectUrl, redirectCount + 1).then(resolve).catch(reject);
          return;
        }

        let bodySize = 0;
        const chunks = [];
        response.on('data', (chunk) => {
          bodySize += chunk.length;
          if (bodySize > MAX_RELEASE_RESPONSE_BYTES) {
            request.destroy(new Error('Update service response exceeded the allowed size.'));
            return;
          }
          chunks.push(chunk);
        });

        response.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString('utf8').trim();

          if (statusCode < 200 || statusCode >= 300) {
            let message = `GitHub releases request failed (${statusCode}).`;
            if (rawBody) {
              try {
                const parsedError = JSON.parse(rawBody);
                if (parsedError && typeof parsedError.message === 'string' && parsedError.message.trim()) {
                  message = `${message} ${parsedError.message.trim()}`;
                }
              } catch {
                // Ignore parse errors and return the generic status message.
              }
            }
            reject(new Error(message));
            return;
          }

          if (!rawBody) {
            resolve([]);
            return;
          }

          try {
            resolve(JSON.parse(rawBody));
          } catch {
            reject(new Error('Received malformed JSON from the update service.'));
          }
        });
      });

      request.setTimeout(GITHUB_REQUEST_TIMEOUT_MS, () => {
        request.destroy(new Error('Timed out while contacting GitHub releases.'));
      });

      request.on('error', (error) => {
        reject(error);
      });
    });
  }

  async fetchGitHubReleases() {
    const response = await this.fetchJson(GITHUB_RELEASES_API_URL);
    if (!Array.isArray(response)) {
      throw new Error('GitHub releases API returned an unexpected response.');
    }
    return response;
  }

  async runManualReleaseCheck({ preserveSupported = false } = {}) {
    const checkedAt = new Date().toISOString();
    const keepSupported = preserveSupported && this.state.supported;

    this.setState({
      checking: true,
      error: '',
      lastCheckedAt: checkedAt
    });

    try {
      const releases = await this.fetchGitHubReleases();
      const selectedRelease = this.selectReleaseForChannel(releases, this.channel);
      const releaseVersion = this.extractReleaseVersion(selectedRelease);
      const currentVersion = this.normalizeVersionString(this.state.currentVersion || this.app.getVersion());
      const isAvailable = Boolean(selectedRelease && this.isVersionGreater(releaseVersion, currentVersion));
      const fallbackVersionLabel = releaseVersion ? `v${releaseVersion}` : '';

      const nextState = {
        checking: false,
        available: isAvailable,
        downloaded: false,
        downloadProgress: 0,
        latestVersion: isAvailable
          ? ((typeof selectedRelease?.tag_name === 'string' && selectedRelease.tag_name.trim())
            ? selectedRelease.tag_name.trim()
            : fallbackVersionLabel)
          : '',
        releaseDate: selectedRelease?.published_at || selectedRelease?.created_at || '',
        releaseNotes: isAvailable
          ? this.normalizeReleaseNotes(String(selectedRelease?.body || '').slice(0, MAX_RELEASE_NOTES_LENGTH))
          : '',
        lastCheckedAt: checkedAt,
        releasePageUrl: selectedRelease?.html_url || GITHUB_RELEASES_URL,
        error: ''
      };

      if (!keepSupported) {
        nextState.supported = false;
      }

      this.setState(nextState);
      return { success: true, state: this.getState(), manualOnly: !keepSupported };
    } catch (error) {
      const message = error?.message || 'Failed to contact the update service.';
      const nextState = {
        checking: false,
        available: false,
        downloaded: false,
        downloadProgress: 0,
        latestVersion: '',
        releaseDate: '',
        releaseNotes: '',
        lastCheckedAt: checkedAt,
        error: message
      };

      if (!keepSupported) {
        nextState.supported = false;
      }

      this.setState(nextState);
      return { success: false, state: this.getState(), error: message };
    }
  }

  applyManualOnlyUpdateState(manualState = {}) {
    this.setState({
      supported: false,
      checking: false,
      available: true,
      downloaded: false,
      downloadProgress: 0,
      latestVersion: manualState.latestVersion || '',
      releaseDate: manualState.releaseDate || '',
      releaseNotes: manualState.releaseNotes || '',
      lastCheckedAt: manualState.lastCheckedAt || new Date().toISOString(),
      releasePageUrl: manualState.releasePageUrl || GITHUB_RELEASES_URL,
      error: ''
    });
    return { success: true, state: this.getState(), manualOnly: true };
  }

  configureReleaseFeed() {
    if (!this.autoUpdater) {
      return false;
    }

    if (typeof this.autoUpdater.setFeedURL !== 'function') {
      return true;
    }

    try {
      this.autoUpdater.setFeedURL({
        provider: 'github',
        owner: GITHUB_UPDATE_OWNER,
        repo: GITHUB_UPDATE_REPO,
        private: false
      });
      this.logger?.info('Update feed configured', {
        provider: 'github',
        owner: GITHUB_UPDATE_OWNER,
        repo: GITHUB_UPDATE_REPO,
        releasesUrl: GITHUB_RELEASES_URL
      });
      return true;
    } catch (error) {
      this.disabledReason = `Failed to configure update feed: ${error.message}`;
      this.logger?.warn('Update feed configuration failed', {
        error: error.message,
        releasesUrl: GITHUB_RELEASES_URL
      });
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
    if (!patch || typeof patch !== 'object') {
      return;
    }

    const nextState = { ...this.state, ...patch };
    const changedKeys = Object.keys(patch);
    const hasChanges = changedKeys.some((key) => this.state[key] !== nextState[key]);
    if (!hasChanges) {
      return;
    }

    this.state = nextState;
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

  initialize({ channel = 'stable', currentVersion = '' } = {}) {
    if (this.initialized) {
      return this.state;
    }

    this.channel = this.normalizeChannel(channel);
    this.state.currentVersion = this.normalizeVersionString(currentVersion || this.state.currentVersion || this.app.getVersion())
      || this.state.currentVersion;
    this.autoUpdater = this.tryLoadAutoUpdater();
    if (!this.autoUpdater) {
      this.disabledReason = this.disabledReason || 'Automatic update downloads are unavailable in this build.';
      this.setState({
        supported: false,
        channel: this.channel,
        currentVersion: this.state.currentVersion,
        releasePageUrl: GITHUB_RELEASES_URL,
        error: ''
      });
      this.initialized = true;
      return this.state;
    }

    const packaged = this.app.isPackaged;
    if (!packaged) {
      this.disabledReason = 'Automatic update downloads are only available in packaged builds.';
      this.setState({
        supported: false,
        channel: this.channel,
        currentVersion: this.state.currentVersion,
        releasePageUrl: GITHUB_RELEASES_URL,
        error: ''
      });
      this.initialized = true;
      return this.state;
    }

    if (!this.updateFileExists()) {
      this.logger?.info('app-update.yml not found; using configured GitHub release feed', {
        releasesUrl: GITHUB_RELEASES_URL
      });
    }

    const feedConfigured = this.configureReleaseFeed();
    if (!feedConfigured) {
      this.setState({
        supported: false,
        channel: this.channel,
        currentVersion: this.state.currentVersion,
        releasePageUrl: GITHUB_RELEASES_URL,
        error: ''
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
        downloadProgress: 0,
        error: message
      });
      this.logger?.warn('Auto-update error', { error: message });
    });

    this.setState({
      supported: true,
      currentVersion: this.state.currentVersion,
      channel: this.channel,
      availableChannels: [...AVAILABLE_CHANNELS],
      rollbackSupported: true,
      releasePageUrl: GITHUB_RELEASES_URL,
      error: ''
    });

    this.initialized = true;
    return this.state;
  }

  normalizeReleaseNotes(releaseNotes) {
    if (!releaseNotes) return '';

    let normalized = '';
    if (Array.isArray(releaseNotes)) {
      normalized = releaseNotes
        .map((entry) => {
          if (!entry) return '';
          if (typeof entry === 'string') return entry;
          return entry.note || '';
        })
        .filter(Boolean)
        .join('\n\n');
    } else if (typeof releaseNotes === 'string') {
      normalized = releaseNotes;
    } else if (typeof releaseNotes === 'object') {
      normalized = releaseNotes.note || '';
    } else {
      normalized = '';
    }

    return String(normalized || '').trim().slice(0, MAX_RELEASE_NOTES_LENGTH);
  }

  getState() {
    return { ...this.state };
  }

  async checkForUpdates() {
    if (this.checkForUpdatesInFlight) {
      return this.checkForUpdatesInFlight;
    }

    this.checkForUpdatesInFlight = (async () => {
      if (!this.autoUpdater || !this.state.supported) {
        return this.runManualReleaseCheck();
      }

      try {
        await this.autoUpdater.checkForUpdates();
        const automaticState = this.getState();

        // Verify the latest release tag from GitHub when auto-updater reports no update.
        if (!automaticState.available) {
          const manualResult = await this.runManualReleaseCheck({ preserveSupported: true });
          if (manualResult.success && manualResult.state?.available) {
            this.logger?.info('GitHub release tag indicates a newer version than automatic updater feed', {
              latestVersion: manualResult.state.latestVersion,
              currentVersion: this.state.currentVersion
            });
            return this.applyManualOnlyUpdateState(manualResult.state);
          }

          if (!manualResult.success) {
            this.logger?.warn('Failed to verify GitHub release tags after automatic update check', {
              error: manualResult.error || 'Unknown release verification error'
            });
            this.setState({ ...automaticState, error: '' });
          }
        }

        return { success: true, state: this.getState() };
      } catch (error) {
        const message = error?.message || 'Failed to check for updates';
        this.logger?.warn('Automatic update check failed; trying GitHub release fallback', {
          error: message
        });

        const fallbackResult = await this.runManualReleaseCheck({ preserveSupported: true });
        if (fallbackResult.success) {
          if (fallbackResult.state?.available) {
            return this.applyManualOnlyUpdateState(fallbackResult.state);
          }
          return fallbackResult;
        }

        this.setState({ checking: false, error: message });
        return { success: false, state: this.getState(), error: fallbackResult.error || message };
      }
    })();

    try {
      return await this.checkForUpdatesInFlight;
    } finally {
      this.checkForUpdatesInFlight = null;
    }
  }

  setChannel(channel) {
    const normalized = this.normalizeChannel(channel);
    this.channel = normalized;
    if (!this.autoUpdater || !this.state.supported) {
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
      return { success: true, state: this.getState(), manualOnly: true };
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
      return { success: false, state: this.getState(), error: this.getAutomaticUpdateUnavailableError() };
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

  resolveTestDownloadUrl(downloadUrl) {
    const candidate = typeof downloadUrl === 'string' && downloadUrl.trim()
      ? downloadUrl.trim()
      : TEST_UPDATE_DOWNLOAD_URL;

    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error('Invalid test download URL.');
    }

    if (parsed.protocol !== 'https:') {
      throw new Error('Test download URL must use HTTPS.');
    }

    return parsed.toString();
  }

  buildTestDownloadTargetPath(downloadUrl) {
    const parsedUrl = new URL(downloadUrl);
    const extensionCandidate = path.extname(parsedUrl.pathname || '');
    const extension = (extensionCandidate && extensionCandidate.length <= 10) ? extensionCandidate : '.bin';
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
    const randomSuffix = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    const fileName = `appmanager-update-test-${timestamp}-${randomSuffix}${extension}`;
    return path.join(this.app.getPath('temp'), 'AppManager', 'update-download-tests', fileName);
  }

  async downloadFileWithProgress(downloadUrl, targetPath, redirectCount = 0) {
    return new Promise((resolve, reject) => {
      const request = https.get(downloadUrl, {
        headers: {
          'User-Agent': `ProjectManagerPro-Updater/${this.state.currentVersion || this.app.getVersion() || '0.0.0'}`
        }
      }, (response) => {
        const statusCode = response.statusCode || 0;

        if ([301, 302, 303, 307, 308].includes(statusCode) && response.headers.location) {
          response.resume();
          if (redirectCount >= TEST_DOWNLOAD_MAX_REDIRECTS) {
            reject(new Error('Test download redirected too many times.'));
            return;
          }

          let redirectedUrl = '';
          try {
            redirectedUrl = new URL(response.headers.location, downloadUrl).toString();
          } catch {
            reject(new Error('Test download redirect URL is invalid.'));
            return;
          }

          this.downloadFileWithProgress(redirectedUrl, targetPath, redirectCount + 1)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          reject(new Error(`Test download failed with HTTP ${statusCode}.`));
          return;
        }

        const contentLengthHeader = response.headers['content-length'];
        const totalBytesRaw = Number.parseInt(Array.isArray(contentLengthHeader) ? contentLengthHeader[0] : contentLengthHeader, 10);
        const totalBytes = Number.isFinite(totalBytesRaw) && totalBytesRaw > 0 ? totalBytesRaw : 0;
        const fileStream = fs.createWriteStream(targetPath);
        let downloadedBytes = 0;
        let lastReportedPercent = -1;
        let settled = false;

        const finalizeWithError = (error) => {
          if (settled) {
            return;
          }
          settled = true;

          try {
            response.destroy();
          } catch {
            // no-op
          }

          try {
            fileStream.destroy();
          } catch {
            // no-op
          }

          fs.promises.unlink(targetPath)
            .catch(() => undefined)
            .finally(() => {
              reject(error instanceof Error ? error : new Error(String(error || 'Test download failed')));
            });
        };

        const publishProgress = (force = false) => {
          if (totalBytes <= 0) {
            return;
          }

          const percent = Math.max(0, Math.min(100, (downloadedBytes / totalBytes) * 100));
          const floored = Math.floor(percent);
          if (!force && floored === lastReportedPercent) {
            return;
          }

          lastReportedPercent = floored;
          this.setState({
            checking: false,
            downloaded: false,
            downloadProgress: percent,
            error: ''
          });
        };

        response.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          publishProgress(false);
        });

        response.on('error', (error) => {
          finalizeWithError(error);
        });

        fileStream.on('error', (error) => {
          finalizeWithError(error);
        });

        fileStream.on('finish', () => {
          fileStream.close(() => {
            if (settled) {
              return;
            }
            settled = true;
            publishProgress(true);
            resolve({
              url: downloadUrl,
              targetPath,
              bytesDownloaded: downloadedBytes,
              totalBytes
            });
          });
        });

        response.pipe(fileStream);
      });

      request.setTimeout(TEST_DOWNLOAD_TIMEOUT_MS, () => {
        request.destroy(new Error('Test download timed out.'));
      });

      request.on('error', (error) => {
        reject(error);
      });
    });
  }

  async downloadTestUpdate(downloadUrl = TEST_UPDATE_DOWNLOAD_URL) {
    if (this.downloadTestInFlight) {
      return this.downloadTestInFlight;
    }

    this.downloadTestInFlight = (async () => {
      if (this.downloadUpdateInFlight) {
        return {
          success: false,
          state: this.getState(),
          error: 'Another update download is already in progress.'
        };
      }

      let resolvedUrl = '';
      try {
        resolvedUrl = this.resolveTestDownloadUrl(downloadUrl);
      } catch (error) {
        const message = error?.message || 'Invalid test download URL.';
        return { success: false, state: this.getState(), error: message };
      }

      const targetPath = this.buildTestDownloadTargetPath(resolvedUrl);

      try {
        await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
        this.setState({
          checking: false,
          downloaded: false,
          downloadProgress: 0,
          lastCheckedAt: new Date().toISOString(),
          error: ''
        });

        const downloadResult = await this.downloadFileWithProgress(resolvedUrl, targetPath);
        this.setState({
          checking: false,
          downloaded: false,
          downloadProgress: 100,
          error: ''
        });

        return {
          success: true,
          state: this.getState(),
          downloadPath: downloadResult.targetPath,
          bytesDownloaded: downloadResult.bytesDownloaded,
          totalBytes: downloadResult.totalBytes,
          url: downloadResult.url
        };
      } catch (error) {
        const message = error?.message || 'Failed to download test package.';
        this.setState({
          checking: false,
          downloaded: false,
          downloadProgress: 0,
          error: message
        });
        return { success: false, state: this.getState(), error: message, url: resolvedUrl };
      }
    })();

    try {
      return await this.downloadTestInFlight;
    } finally {
      this.downloadTestInFlight = null;
    }
  }

  async downloadUpdate() {
    if (this.downloadUpdateInFlight) {
      return this.downloadUpdateInFlight;
    }

    this.downloadUpdateInFlight = (async () => {
      if (this.downloadTestInFlight) {
        return {
          success: false,
          state: this.getState(),
          error: 'A test download is currently in progress.'
        };
      }

      if (!this.autoUpdater || !this.state.supported) {
        return {
          success: false,
          state: this.getState(),
          error: this.getAutomaticUpdateUnavailableError()
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
    })();

    try {
      return await this.downloadUpdateInFlight;
    } finally {
      this.downloadUpdateInFlight = null;
    }
  }

  installUpdate() {
    if (!this.autoUpdater || !this.state.supported) {
      return { success: false, state: this.getState(), error: this.getAutomaticUpdateUnavailableError() };
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
