const os = require('os');
const path = require('path');

const GITHUB_TOKEN_ENCRYPTED_KEY = 'githubTokenEncrypted';
const GITHUB_TOKEN_LEGACY_KEY = 'githubToken';
const MAX_SETTINGS_FILE_SIZE_BYTES = 1024 * 1024;
const MAX_SETTINGS_PATH_LENGTH = 4096;
const MAX_SETTINGS_ARRAY_ITEMS = 200;
const MAX_SETTINGS_KEY_LENGTH = 100;
const MAX_SETTINGS_VALUE_STRING_LENGTH = 8192;
const MAX_SETTINGS_OBJECT_DEPTH = 6;
const MAX_SETTINGS_OBJECT_KEYS = 1000;
const ALLOWED_THEMES = new Set(['dark', 'light', 'high-contrast']);
const ALLOWED_TERMINAL_APPS = new Set(['cmd', 'powershell', 'wt', 'bash']);
const ALLOWED_EXTENSION_UPDATE_INTERVALS = new Set(['hourly', 'daily', 'weekly', 'monthly', 'never']);
const ALLOWED_UPDATE_CHANNELS = new Set(['stable', 'beta', 'alpha']);

function isAllowedThemeValue(themeValue) {
  if (typeof themeValue !== 'string') {
    return false;
  }

  const trimmed = themeValue.trim();
  if (!trimmed) {
    return false;
  }

  if (ALLOWED_THEMES.has(trimmed)) {
    return true;
  }

  return trimmed.length <= 160 && /^ext:[A-Za-z0-9._-]+$/.test(trimmed);
}

function buildDefaultAppSettings(defaultProjectPath) {
  return {
    theme: 'dark',
    autoSave: true,
    openInVSCode: true,
    repoUrl: '',
    docsUrl: '',
    issuesUrl: '',
    licenseUrl: '',
    gitIntegration: true,
    firstRunCompleted: false,
    defaultProjectPath: defaultProjectPath || path.join(os.homedir(), 'Projects'),
    fontSize: 13,
    autoUpdate: true,
    updateChannel: 'stable',
    terminalApp: 'cmd',
    showWelcome: true,
    closeToTray: false,
    autoRefreshInterval: 2000,
    enableFileWatcher: true,
    recentProjectsLimit: 10,
    confirmDelete: true,
    accentColor: '#007acc',
    fontFamily: 'system',
    uiScale: 100,
    smoothScrolling: true,
    animationsEnabled: true,
    editorPath: '',
    editorArgs: '',
    openReadme: true,
    createGitignore: true,
    terminalPath: '',
    terminalCwd: true,
    terminalAdmin: false,
    gitPath: '',
    gitUsername: '',
    gitEmail: '',
    gitAutoInit: true,
    gitAutoFetch: false,
    defaultBranch: 'main',
    autoUpdateExtensions: true,
    extensionRecommendations: true,
    extensionUpdateCheck: 'daily',
    maxWorkers: 4,
    hardwareAcceleration: true,
    cacheSize: 200,
    devTools: false,
    verboseLogging: false,
    extensions: {
      enabled: [],
      disabled: [],
      autoUpdate: true,
      updateCheckInterval: 'daily',
      settings: {}
    }
  };
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function sanitizeStringIdArray(input) {
  if (!Array.isArray(input)) {
    return [];
  }

  const seen = new Set();
  const values = [];

  for (const value of input) {
    if (values.length >= MAX_SETTINGS_ARRAY_ITEMS) {
      break;
    }

    if (typeof value !== 'string') {
      continue;
    }

    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_SETTINGS_KEY_LENGTH) {
      continue;
    }

    if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
      continue;
    }

    if (seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    values.push(trimmed);
  }

  return values;
}

