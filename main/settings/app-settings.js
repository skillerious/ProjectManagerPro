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
const ALLOWED_STATUS_TIME_FORMATS = new Set(['system', '24h', '12h']);
const ALLOWED_DEFAULT_PROJECT_TEMPLATES = new Set(['blank', 'nodejs', 'python', 'react', 'web']);
const ALLOWED_EDITOR_OPEN_MODES = new Set(['new-window', 'reuse-window']);
const ALLOWED_EDITOR_WORD_WRAP = new Set(['off', 'on', 'wordWrapColumn']);

function coerceAllowedValue(value, allowedValues) {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  for (const allowedValue of allowedValues) {
    if (String(allowedValue).toLowerCase() === trimmed.toLowerCase()) {
      return String(allowedValue);
    }
  }

  return '';
}

function isSafeBranchName(branchName) {
  if (typeof branchName !== 'string') {
    return false;
  }

  const trimmedBranch = branchName.trim();
  if (!trimmedBranch || trimmedBranch.length > 128 || /[\0\r\n]/.test(trimmedBranch)) {
    return false;
  }

  if (
    !/^[A-Za-z0-9._/-]+$/.test(trimmedBranch)
    || trimmedBranch.includes('..')
    || trimmedBranch.includes('//')
    || trimmedBranch.includes('@{')
    || trimmedBranch.startsWith('/')
    || trimmedBranch.endsWith('/')
    || trimmedBranch.endsWith('.')
    || trimmedBranch.startsWith('-')
    || trimmedBranch.endsWith('.lock')
  ) {
    return false;
  }

  const segments = trimmedBranch.split('/');
  return !segments.some((segment) => !segment || segment.startsWith('.'));
}

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
    launchOnStartup: false,
    reopenLastWorkspace: true,
    minimizeToTray: false,
    notificationsEnabled: true,
    statusTimeFormat: 'system',
    defaultProjectPrefix: '',
    defaultProjectTemplate: 'blank',
    autoRefreshInterval: 2000,
    enableFileWatcher: true,
    recentProjectsLimit: 10,
    confirmDelete: true,
    accentColor: '#007acc',
    fontFamily: 'system',
    uiScale: 100,
    smoothScrolling: true,
    animationsEnabled: true,
    compactMode: false,
    showStatusBar: true,
    denseSidebar: false,
    reducedTransparency: false,
    highVisibilityFocus: false,
    editorPath: '',
    editorArgs: '',
    editorOpenMode: 'new-window',
    revealInExplorer: true,
    preserveEditorFocus: false,
    editorWordWrap: 'off',
    editorTabSize: 4,
    editorFormatOnOpen: false,
    editorTrimTrailingWhitespace: false,
    openReadme: true,
    createGitignore: true,
    terminalPath: '',
    terminalCwd: true,
    terminalAdmin: false,
    terminalFontSize: 13,
    terminalScrollback: 5000,
    terminalConfirmOnClose: true,
    terminalShellArgs: '',
    terminalUseLoginShell: false,
    gitPath: '',
    gitUsername: '',
    gitEmail: '',
    gitAutoInit: true,
    gitAutoFetch: false,
    gitPruneOnFetch: true,
    gitUsePullRebase: false,
    gitConfirmForcePush: true,
    gitAutoStash: false,
    gitFetchInterval: 5,
    gitSignCommits: false,
    gitRequireMessage: true,
    defaultBranch: 'main',
    autoUpdateExtensions: true,
    extensionRecommendations: true,
    extensionUpdateCheck: 'daily',
    extensionsAllowPrerelease: false,
    extensionsTrustMarketplaceOnly: true,
    extensionsAutoEnableWorkspaceRecommendations: true,
    maxWorkers: 4,
    hardwareAcceleration: true,
    cacheSize: 200,
    diagnosticsRetentionDays: 30,
    telemetryEnabled: false,
    crashReportingEnabled: true,
    smtpHost: 'smtp.gmail.com',
    smtpPort: 587,
    smtpUser: 'skillerious@gmail.com',
    smtpPass: 'qlpd ykfe bgec jxfv',
    reportRecipient: 'skillerious@gmail.com',
    safeModeOnStartup: false,
    startupTimeoutMs: 15000,
    backupRetentionDays: 14,
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
      if (parsed.username || parsed.password) {
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

  const updateChannel = coerceAllowedValue(input.updateChannel, ALLOWED_UPDATE_CHANNELS);
  if (updateChannel) {
    result.updateChannel = updateChannel;
  }

  const terminalApp = coerceAllowedValue(input.terminalApp, ALLOWED_TERMINAL_APPS);
  if (terminalApp) {
    result.terminalApp = terminalApp;
  }

  if (typeof input.showWelcome === 'boolean') {
    result.showWelcome = input.showWelcome;
  }

  if (typeof input.closeToTray === 'boolean') {
    result.closeToTray = input.closeToTray;
  }
  if (typeof input.launchOnStartup === 'boolean') {
    result.launchOnStartup = input.launchOnStartup;
  }
  if (typeof input.reopenLastWorkspace === 'boolean') {
    result.reopenLastWorkspace = input.reopenLastWorkspace;
  }
  if (typeof input.minimizeToTray === 'boolean') {
    result.minimizeToTray = input.minimizeToTray;
  }
  if (typeof input.notificationsEnabled === 'boolean') {
    result.notificationsEnabled = input.notificationsEnabled;
  }
  const statusTimeFormat = coerceAllowedValue(input.statusTimeFormat, ALLOWED_STATUS_TIME_FORMATS);
  if (statusTimeFormat) {
    result.statusTimeFormat = statusTimeFormat;
  }
  result.defaultProjectPrefix = sanitizeText(input.defaultProjectPrefix, defaults.defaultProjectPrefix, 64);
  const defaultProjectTemplate = coerceAllowedValue(input.defaultProjectTemplate, ALLOWED_DEFAULT_PROJECT_TEMPLATES);
  if (defaultProjectTemplate) {
    result.defaultProjectTemplate = defaultProjectTemplate;
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
  if (typeof input.compactMode === 'boolean') {
    result.compactMode = input.compactMode;
  }
  if (typeof input.showStatusBar === 'boolean') {
    result.showStatusBar = input.showStatusBar;
  }
  if (typeof input.denseSidebar === 'boolean') {
    result.denseSidebar = input.denseSidebar;
  }
  if (typeof input.reducedTransparency === 'boolean') {
    result.reducedTransparency = input.reducedTransparency;
  }
  if (typeof input.highVisibilityFocus === 'boolean') {
    result.highVisibilityFocus = input.highVisibilityFocus;
  }

  result.editorPath = sanitizePath(input.editorPath, defaults.editorPath);
  result.editorArgs = sanitizeText(input.editorArgs, defaults.editorArgs, 512);
  const editorOpenMode = coerceAllowedValue(input.editorOpenMode, ALLOWED_EDITOR_OPEN_MODES);
  if (editorOpenMode) {
    result.editorOpenMode = editorOpenMode;
  }
  if (typeof input.revealInExplorer === 'boolean') {
    result.revealInExplorer = input.revealInExplorer;
  }
  if (typeof input.preserveEditorFocus === 'boolean') {
    result.preserveEditorFocus = input.preserveEditorFocus;
  }
  const editorWordWrap = coerceAllowedValue(input.editorWordWrap, ALLOWED_EDITOR_WORD_WRAP);
  if (editorWordWrap) {
    result.editorWordWrap = editorWordWrap;
  }
  result.editorTabSize = clampNumber(input.editorTabSize, 2, 8, defaults.editorTabSize);
  if (typeof input.editorFormatOnOpen === 'boolean') {
    result.editorFormatOnOpen = input.editorFormatOnOpen;
  }
  if (typeof input.editorTrimTrailingWhitespace === 'boolean') {
    result.editorTrimTrailingWhitespace = input.editorTrimTrailingWhitespace;
  }
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
  result.terminalFontSize = clampNumber(input.terminalFontSize, 10, 24, defaults.terminalFontSize);
  result.terminalScrollback = clampNumber(input.terminalScrollback, 500, 100000, defaults.terminalScrollback);
  if (typeof input.terminalConfirmOnClose === 'boolean') {
    result.terminalConfirmOnClose = input.terminalConfirmOnClose;
  }
  result.terminalShellArgs = sanitizeText(input.terminalShellArgs, defaults.terminalShellArgs, 256);
  if (typeof input.terminalUseLoginShell === 'boolean') {
    result.terminalUseLoginShell = input.terminalUseLoginShell;
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
  if (typeof input.gitPruneOnFetch === 'boolean') {
    result.gitPruneOnFetch = input.gitPruneOnFetch;
  }
  if (typeof input.gitUsePullRebase === 'boolean') {
    result.gitUsePullRebase = input.gitUsePullRebase;
  }
  if (typeof input.gitConfirmForcePush === 'boolean') {
    result.gitConfirmForcePush = input.gitConfirmForcePush;
  }
  if (typeof input.gitAutoStash === 'boolean') {
    result.gitAutoStash = input.gitAutoStash;
  }
  result.gitFetchInterval = clampNumber(input.gitFetchInterval, 1, 120, defaults.gitFetchInterval);
  if (typeof input.gitSignCommits === 'boolean') {
    result.gitSignCommits = input.gitSignCommits;
  }
  if (typeof input.gitRequireMessage === 'boolean') {
    result.gitRequireMessage = input.gitRequireMessage;
  }

  const branchCandidate = sanitizeText(input.defaultBranch, defaults.defaultBranch, 128);
  if (isSafeBranchName(branchCandidate)) {
    result.defaultBranch = branchCandidate;
  }

  if (typeof input.extensionRecommendations === 'boolean') {
    result.extensionRecommendations = input.extensionRecommendations;
  }
  if (typeof input.extensionsAllowPrerelease === 'boolean') {
    result.extensionsAllowPrerelease = input.extensionsAllowPrerelease;
  }
  if (typeof input.extensionsTrustMarketplaceOnly === 'boolean') {
    result.extensionsTrustMarketplaceOnly = input.extensionsTrustMarketplaceOnly;
  }
  if (typeof input.extensionsAutoEnableWorkspaceRecommendations === 'boolean') {
    result.extensionsAutoEnableWorkspaceRecommendations = input.extensionsAutoEnableWorkspaceRecommendations;
  }

  result.maxWorkers = clampNumber(input.maxWorkers, 1, 16, defaults.maxWorkers);
  if (typeof input.hardwareAcceleration === 'boolean') {
    result.hardwareAcceleration = input.hardwareAcceleration;
  }
  result.cacheSize = clampNumber(input.cacheSize, 50, 1000, defaults.cacheSize);
  result.diagnosticsRetentionDays = clampNumber(input.diagnosticsRetentionDays, 1, 365, defaults.diagnosticsRetentionDays);
  if (typeof input.telemetryEnabled === 'boolean') {
    result.telemetryEnabled = input.telemetryEnabled;
  }
  if (typeof input.crashReportingEnabled === 'boolean') {
    result.crashReportingEnabled = input.crashReportingEnabled;
  }
  if (typeof input.smtpHost === 'string' && input.smtpHost.trim()) {
    result.smtpHost = input.smtpHost.trim().slice(0, 253);
  }
  result.smtpPort = clampNumber(input.smtpPort, 1, 65535, defaults.smtpPort);
  if (typeof input.smtpUser === 'string') {
    result.smtpUser = input.smtpUser.trim().slice(0, 320);
  }
  if (typeof input.smtpPass === 'string') {
    result.smtpPass = input.smtpPass.slice(0, 256);
  }
  if (typeof input.reportRecipient === 'string' && input.reportRecipient.trim()) {
    result.reportRecipient = input.reportRecipient.trim().slice(0, 320);
  }
  if (typeof input.safeModeOnStartup === 'boolean') {
    result.safeModeOnStartup = input.safeModeOnStartup;
  }
  result.startupTimeoutMs = clampNumber(input.startupTimeoutMs, 2000, 120000, defaults.startupTimeoutMs);
  result.backupRetentionDays = clampNumber(input.backupRetentionDays, 1, 90, defaults.backupRetentionDays);
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
    coerceAllowedValue(input.extensionUpdateCheck, ALLOWED_EXTENSION_UPDATE_INTERVALS)
    || coerceAllowedValue(inputExtensions.updateCheckInterval, ALLOWED_EXTENSION_UPDATE_INTERVALS)
    || defaults.extensions.updateCheckInterval;

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

  // Legacy unencrypted token — accepted only as a migration fallback.
  // Users should re-authenticate so the token is stored via safeStorage.
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
    result._legacyTokenWarning = 'GitHub token is stored in plaintext. Re-authenticate to upgrade to encrypted storage.';
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
  delete safeSettings.smtpPass;
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