function sanitizeSettingsValue(value, depth = 0) {
  if (depth > MAX_SETTINGS_OBJECT_DEPTH) {
    return undefined;
  }

  if (value === null || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === 'string') {
    return value.length > MAX_SETTINGS_VALUE_STRING_LENGTH
      ? value.slice(0, MAX_SETTINGS_VALUE_STRING_LENGTH)
      : value;
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_SETTINGS_ARRAY_ITEMS)
      .map((entry) => sanitizeSettingsValue(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }

  if (typeof value === 'object') {
    const output = {};
    let processedKeys = 0;

    for (const [key, nestedValue] of Object.entries(value)) {
      if (processedKeys >= MAX_SETTINGS_OBJECT_KEYS) {
        break;
      }

      if (typeof key !== 'string' || !key || key.length > MAX_SETTINGS_KEY_LENGTH) {
        continue;
      }

      const sanitizedNested = sanitizeSettingsValue(nestedValue, depth + 1);
      if (sanitizedNested === undefined) {
        continue;
      }

      output[key] = sanitizedNested;
      processedKeys += 1;
    }

    return output;
  }

  return undefined;
}

function sanitizeAppSettings(input, fallbackProjectPath) {
  const defaults = buildDefaultAppSettings(fallbackProjectPath);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return defaults;
  }

  const result = { ...defaults };

  const sanitizeText = (value, fallback = '', maxLength = MAX_SETTINGS_VALUE_STRING_LENGTH) => {
    if (typeof value !== 'string') {
      return fallback;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return fallback;
    }
    return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
  };

  const sanitizeHttpsUrl = (value, fallback = '') => {
    if (typeof value !== 'string') {
      return fallback;
    }
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_SETTINGS_VALUE_STRING_LENGTH) {
      return fallback;
    }

    try {
      const parsed = new URL(trimmed);
      if (!['https:', 'http:'].includes(parsed.protocol) || !parsed.hostname) {
        return fallback;
      }
      return parsed.toString();
    } catch {
      return fallback;
    }
  };

  const sanitizePath = (value, fallback = '') => {
    if (typeof value !== 'string') {
      return fallback;
    }
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_SETTINGS_PATH_LENGTH) {
      return fallback;
    }
    return path.resolve(trimmed);
  };

  if (isAllowedThemeValue(input.theme)) {
    result.theme = input.theme.trim();
  }

  if (typeof input.autoSave === 'boolean') {
    result.autoSave = input.autoSave;
  }

  if (typeof input.openInVSCode === 'boolean') {
    result.openInVSCode = input.openInVSCode;
  }

  result.repoUrl = sanitizeHttpsUrl(input.repoUrl, defaults.repoUrl);
  result.docsUrl = sanitizeHttpsUrl(input.docsUrl, defaults.docsUrl);
  result.issuesUrl = sanitizeHttpsUrl(input.issuesUrl, defaults.issuesUrl);
  result.licenseUrl = sanitizeHttpsUrl(input.licenseUrl, defaults.licenseUrl);

  if (typeof input.gitIntegration === 'boolean') {
    result.gitIntegration = input.gitIntegration;
  }

  if (typeof input.firstRunCompleted === 'boolean') {
    result.firstRunCompleted = input.firstRunCompleted;
  }

  result.defaultProjectPath = sanitizePath(input.defaultProjectPath, defaults.defaultProjectPath);
  result.fontSize = clampNumber(input.fontSize, 10, 20, defaults.fontSize);

  if (typeof input.autoUpdate === 'boolean') {
    result.autoUpdate = input.autoUpdate;
  }

  if (typeof input.updateChannel === 'string' && ALLOWED_UPDATE_CHANNELS.has(input.updateChannel.trim().toLowerCase())) {
    result.updateChannel = input.updateChannel.trim().toLowerCase();
  }

  if (typeof input.terminalApp === 'string' && ALLOWED_TERMINAL_APPS.has(input.terminalApp)) {
    result.terminalApp = input.terminalApp;
  }

  if (typeof input.showWelcome === 'boolean') {
    result.showWelcome = input.showWelcome;
  }

  if (typeof input.closeToTray === 'boolean') {
    result.closeToTray = input.closeToTray;
  }

  result.autoRefreshInterval = clampNumber(input.autoRefreshInterval, 500, 60000, defaults.autoRefreshInterval);

  if (typeof input.enableFileWatcher === 'boolean') {
    result.enableFileWatcher = input.enableFileWatcher;
  }

  result.recentProjectsLimit = clampNumber(input.recentProjectsLimit, 5, 50, defaults.recentProjectsLimit);
  if (typeof input.confirmDelete === 'boolean') {
    result.confirmDelete = input.confirmDelete;
  }

  if (typeof input.accentColor === 'string' && /^#[0-9A-Fa-f]{6}$/.test(input.accentColor.trim())) {
    result.accentColor = input.accentColor.trim();
  }

  result.fontFamily = sanitizeText(input.fontFamily, defaults.fontFamily, 128);
  result.uiScale = clampNumber(input.uiScale, 80, 150, defaults.uiScale);

  if (typeof input.smoothScrolling === 'boolean') {
    result.smoothScrolling = input.smoothScrolling;
  }

  if (typeof input.animationsEnabled === 'boolean') {
    result.animationsEnabled = input.animationsEnabled;
  }

  result.editorPath = sanitizePath(input.editorPath, defaults.editorPath);
  result.editorArgs = sanitizeText(input.editorArgs, defaults.editorArgs, 512);
  if (typeof input.openReadme === 'boolean') {
    result.openReadme = input.openReadme;
  }
  if (typeof input.createGitignore === 'boolean') {
    result.createGitignore = input.createGitignore;
  }

  result.terminalPath = sanitizePath(input.terminalPath, defaults.terminalPath);
  if (typeof input.terminalCwd === 'boolean') {
    result.terminalCwd = input.terminalCwd;
  }
  if (typeof input.terminalAdmin === 'boolean') {
    result.terminalAdmin = input.terminalAdmin;
  }

  result.gitPath = sanitizePath(input.gitPath, defaults.gitPath);
  result.gitUsername = sanitizeText(input.gitUsername, defaults.gitUsername, 128);
  result.gitEmail = sanitizeText(input.gitEmail, defaults.gitEmail, 256);
  if (typeof input.gitAutoInit === 'boolean') {
    result.gitAutoInit = input.gitAutoInit;
  }
  if (typeof input.gitAutoFetch === 'boolean') {
    result.gitAutoFetch = input.gitAutoFetch;
  }

  const branchCandidate = sanitizeText(input.defaultBranch, defaults.defaultBranch, 128);
  if (/^[A-Za-z0-9._/-]+$/.test(branchCandidate) && !branchCandidate.includes('..')) {
    result.defaultBranch = branchCandidate;
  }

  if (typeof input.extensionRecommendations === 'boolean') {
    result.extensionRecommendations = input.extensionRecommendations;
  }

  result.maxWorkers = clampNumber(input.maxWorkers, 1, 16, defaults.maxWorkers);
  if (typeof input.hardwareAcceleration === 'boolean') {
    result.hardwareAcceleration = input.hardwareAcceleration;
  }
  result.cacheSize = clampNumber(input.cacheSize, 50, 1000, defaults.cacheSize);
  if (typeof input.devTools === 'boolean') {
    result.devTools = input.devTools;
  }
  if (typeof input.verboseLogging === 'boolean') {
    result.verboseLogging = input.verboseLogging;
  }

  const inputExtensions = input.extensions && typeof input.extensions === 'object' && !Array.isArray(input.extensions)
    ? input.extensions
    : {};
  const enabled = sanitizeStringIdArray(inputExtensions.enabled);
  const disabled = sanitizeStringIdArray(inputExtensions.disabled).filter((id) => !enabled.includes(id));

  const extensionAutoUpdate =
    typeof input.autoUpdateExtensions === 'boolean'
      ? input.autoUpdateExtensions
      : (typeof inputExtensions.autoUpdate === 'boolean'
        ? inputExtensions.autoUpdate
        : defaults.extensions.autoUpdate);

  const extensionUpdateInterval =
    typeof input.extensionUpdateCheck === 'string' && ALLOWED_EXTENSION_UPDATE_INTERVALS.has(input.extensionUpdateCheck)
      ? input.extensionUpdateCheck
      : (typeof inputExtensions.updateCheckInterval === 'string' && ALLOWED_EXTENSION_UPDATE_INTERVALS.has(inputExtensions.updateCheckInterval)
        ? inputExtensions.updateCheckInterval
        : defaults.extensions.updateCheckInterval);

  result.extensions = {
    enabled,
    disabled,
    autoUpdate: extensionAutoUpdate,
    updateCheckInterval: extensionUpdateInterval,
    settings: sanitizeSettingsValue(inputExtensions.settings) || {}
  };

  result.autoUpdateExtensions = result.extensions.autoUpdate;
  result.extensionUpdateCheck = result.extensions.updateCheckInterval;

  const encryptedTokenInput = typeof input[GITHUB_TOKEN_ENCRYPTED_KEY] === 'string'
    ? input[GITHUB_TOKEN_ENCRYPTED_KEY].trim()
    : '';
  if (
    encryptedTokenInput &&
    encryptedTokenInput.length <= 8192 &&
    /^[A-Za-z0-9+/=]+$/.test(encryptedTokenInput)
  ) {
    result[GITHUB_TOKEN_ENCRYPTED_KEY] = encryptedTokenInput;
  }

  const legacyTokenInput = typeof input[GITHUB_TOKEN_LEGACY_KEY] === 'string'
    ? input[GITHUB_TOKEN_LEGACY_KEY].trim()
    : '';
  if (
    !result[GITHUB_TOKEN_ENCRYPTED_KEY] &&
    legacyTokenInput &&
    legacyTokenInput.length <= 512 &&
    !/\s/.test(legacyTokenInput)
  ) {
    result[GITHUB_TOKEN_LEGACY_KEY] = legacyTokenInput;
  }

  return result;
}

function getRendererSafeSettings(settingsInput) {
  const settings = settingsInput && typeof settingsInput === 'object' && !Array.isArray(settingsInput)
    ? settingsInput
    : {};
  const safeSettings = { ...settings };
  delete safeSettings[GITHUB_TOKEN_ENCRYPTED_KEY];
  delete safeSettings[GITHUB_TOKEN_LEGACY_KEY];
  return safeSettings;
}

module.exports = {
  GITHUB_TOKEN_ENCRYPTED_KEY,
  GITHUB_TOKEN_LEGACY_KEY,
  MAX_SETTINGS_FILE_SIZE_BYTES,
  MAX_SETTINGS_PATH_LENGTH,
  ALLOWED_TERMINAL_APPS,
  buildDefaultAppSettings,
  sanitizeAppSettings,
  getRendererSafeSettings,
  isAllowedThemeValue
};
