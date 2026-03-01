const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, dialog, shell, clipboard, globalShortcut, safeStorage, session } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const { exec, execFile, spawn } = require('child_process');
const { fileURLToPath } = require('url');
const os = require('os');
const crypto = require('crypto');
const chokidar = require('chokidar');
const {
  validateGitPath,
  validateGitRefName,
  validateGitHash,
  validateGitRemoteName,
  validateGitRemoteUrl,
  validateGitFilePathInput,
  parseAllowedRunCommand,
  validateCommandWorkingDirectory
} = require('./security-utils');
const {
  validateProductKey,
  maskProductKey,
  normalizeProductKey,
  extractKeyMetadata,
  getLicenseSecret,
  VALID_TIERS
} = require('./license-utils');
const { UpdateManager } = require('./main/update-manager');
const { WorkspaceServices } = require('./main/workspace-services');
const { OperationQueue } = require('./main/operation-queue');

let mainWindow;
let splashWindow;
let tray = null;
let projectsBasePath = path.join(os.homedir(), 'Projects');
let fileWatchers = new Map(); // Track active file watchers per project
let gitOperationHistory = []; // For undo/redo functionality
let allowRendererConfirmedClose = false;
let pendingRendererCloseRequest = false;
let closeRequestTimeout = null;
let forceAppQuit = false;
const MAX_HISTORY = 50;

let appSettings = buildDefaultAppSettings(projectsBasePath);

const packageVersion = (() => {
  try {
    return require('./package.json').version || '1.0.0';
  } catch {
    return '1.0.0';
  }
})();

let appVersionInfo = {
  version: packageVersion,
  displayVersion: `v${packageVersion}`,
  channel: 'stable'
};
let cachedVsCodeLauncher = null;
const LICENSE_FILE_NAME = 'license.dat';
const LICENSE_FALLBACK_SALT = 'appmanager-pro-license-fallback-v1';
let licenseState = {
  isProUnlocked: false,
  normalizedKey: '',
  maskedKey: '',
  registeredAt: null,
  tier: null,
  tierCode: null,
  isLegacy: false,
  fingerprintMatch: null,
  graceExpiresAt: null
};

const RATE_LIMIT_COOLDOWNS = [1000, 3000, 7000, 15000, 30000, 60000];
const RATE_LIMIT_MAX_FAILURES = 10;
const RATE_LIMIT_LOCKOUT_DURATION = 5 * 60 * 1000;
const RATE_LIMIT_RESET_WINDOW_MS = 15 * 60 * 1000;
const GRACE_PERIOD_DAYS = 7;
const MAX_AUDIT_ENTRIES = 20;
const MAX_LICENSE_FILE_SIZE_BYTES = 64 * 1024;
const MAX_REGISTRATION_KEY_INPUT_LENGTH = 512;
const LOAD_AUDIT_MIN_INTERVAL_MS = 5 * 60 * 1000;
const GITHUB_TOKEN_ENCRYPTED_KEY = 'githubTokenEncrypted';
const GITHUB_TOKEN_LEGACY_KEY = 'githubToken';
const GITHUB_REQUEST_TIMEOUT_MS = 15000;
const GIT_PUSH_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_GITHUB_UPLOAD_CANDIDATES = 12000;
const MAX_GITHUB_UPLOAD_DEPTH = 24;
const GITHUB_UPLOAD_STAGE_CHUNK_SIZE = 120;
const GITHUB_UPLOAD_TEMP_PREFIX = 'project-manager-github-upload-';
const GITHUB_UPLOAD_HARD_EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.parcel-cache'
]);
const MAX_SETTINGS_FILE_SIZE_BYTES = 1024 * 1024;
const MAX_SETTINGS_PATH_LENGTH = 4096;
const MAX_SETTINGS_ARRAY_ITEMS = 200;
const MAX_SETTINGS_KEY_LENGTH = 100;
const MAX_SETTINGS_VALUE_STRING_LENGTH = 8192;
const MAX_SETTINGS_OBJECT_DEPTH = 6;
const MAX_SETTINGS_OBJECT_KEYS = 1000;
const COMMAND_MAX_BUFFER_BYTES = 1024 * 1024 * 5;
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

function sanitizeAppSettings(input, fallbackProjectPath = projectsBasePath) {
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

let registrationRateLimit = {
  failureCount: 0,
  lastFailureTime: 0,
  lockedUntil: 0
};
let sessionSecurityPoliciesInstalled = false;

const PRO_IPC_CHANNELS = new Set([
  'init-git',
  'git-status',
  'git-commit',
  'git-pull',
  'git-push',
  'git-fetch',
  'git-sync',
  'git-branches',
  'git-create-branch',
  'git-checkout',
  'git-delete-branch',
  'git-stash',
  'git-stash-list',
  'git-stash-apply',
  'git-stash-pop',
  'git-diff',
  'git-diff-hunks',
  'git-apply-hunks',
  'git-log',
  'git-remote-list',
  'git-add-remote',
  'git-remove-remote',
  'git-merge',
  'git-list-conflicts',
  'git-resolve-conflict',
  'git-abort-merge',
  'git-continue-merge',
  'git-rebase',
  'git-cherry-pick',
  'git-tag-list',
  'git-tag-create',
  'git-tag-delete',
  'git-reset',
  'git-revert',
  'git-clean',
  'clone-repository',
  'undo-last-operation',
  'get-operation-history',
  'get-installed-extensions',
  'install-extension',
  'uninstall-extension',
  'enable-extension',
  'disable-extension',
  'get-extension-settings',
  'save-extension-settings',
  'download-theme'
]);

const PRO_QUEUE_OPERATION_TYPES = new Set([
  'clone-repository',
  'export-project',
  'github-upload-project'
]);

const originalIpcMainHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => {
  if (!PRO_IPC_CHANNELS.has(channel)) {
    return originalIpcMainHandle(channel, listener);
  }

  return originalIpcMainHandle(channel, async (event, ...args) => {
    if (!licenseState.isProUnlocked) {
      return {
        success: false,
        error: 'This feature requires Pro. Register your product key in Help > Register Product.'
      };
    }

    return listener(event, ...args);
  });
};

async function loadAppVersionInfo() {
  const versionFilePath = path.join(__dirname, 'version.json');

  try {
    const rawContent = await fs.readFile(versionFilePath, 'utf-8');
    const parsed = JSON.parse(rawContent);

    if (parsed && typeof parsed.version === 'string' && parsed.version.trim()) {
      const normalizedVersion = parsed.version.trim();
      appVersionInfo = {
        version: normalizedVersion,
        displayVersion: typeof parsed.displayVersion === 'string' && parsed.displayVersion.trim()
          ? parsed.displayVersion.trim()
          : `v${normalizedVersion}`,
        channel: typeof parsed.channel === 'string' && parsed.channel.trim()
          ? parsed.channel.trim()
          : 'stable'
      };
      return;
    }
  } catch (error) {
    console.warn('Failed to load version.json, falling back to package version:', error.message);
  }

  appVersionInfo = {
    version: packageVersion,
    displayVersion: `v${packageVersion}`,
    channel: 'stable'
  };
}

function getAppVersionInfo() {
  return { ...appVersionInfo };
}

function getLicenseFilePath() {
  return path.join(app.getPath('userData'), LICENSE_FILE_NAME);
}

function getFallbackLicenseEncryptionKey() {
  let username = 'unknown';

  try {
    username = os.userInfo().username || 'unknown';
  } catch {
    // Ignore and keep fallback username.
  }

  const keyMaterial = [
    app.getName(),
    os.hostname(),
    username,
    process.arch,
    app.getPath('userData')
  ].join('|');

  return crypto.scryptSync(keyMaterial, LICENSE_FALLBACK_SALT, 32);
}

function encryptLicensePayload(payload) {
  const serializedPayload = JSON.stringify(payload);

  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(serializedPayload);
    return {
      scheme: 'safe-storage-v1',
      data: encrypted.toString('base64')
    };
  }

  const key = getFallbackLicenseEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encryptedData = Buffer.concat([cipher.update(serializedPayload, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    scheme: 'aes-256-gcm-v1',
    iv: iv.toString('base64'),
    tag: authTag.toString('base64'),
    data: encryptedData.toString('base64')
  };
}

function decryptLicensePayload(encryptedPayload) {
  if (!encryptedPayload || typeof encryptedPayload !== 'object') {
    throw new Error('License payload is malformed.');
  }

  if (encryptedPayload.scheme === 'safe-storage-v1') {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure storage is not available on this machine.');
    }

    const decrypted = safeStorage.decryptString(Buffer.from(encryptedPayload.data, 'base64'));
    return JSON.parse(decrypted);
  }

  if (encryptedPayload.scheme === 'aes-256-gcm-v1') {
    const key = getFallbackLicenseEncryptionKey();
    const iv = Buffer.from(encryptedPayload.iv, 'base64');
    const authTag = Buffer.from(encryptedPayload.tag, 'base64');
    const encryptedData = Buffer.from(encryptedPayload.data, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);

    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]).toString('utf8');
    return JSON.parse(decrypted);
  }

  throw new Error('Unknown license encryption scheme.');
}

function generateMachineFingerprint() {
  let username = 'unknown';
  try {
    username = os.userInfo().username || 'unknown';
  } catch {
    // Ignore and keep fallback username.
  }

  const components = {
    hostname: os.hostname(),
    username,
    arch: process.arch,
    cpuModel: (os.cpus()[0] || {}).model || 'unknown',
    totalMemoryGB: Math.round(os.totalmem() / (1024 * 1024 * 1024))
  };

  const raw = [
    components.hostname,
    components.username,
    components.arch,
    components.cpuModel,
    String(components.totalMemoryGB)
  ].join('|');

  const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
  return { hash, components };
}

function computeFingerprintMatchScore(stored, current) {
  if (!stored || !current) {
    return 0;
  }
  let score = 0;
  if (stored.hostname === current.hostname) score++;
  if (stored.username === current.username) score++;
  if (stored.arch === current.arch) score++;
  if (stored.cpuModel === current.cpuModel) score++;
  if (stored.totalMemoryGB === current.totalMemoryGB) score++;
  return score;
}

function checkRegistrationRateLimit() {
  const now = Date.now();

  if (registrationRateLimit.lockedUntil > 0 && registrationRateLimit.lockedUntil <= now) {
    resetRegistrationRateLimit();
  }

  if (
    registrationRateLimit.failureCount > 0 &&
    registrationRateLimit.lastFailureTime > 0 &&
    now - registrationRateLimit.lastFailureTime >= RATE_LIMIT_RESET_WINDOW_MS
  ) {
    resetRegistrationRateLimit();
  }

  if (registrationRateLimit.lockedUntil > now) {
    const remainingSec = Math.ceil((registrationRateLimit.lockedUntil - now) / 1000);
    return {
      allowed: false,
      error: `Too many failed attempts. Try again in ${remainingSec} seconds.`,
      retryAfterMs: registrationRateLimit.lockedUntil - now
    };
  }

  if (registrationRateLimit.failureCount > 0) {
    const cooldownIndex = Math.min(registrationRateLimit.failureCount - 1, RATE_LIMIT_COOLDOWNS.length - 1);
    const cooldownMs = RATE_LIMIT_COOLDOWNS[cooldownIndex];
    const elapsed = now - registrationRateLimit.lastFailureTime;
    if (elapsed < cooldownMs) {
      const remainingSec = Math.ceil((cooldownMs - elapsed) / 1000);
      return {
        allowed: false,
        error: `Please wait ${remainingSec} seconds before trying again.`,
        retryAfterMs: cooldownMs - elapsed
      };
    }
  }

  return { allowed: true };
}

function recordRegistrationFailure() {
  registrationRateLimit.failureCount++;
  registrationRateLimit.lastFailureTime = Date.now();

  if (registrationRateLimit.failureCount >= RATE_LIMIT_MAX_FAILURES) {
    registrationRateLimit.lockedUntil = Date.now() + RATE_LIMIT_LOCKOUT_DURATION;
  }
}

function resetRegistrationRateLimit() {
  registrationRateLimit = { failureCount: 0, lastFailureTime: 0, lockedUntil: 0 };
}

function createAuditEntry(action, success, fingerprint) {
  return {
    timestamp: new Date().toISOString(),
    action,
    success,
    fingerprint: fingerprint ? fingerprint.hash : null
  };
}

function appendAuditEntry(auditLog, entry) {
  const log = Array.isArray(auditLog) ? [...auditLog] : [];
  log.push(entry);
  while (log.length > MAX_AUDIT_ENTRIES) {
    log.shift();
  }
  return log;
}

function computePayloadIntegrityHmac(encryptedPayloadJson) {
  const secret = getLicenseSecret();
  return crypto.createHmac('sha256', secret).update(encryptedPayloadJson).digest('hex');
}

function isValidIsoTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function safeStringEquals(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') {
    return false;
  }

  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function validateMachineFingerprintPayload(machineFingerprint) {
  if (!machineFingerprint || typeof machineFingerprint !== 'object' || Array.isArray(machineFingerprint)) {
    return { valid: false, error: 'License file contains an invalid machine fingerprint.' };
  }

  if (typeof machineFingerprint.hash !== 'string' || !/^[a-f0-9]{32}$/i.test(machineFingerprint.hash)) {
    return { valid: false, error: 'License file contains an invalid machine fingerprint hash.' };
  }

  const components = machineFingerprint.components;
  if (!components || typeof components !== 'object' || Array.isArray(components)) {
    return { valid: false, error: 'License file contains invalid fingerprint components.' };
  }

  if (
    typeof components.hostname !== 'string' ||
    typeof components.username !== 'string' ||
    typeof components.arch !== 'string' ||
    typeof components.cpuModel !== 'string' ||
    !Number.isFinite(components.totalMemoryGB)
  ) {
    return { valid: false, error: 'License file contains malformed fingerprint components.' };
  }

  return { valid: true };
}

function validateGracePeriodPayload(gracePeriod) {
  if (!gracePeriod || typeof gracePeriod !== 'object' || Array.isArray(gracePeriod)) {
    return { valid: false, error: 'License file contains an invalid grace period.' };
  }

  if (!isValidIsoTimestamp(gracePeriod.startedAt) || !isValidIsoTimestamp(gracePeriod.expiresAt)) {
    return { valid: false, error: 'License file contains an invalid grace period date.' };
  }

  const startedAtMs = Date.parse(gracePeriod.startedAt);
  const expiresAtMs = Date.parse(gracePeriod.expiresAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= startedAtMs) {
    return { valid: false, error: 'License file contains inconsistent grace period dates.' };
  }

  if (gracePeriod.reason != null && (typeof gracePeriod.reason !== 'string' || gracePeriod.reason.length > 128)) {
    return { valid: false, error: 'License file contains an invalid grace period reason.' };
  }

  if (gracePeriod.matchScore != null) {
    if (!Number.isInteger(gracePeriod.matchScore) || gracePeriod.matchScore < 0 || gracePeriod.matchScore > 5) {
      return { valid: false, error: 'License file contains an invalid grace period score.' };
    }
  }

  return { valid: true };
}

function validateAuditLogPayload(auditLog) {
  if (!Array.isArray(auditLog)) {
    return { valid: false, error: 'License file contains an invalid audit log.' };
  }

  if (auditLog.length > 1000) {
    return { valid: false, error: 'License file audit log is too large.' };
  }

  for (const entry of auditLog) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { valid: false, error: 'License file contains an invalid audit entry.' };
    }

    if (!isValidIsoTimestamp(entry.timestamp)) {
      return { valid: false, error: 'License file contains an invalid audit timestamp.' };
    }

    if (typeof entry.action !== 'string' || !entry.action.trim() || entry.action.length > 64) {
      return { valid: false, error: 'License file contains an invalid audit action.' };
    }

    if (typeof entry.success !== 'boolean') {
      return { valid: false, error: 'License file contains an invalid audit status.' };
    }

    if (entry.fingerprint != null) {
      if (typeof entry.fingerprint !== 'string' || !/^[a-f0-9]{32}$/i.test(entry.fingerprint)) {
        return { valid: false, error: 'License file contains an invalid audit fingerprint.' };
      }
    }
  }

  return { valid: true };
}

function validateLicensePayloadShape(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, error: 'License payload is malformed.' };
  }

  if (typeof payload.productKey !== 'string' || payload.productKey.length > 64) {
    return { valid: false, error: 'License payload does not contain a valid product key.' };
  }

  if (payload.registeredAt != null && !isValidIsoTimestamp(payload.registeredAt)) {
    return { valid: false, error: 'License payload contains an invalid registration date.' };
  }

  if (payload.createdAt != null && !isValidIsoTimestamp(payload.createdAt)) {
    return { valid: false, error: 'License payload contains an invalid creation date.' };
  }

  if (payload.version != null && payload.version !== 1 && payload.version !== 2) {
    return { valid: false, error: 'License payload has an unsupported version.' };
  }

  if (payload.tier != null) {
    if (typeof payload.tier !== 'string' || !Object.values(VALID_TIERS).includes(payload.tier)) {
      return { valid: false, error: 'License payload contains an invalid tier.' };
    }
  }

  if (payload.tierCode != null) {
    if (typeof payload.tierCode !== 'string' || !VALID_TIERS[payload.tierCode]) {
      return { valid: false, error: 'License payload contains an invalid tier code.' };
    }
  }

  if (payload.machineFingerprint != null) {
    const machineValidation = validateMachineFingerprintPayload(payload.machineFingerprint);
    if (!machineValidation.valid) {
      return machineValidation;
    }
  }

  if (payload.gracePeriod != null) {
    const graceValidation = validateGracePeriodPayload(payload.gracePeriod);
    if (!graceValidation.valid) {
      return graceValidation;
    }
  }

  if (payload.auditLog != null) {
    const auditValidation = validateAuditLogPayload(payload.auditLog);
    if (!auditValidation.valid) {
      return auditValidation;
    }
  }

  return { valid: true };
}

function shouldAppendLoadAudit(auditLog, fingerprintHash) {
  if (!Array.isArray(auditLog) || auditLog.length === 0) {
    return true;
  }

  for (let i = auditLog.length - 1; i >= 0; i -= 1) {
    const entry = auditLog[i];
    if (!entry || entry.action !== 'load') {
      continue;
    }

    if (entry.fingerprint && fingerprintHash && entry.fingerprint !== fingerprintHash) {
      return true;
    }

    const timestampMs = Date.parse(entry.timestamp);
    if (!Number.isFinite(timestampMs)) {
      return true;
    }

    return Date.now() - timestampMs >= LOAD_AUDIT_MIN_INTERVAL_MS;
  }

  return true;
}

async function saveLicensePayload(payload) {
  const encryptedPayload = encryptLicensePayload(payload);
  const encryptedJson = JSON.stringify(encryptedPayload);
  const integrity = computePayloadIntegrityHmac(encryptedJson);
  const fileContent = { formatVersion: 2, payload: encryptedPayload, integrity };
  await fs.writeFile(getLicenseFilePath(), JSON.stringify(fileContent, null, 2), 'utf8');
}

async function updateAuditLogInFile(payload, newEntry) {
  try {
    payload.auditLog = appendAuditEntry(payload.auditLog, newEntry);
    await saveLicensePayload(payload);
  } catch (err) {
    console.warn('Failed to update audit log:', err.message);
  }
}

function resetLicenseState() {
  licenseState = {
    isProUnlocked: false,
    normalizedKey: '',
    maskedKey: '',
    registeredAt: null,
    tier: null,
    tierCode: null,
    isLegacy: false,
    fingerprintMatch: null,
    graceExpiresAt: null
  };
}

function updateLicenseStateFromKey(normalizedKey, registeredAt = null) {
  const normalized = normalizeProductKey(normalizedKey);
  const metadata = extractKeyMetadata(normalized);

  licenseState = {
    isProUnlocked: normalized.length === 16,
    normalizedKey: normalized,
    maskedKey: maskProductKey(normalized),
    registeredAt: typeof registeredAt === 'string' && registeredAt.trim()
      ? registeredAt.trim()
      : new Date().toISOString(),
    tier: metadata.tierName || 'pro',
    tierCode: metadata.tierCode || null,
    isLegacy: metadata.isLegacy,
    fingerprintMatch: licenseState.fingerprintMatch,
    graceExpiresAt: licenseState.graceExpiresAt
  };
}

function updateLicenseStateFromPayload(normalizedKey, registeredAt, metadata, fingerprint) {
  const normalized = normalizeProductKey(normalizedKey);

  licenseState = {
    isProUnlocked: normalized.length === 16,
    normalizedKey: normalized,
    maskedKey: maskProductKey(normalized),
    registeredAt: typeof registeredAt === 'string' && registeredAt.trim()
      ? registeredAt.trim()
      : new Date().toISOString(),
    tier: metadata ? metadata.tierName : 'pro',
    tierCode: metadata ? metadata.tierCode : null,
    isLegacy: metadata ? metadata.isLegacy : true,
    fingerprintMatch: licenseState.fingerprintMatch || (fingerprint ? true : null),
    graceExpiresAt: licenseState.graceExpiresAt || null
  };
}

function getLicenseStatus() {
  return {
    isProUnlocked: Boolean(licenseState.isProUnlocked),
    maskedKey: licenseState.maskedKey || '',
    registeredAt: licenseState.registeredAt || null,
    tier: licenseState.tier || null,
    tierCode: licenseState.tierCode || null,
    isLegacy: Boolean(licenseState.isLegacy),
    fingerprintMatch: licenseState.fingerprintMatch,
    graceExpiresAt: licenseState.graceExpiresAt
  };
}

async function loadLicenseState() {
  resetLicenseState();

  let rawContent;
  try {
    rawContent = await fs.readFile(getLicenseFilePath(), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('Failed to read license file:', error.message);
    }
    return;
  }

  try {
    if (Buffer.byteLength(rawContent, 'utf8') > MAX_LICENSE_FILE_SIZE_BYTES) {
      throw new Error('License file is too large.');
    }

    const parsed = JSON.parse(rawContent);

    // Detect format: old (has .scheme) vs new (has .payload)
    let encryptedPayload;
    if (parsed.formatVersion === 2 && parsed.payload) {
      if (typeof parsed.integrity !== 'string' || !/^[a-f0-9]{64}$/i.test(parsed.integrity)) {
        throw new Error('License file integrity metadata is invalid.');
      }
      const normalizedIntegrity = parsed.integrity.toLowerCase();
      const expectedIntegrity = computePayloadIntegrityHmac(JSON.stringify(parsed.payload));
      if (!safeStringEquals(normalizedIntegrity, expectedIntegrity)) {
        throw new Error('License file integrity check failed. File may have been tampered with.');
      }
      encryptedPayload = parsed.payload;
    } else if (parsed.scheme) {
      encryptedPayload = parsed;
    } else {
      throw new Error('Unrecognized license file format.');
    }

    const payload = decryptLicensePayload(encryptedPayload);
    const payloadValidation = validateLicensePayloadShape(payload);
    if (!payloadValidation.valid) {
      throw new Error(payloadValidation.error);
    }

    if (!payload || typeof payload.productKey !== 'string') {
      throw new Error('License file does not contain a product key.');
    }

    const validation = validateProductKey(payload.productKey);
    if (!validation.valid) {
      throw new Error(validation.error || 'Stored product key is invalid.');
    }

    // Machine fingerprint verification (v2 payloads only)
    if (payload.version === 2 && payload.machineFingerprint) {
      const currentFp = generateMachineFingerprint();

      if (currentFp.hash !== payload.machineFingerprint.hash) {
        const score = computeFingerprintMatchScore(
          payload.machineFingerprint.components,
          currentFp.components
        );

        if (score >= 3) {
          const now = new Date();

          if (payload.gracePeriod && payload.gracePeriod.expiresAt) {
            const expiresAt = new Date(payload.gracePeriod.expiresAt);
            if (now > expiresAt) {
              const auditEntry = createAuditEntry('fingerprint-mismatch', false, currentFp);
              await updateAuditLogInFile(payload, auditEntry);
              throw new Error('Machine fingerprint changed and grace period has expired. Please re-register.');
            }
            licenseState.fingerprintMatch = 'grace';
            licenseState.graceExpiresAt = payload.gracePeriod.expiresAt;
          } else {
            const expiresAt = new Date(now.getTime() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
            payload.gracePeriod = {
              startedAt: now.toISOString(),
              expiresAt: expiresAt.toISOString(),
              reason: 'partial-fingerprint-mismatch',
              matchScore: score
            };
            payload.auditLog = appendAuditEntry(payload.auditLog, createAuditEntry('grace-period', true, currentFp));
            try {
              await saveLicensePayload(payload);
            } catch (saveError) {
              console.warn('Failed to persist grace period state:', saveError.message);
            }
            licenseState.fingerprintMatch = 'grace';
            licenseState.graceExpiresAt = expiresAt.toISOString();
          }
        } else {
          const auditEntry = createAuditEntry('fingerprint-mismatch', false, currentFp);
          await updateAuditLogInFile(payload, auditEntry);
          throw new Error('License is bound to a different machine. Please re-register.');
        }
      } else {
        licenseState.fingerprintMatch = true;
        licenseState.graceExpiresAt = null;

        if (payload.gracePeriod) {
          payload.gracePeriod = null;
          payload.auditLog = appendAuditEntry(payload.auditLog, createAuditEntry('fingerprint-recovered', true, currentFp));
          try {
            await saveLicensePayload(payload);
          } catch (saveError) {
            console.warn('Failed to clear grace period after fingerprint recovery:', saveError.message);
          }
        }
      }
    }

    const metadata = validation.metadata;
    updateLicenseStateFromPayload(validation.normalizedKey, payload.registeredAt, metadata, null);

    // Append load audit entry for v2 payloads
    if (payload.version === 2) {
      const currentFp = generateMachineFingerprint();
      if (shouldAppendLoadAudit(payload.auditLog, currentFp.hash)) {
        await updateAuditLogInFile(payload, createAuditEntry('load', true, currentFp));
      }
    }
  } catch (error) {
    resetLicenseState();
    console.warn('Failed to load license state:', error.message);
  }
}

async function registerProductKey(rawProductKey) {
  // Rate limit check
  const rateCheck = checkRegistrationRateLimit();
  if (!rateCheck.allowed) {
    return {
      success: false,
      error: rateCheck.error,
      retryAfterMs: rateCheck.retryAfterMs
    };
  }

  if (typeof rawProductKey !== 'string' || !rawProductKey.trim()) {
    recordRegistrationFailure();
    return {
      success: false,
      error: 'Enter a product key.',
      failureCount: registrationRateLimit.failureCount
    };
  }

  if (rawProductKey.length > MAX_REGISTRATION_KEY_INPUT_LENGTH) {
    recordRegistrationFailure();
    return {
      success: false,
      error: 'Product key input is too long.',
      failureCount: registrationRateLimit.failureCount
    };
  }

  const validation = validateProductKey(rawProductKey);

  if (!validation.valid) {
    recordRegistrationFailure();
    return {
      success: false,
      error: validation.error || 'Invalid product key.',
      failureCount: registrationRateLimit.failureCount
    };
  }

  if (
    licenseState.isProUnlocked &&
    licenseState.normalizedKey === validation.normalizedKey &&
    licenseState.fingerprintMatch === true
  ) {
    resetRegistrationRateLimit();
    return {
      success: true,
      status: getLicenseStatus(),
      alreadyRegistered: true
    };
  }

  const fingerprint = generateMachineFingerprint();
  const metadata = validation.metadata;
  const registeredAt = new Date().toISOString();
  const auditLog = [createAuditEntry('register', true, fingerprint)];

  const payload = {
    productKey: validation.normalizedKey,
    registeredAt,
    createdAt: registeredAt,
    version: 2,
    tier: metadata.tierName,
    tierCode: metadata.tierCode,
    machineFingerprint: { hash: fingerprint.hash, components: fingerprint.components },
    gracePeriod: null,
    auditLog
  };

  try {
    await saveLicensePayload(payload);
    licenseState.fingerprintMatch = true;
    licenseState.graceExpiresAt = null;
    updateLicenseStateFromPayload(validation.normalizedKey, registeredAt, metadata, fingerprint);
    resetRegistrationRateLimit();

    return {
      success: true,
      status: getLicenseStatus()
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to store product key: ${error.message}`
    };
  }
}

function getVsCodeLaunchCandidates() {
  const candidates = [];

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    const programFiles = process.env.ProgramFiles;
    const programFilesX86 = process.env['ProgramFiles(x86)'];

    [
      localAppData && path.join(localAppData, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
      programFiles && path.join(programFiles, 'Microsoft VS Code', 'bin', 'code.cmd'),
      programFilesX86 && path.join(programFilesX86, 'Microsoft VS Code', 'bin', 'code.cmd'),
      localAppData && path.join(localAppData, 'Programs', 'Microsoft VS Code Insiders', 'bin', 'code-insiders.cmd'),
      programFiles && path.join(programFiles, 'Microsoft VS Code Insiders', 'bin', 'code-insiders.cmd'),
      programFilesX86 && path.join(programFilesX86, 'Microsoft VS Code Insiders', 'bin', 'code-insiders.cmd')
    ]
      .filter(Boolean)
      .forEach((candidatePath) => {
        candidates.push({ command: candidatePath, requiresAbsolutePath: true });
      });

    candidates.push({ command: 'code.cmd' });
    candidates.push({ command: 'code' });
  } else if (process.platform === 'darwin') {
    candidates.push({ command: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', requiresAbsolutePath: true });
    candidates.push({ command: '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code', requiresAbsolutePath: true });
    candidates.push({ command: 'code' });
    candidates.push({ command: 'code-insiders' });
  } else {
    candidates.push({ command: '/usr/bin/code', requiresAbsolutePath: true });
    candidates.push({ command: '/snap/bin/code', requiresAbsolutePath: true });
    candidates.push({ command: 'code' });
    candidates.push({ command: 'code-insiders' });
  }

  return candidates;
}

function quoteWindowsShellArg(value) {
  return `"${String(value).replace(/"/g, '""').replace(/%/g, '%%')}"`;
}

function buildWindowsCommandLine(commandConfig, args = []) {
  const shouldQuoteCommand = commandConfig.requiresAbsolutePath || /\s/.test(commandConfig.command);
  const commandToken = shouldQuoteCommand
    ? quoteWindowsShellArg(commandConfig.command)
    : commandConfig.command;
  const argTokens = args.map((arg) => quoteWindowsShellArg(arg));
  return [commandToken, ...argTokens].join(' ');
}

async function executeWindowsCommand(commandLine, timeout = 4000) {
  return new Promise((resolve) => {
    exec(commandLine, { windowsHide: true, timeout }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          success: false,
          error: (stderr && stderr.trim()) || error.message
        });
        return;
      }

      resolve({ success: true, stdout, stderr });
    });
  });
}

async function probeCommand(commandConfig, args = ['--version']) {
  if (commandConfig.requiresAbsolutePath) {
    try {
      await fs.access(commandConfig.command);
    } catch {
      return false;
    }
  }

  if (process.platform === 'win32') {
    const commandLine = buildWindowsCommandLine(commandConfig, args);
    const probeResult = await executeWindowsCommand(commandLine, 4000);
    return probeResult.success;
  }

  return new Promise((resolve) => {
    let settled = false;
    const commandProcess = spawn(commandConfig.command, args, {
      windowsHide: true,
      stdio: 'ignore'
    });

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        commandProcess.kill();
      } catch {
        // Ignore kill errors.
      }
      resolve(false);
    }, 4000);

    commandProcess.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(false);
    });

    commandProcess.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(code === 0);
    });
  });
}

async function resolveVsCodeLauncher(forceRefresh = false) {
  if (!forceRefresh && cachedVsCodeLauncher) {
    return cachedVsCodeLauncher;
  }

  const candidates = getVsCodeLaunchCandidates();
  for (const candidate of candidates) {
    if (await probeCommand(candidate)) {
      cachedVsCodeLauncher = candidate;
      return candidate;
    }
  }

  cachedVsCodeLauncher = null;
  return null;
}

async function openPathInVsCode(targetPath) {
  const launchers = [];
  const resolvedLauncher = await resolveVsCodeLauncher();

  if (resolvedLauncher) {
    launchers.push(resolvedLauncher);
  }

  const fallbackCandidates = getVsCodeLaunchCandidates();
  fallbackCandidates.forEach((candidate) => {
    if (!launchers.some((existing) => existing.command === candidate.command)) {
      launchers.push(candidate);
    }
  });

  for (const launcher of launchers) {
    if (launcher.requiresAbsolutePath) {
      try {
        await fs.access(launcher.command);
      } catch {
        continue;
      }
    }

    let launchResult;
    if (process.platform === 'win32') {
      const commandLine = buildWindowsCommandLine(launcher, [targetPath]);
      launchResult = await executeWindowsCommand(commandLine, 15000);
    } else {
      launchResult = await new Promise((resolve) => {
        const codeProcess = spawn(launcher.command, [targetPath], {
          windowsHide: true,
          stdio: 'ignore'
        });

        codeProcess.on('error', (error) => {
          resolve({ success: false, error: error.message });
        });

        codeProcess.on('close', (code) => {
          if (code === 0) {
            resolve({ success: true });
          } else {
            resolve({ success: false, error: `VS Code exited with code ${code}` });
          }
        });
      });
    }

    if (launchResult.success) {
      cachedVsCodeLauncher = launcher;
      return { success: true, launcher: launcher.command };
    }
  }

  return { success: false, error: 'VS Code not found. Install VS Code and ensure the "code" command is available.' };
}

// Advanced Logger System
class Logger {
  constructor() {
    this.logPath = null;
    this.currentLogFile = null;
    this.initialized = false;
  }

  async initializeLogger() {
    if (this.initialized) return;

    try {
      // Initialize log path (app must be ready)
      this.logPath = path.join(app.getPath('userData'), 'logs');
      await fs.mkdir(this.logPath, { recursive: true });
      const date = new Date().toISOString().split('T')[0];
      this.currentLogFile = path.join(this.logPath, `app-${date}.log`);
      this.initialized = true;
    } catch (error) {
      console.error('Failed to initialize logger:', error);
    }
  }

  async log(level, message, data = null) {
    // Ensure logger is initialized
    if (!this.initialized) {
      await this.initializeLogger();
    }

    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level,
      message,
      data
    };

    const logLine = `[${timestamp}] [${level.toUpperCase()}] ${message}${data ? ' | ' + JSON.stringify(data) : ''}\n`;

    // Console output
    if (level === 'error') {
      console.error(logLine);
    } else if (level === 'warn') {
      console.warn(logLine);
    } else {
      console.log(logLine);
    }

    // File output
    if (this.currentLogFile) {
      try {
        await fs.appendFile(this.currentLogFile, logLine);
      } catch (error) {
        console.error('Failed to write to log file:', error);
      }
    }
  }

  info(message, data) {
    return this.log('info', message, data);
  }

  warn(message, data) {
    return this.log('warn', message, data);
  }

  error(message, data) {
    return this.log('error', message, data);
  }

  debug(message, data) {
    return this.log('debug', message, data);
  }
}

const logger = new Logger();
const updateManager = new UpdateManager({ logger, app, BrowserWindow });
const workspaceServices = new WorkspaceServices({ app, logger });
const operationQueue = new OperationQueue({ logger });

// ============================================
// EXTENSION MANAGER SYSTEM
// ============================================
class ExtensionManager {
  constructor() {
    this.extensionsPath = null;
    this.registry = new Map();
    this.themeExtensions = new Map();
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;

    try {
      // Set up extensions directory structure
      const userData = app.getPath('userData');
      this.extensionsPath = path.join(userData, 'extensions');

      // Create directories
      await fs.mkdir(path.join(this.extensionsPath, 'installed'), { recursive: true });
      await fs.mkdir(path.join(this.extensionsPath, 'themes'), { recursive: true });

      // Load extension registry
      await this.loadRegistry();

      // Load installed extensions
      await this.loadInstalledExtensions();

      this.initialized = true;
      logger.info('Extension Manager initialized');
    } catch (error) {
      logger.error('Failed to initialize Extension Manager', { error: error.message });
    }
  }

  async loadRegistry() {
    try {
      const registryPath = path.join(this.extensionsPath, 'registry.json');
      const data = await fs.readFile(registryPath, 'utf-8');
      const registry = JSON.parse(data);

      registry.forEach(ext => {
        this.registry.set(ext.id, ext);
      });

      logger.info('Extension registry loaded', { count: this.registry.size });
    } catch (error) {
      // Registry doesn't exist yet, create empty one
      await this.saveRegistry();
      logger.info('Created new extension registry');
    }
  }

  async saveRegistry() {
    try {
      const registryPath = path.join(this.extensionsPath, 'registry.json');
      const registry = Array.from(this.registry.values());
      await fs.writeFile(registryPath, JSON.stringify(registry, null, 2));
      logger.info('Extension registry saved');
    } catch (error) {
      logger.error('Failed to save extension registry', { error: error.message });
    }
  }

  async loadInstalledExtensions() {
    try {
      // Load regular extensions
      const installedPath = path.join(this.extensionsPath, 'installed');
      const entries = await fs.readdir(installedPath, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          await this.loadExtension(entry.name, 'installed');
        }
      }

      // Load theme extensions
      const themesPath = path.join(this.extensionsPath, 'themes');
      const themeEntries = await fs.readdir(themesPath, { withFileTypes: true });

      for (const entry of themeEntries) {
        if (entry.isDirectory()) {
          await this.loadExtension(entry.name, 'themes');
        }
      }

      logger.info('Installed extensions loaded', {
        regular: entries.length,
        themes: themeEntries.length
      });
    } catch (error) {
      logger.error('Failed to load installed extensions', { error: error.message });
    }
  }

  async loadExtension(extensionId, type = 'installed') {
    try {
      const extPath = path.join(this.extensionsPath, type, extensionId);
      const manifestPath = path.join(extPath, 'manifest.json');

      const manifestData = await fs.readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestData);

      const extension = {
        id: extensionId,
        path: extPath,
        type: type,
        manifest: manifest,
        enabled: appSettings.extensions.enabled.includes(extensionId)
      };

      if (type === 'themes') {
        this.themeExtensions.set(extensionId, extension);
      } else {
        this.registry.set(extensionId, extension);
      }

      logger.info('Extension loaded', { id: extensionId, type, enabled: extension.enabled });
      return extension;
    } catch (error) {
      logger.error('Failed to load extension', { id: extensionId, error: error.message });
      return null;
    }
  }

  async installExtension(extensionData) {
    try {
      if (!extensionData || typeof extensionData !== 'object' || Array.isArray(extensionData)) {
        return { success: false, error: 'Invalid extension payload' };
      }

      const id = typeof extensionData.id === 'string' ? extensionData.id.trim() : '';
      if (!/^[A-Za-z0-9._-]{1,80}$/.test(id)) {
        return { success: false, error: 'Invalid extension id' };
      }

      const type = extensionData.type === 'themes' ? 'themes' : 'installed';
      const files = extensionData.files;
      if (!files || typeof files !== 'object' || Array.isArray(files)) {
        return { success: false, error: 'Extension files are required' };
      }

      const fileEntries = Object.entries(files);
      if (fileEntries.length === 0) {
        return { success: false, error: 'Extension package is empty' };
      }

      const baseTypePath = path.resolve(this.extensionsPath, type);
      const targetPath = path.resolve(baseTypePath, id);
      const compareBaseTypePath = process.platform === 'win32' ? baseTypePath.toLowerCase() : baseTypePath;
      const compareTargetPath = process.platform === 'win32' ? targetPath.toLowerCase() : targetPath;

      if (!compareTargetPath.startsWith(`${compareBaseTypePath}${path.sep}`)) {
        return { success: false, error: 'Invalid extension path' };
      }

      // Check if already exists
      try {
        await fs.access(targetPath);
        return { success: false, error: 'Extension already installed' };
      } catch (e) {
        // Doesn't exist, continue
      }

      // Create extension directory
      await fs.mkdir(targetPath, { recursive: true });

      // Write files
      for (const [fileName, content] of fileEntries) {
        if (typeof fileName !== 'string' || !fileName.trim()) {
          return { success: false, error: 'Extension contains an invalid file path' };
        }

        if (typeof content !== 'string') {
          return { success: false, error: `Extension file "${fileName}" must be a string` };
        }

        const normalizedFileName = fileName.replace(/\\/g, '/');
        const segments = normalizedFileName.split('/').filter(Boolean);
        if (
          normalizedFileName.startsWith('/') ||
          normalizedFileName.includes('\0') ||
          segments.length === 0 ||
          segments.some((segment) => segment === '.' || segment === '..')
        ) {
          return { success: false, error: `Invalid extension file path: ${fileName}` };
        }

        const filePath = path.resolve(targetPath, ...segments);
        const compareFilePath = process.platform === 'win32' ? filePath.toLowerCase() : filePath;
        if (!compareFilePath.startsWith(`${compareTargetPath}${path.sep}`)) {
          return { success: false, error: `Extension file path escapes target directory: ${fileName}` };
        }

        const dir = path.dirname(filePath);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(filePath, content);
      }

      // Load the extension
      const extension = await this.loadExtension(id, type || 'installed');

      if (extension) {
        // Add to enabled list
        if (!appSettings.extensions.enabled.includes(id)) {
          appSettings.extensions.enabled.push(id);
          await saveSettings();
        }

        await this.saveRegistry();
        logger.info('Extension installed', { id, type });

        return { success: true, extension };
      }

      return { success: false, error: 'Failed to load extension after installation' };
    } catch (error) {
      logger.error('Failed to install extension', { error: error.message });
      return { success: false, error: error.message };
    }
  }

  async uninstallExtension(extensionId) {
    try {
      const extension = this.registry.get(extensionId) || this.themeExtensions.get(extensionId);

      if (!extension) {
        return { success: false, error: 'Extension not found' };
      }

      // Remove from filesystem
      await fs.rm(extension.path, { recursive: true, force: true });

      // Remove from registry
      this.registry.delete(extensionId);
      this.themeExtensions.delete(extensionId);

      // Remove from enabled/disabled lists
      appSettings.extensions.enabled = appSettings.extensions.enabled.filter(id => id !== extensionId);
      appSettings.extensions.disabled = appSettings.extensions.disabled.filter(id => id !== extensionId);

      await saveSettings();
      await this.saveRegistry();

      logger.info('Extension uninstalled', { id: extensionId });
      return { success: true };
    } catch (error) {
      logger.error('Failed to uninstall extension', { id: extensionId, error: error.message });
      return { success: false, error: error.message };
    }
  }

  async enableExtension(extensionId) {
    try {
      // Remove from disabled, add to enabled
      appSettings.extensions.disabled = appSettings.extensions.disabled.filter(id => id !== extensionId);

      if (!appSettings.extensions.enabled.includes(extensionId)) {
        appSettings.extensions.enabled.push(extensionId);
      }

      await saveSettings();

      // Update extension state
      const extension = this.registry.get(extensionId) || this.themeExtensions.get(extensionId);
      if (extension) {
        extension.enabled = true;
      }

      logger.info('Extension enabled', { id: extensionId });
      return { success: true };
    } catch (error) {
      logger.error('Failed to enable extension', { id: extensionId, error: error.message });
      return { success: false, error: error.message };
    }
  }

  async disableExtension(extensionId) {
    try {
      // Remove from enabled, add to disabled
      appSettings.extensions.enabled = appSettings.extensions.enabled.filter(id => id !== extensionId);

      if (!appSettings.extensions.disabled.includes(extensionId)) {
        appSettings.extensions.disabled.push(extensionId);
      }

      await saveSettings();

      // Update extension state
      const extension = this.registry.get(extensionId) || this.themeExtensions.get(extensionId);
      if (extension) {
        extension.enabled = false;
      }

      logger.info('Extension disabled', { id: extensionId });
      return { success: true };
    } catch (error) {
      logger.error('Failed to disable extension', { id: extensionId, error: error.message });
      return { success: false, error: error.message };
    }
  }

  getInstalledExtensions() {
    const extensions = [];

    this.registry.forEach((ext, id) => {
      extensions.push({
        id,
        name: ext.manifest?.name || id,
        displayName: ext.manifest?.displayName || id,
        description: ext.manifest?.description || '',
        version: ext.manifest?.version || '1.0.0',
        author: ext.manifest?.publisher || 'Unknown',
        enabled: ext.enabled,
        type: ext.type,
        category: ext.manifest?.category || 'general'
      });
    });

    this.themeExtensions.forEach((ext, id) => {
      extensions.push({
        id,
        name: ext.manifest?.name || id,
        displayName: ext.manifest?.displayName || id,
        description: ext.manifest?.description || '',
        version: ext.manifest?.version || '1.0.0',
        author: ext.manifest?.publisher || 'Unknown',
        enabled: ext.enabled,
        type: 'theme',
        category: 'themes',
        colors: ext.manifest?.colors || {}
      });
    });

    return extensions;
  }

  getThemeExtensions() {
    const themes = [];

    this.themeExtensions.forEach((ext, id) => {
      themes.push({
        id,
        name: ext.manifest?.displayName || ext.manifest?.name || id,
        description: ext.manifest?.description || '',
        colors: ext.manifest?.colors || {},
        enabled: ext.enabled,
        cssFile: ext.manifest?.main || 'theme.css'
      });
    });

    return themes;
  }

  async getThemeCSS(themeId) {
    try {
      const theme = this.themeExtensions.get(themeId);
      if (!theme) {
        return { success: false, error: 'Theme not found' };
      }

      const cssFile = theme.manifest?.main || 'theme.css';
      const cssPath = path.join(theme.path, cssFile);
      const css = await fs.readFile(cssPath, 'utf-8');

      return { success: true, css, colors: theme.manifest?.colors || {} };
    } catch (error) {
      logger.error('Failed to load theme CSS', { themeId, error: error.message });
      return { success: false, error: error.message };
    }
  }

  // Download theme from URL (supports GitHub raw URLs)
  async downloadThemeFromURL(themeId, cssUrl, manifestData) {
    try {
      const https = require('https');
      const url = require('url');

      return new Promise((resolve) => {
        const parsedUrl = url.parse(cssUrl);
        const options = {
          hostname: parsedUrl.hostname,
          path: parsedUrl.path,
          method: 'GET',
          headers: {
            'User-Agent': 'AppManager-Pro/1.0'
          }
        };

        https.get(options, (res) => {
          let cssData = '';
          res.on('data', (chunk) => { cssData += chunk; });
          res.on('end', async () => {
            if (res.statusCode === 200) {
              const extensionData = {
                id: themeId,
                name: manifestData.displayName,
                type: 'themes',
                files: {
                  'manifest.json': JSON.stringify(manifestData, null, 2),
                  'theme.css': cssData
                }
              };
              const result = await this.installExtension(extensionData);
              resolve(result);
            } else {
              resolve({ success: false, error: `Failed to download: HTTP ${res.statusCode}` });
            }
          });
        }).on('error', (error) => {
          resolve({ success: false, error: error.message });
        });
      });
    } catch (error) {
      logger.error('Failed to download theme from URL', { themeId, error: error.message });
      return { success: false, error: error.message };
    }
  }
}

const extensionManager = new ExtensionManager();

function resolveExecutableForPlatform(executable) {
  return executable;
}

async function executeCommandWithArgs(executable, args = [], options = {}) {
  const command = resolveExecutableForPlatform(executable);
  const {
    cwd,
    timeout = 60000,
    maxBuffer = COMMAND_MAX_BUFFER_BYTES,
    env = null
  } = options;

  if (process.platform === 'win32' && command === 'npm') {
    const commandLine = buildWindowsCommandLine({ command }, args);
    const result = await executeWindowsCommand(commandLine, timeout);
    if (!result.success) {
      return {
        success: false,
        error: result.error || 'Command failed',
        stderr: result.stderr,
        details: result.error || 'Command failed'
      };
    }

    return {
      success: true,
      output: result.stdout || '',
      stderr: result.stderr || ''
    };
  }

  return new Promise((resolve) => {
    execFile(command, args, {
      cwd,
      timeout,
      maxBuffer,
      windowsHide: true,
      env: env ? { ...process.env, ...env } : process.env
    }, (error, stdout, stderr) => {
      if (error) {
        if (error.code === 'ENOENT') {
          resolve({
            success: false,
            error: `Required command not found: ${executable}`,
            stderr,
            details: error.message
          });
          return;
        }

        const timeoutError = error.killed || error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT';
        resolve({
          success: false,
          error: timeoutError ? 'Command timed out' : error.message,
          stderr,
          details: error.message
        });
        return;
      }

      resolve({
        success: true,
        output: stdout,
        stderr
      });
    });
  });
}

function mapGitErrorToUserMessage(stderr, fallbackMessage) {
  if (!stderr) {
    return fallbackMessage;
  }

  const stderrLower = String(stderr).toLowerCase();
  if (stderrLower.includes('gh001: large files detected') ||
      stderrLower.includes('exceeds github\'s file size limit') ||
      stderrLower.includes('pre-receive hook declined')) {
    return 'Upload rejected by GitHub: one or more files exceed size limits. Deselect large build artifacts or use Git LFS.';
  }
  if (stderrLower.includes('http 408') || stderrLower.includes('the remote end hung up unexpectedly')) {
    return 'Network timeout while pushing to GitHub. Check your connection and retry.';
  }

  if (stderr.includes('not a git repository')) {
    return 'This is not a git repository. Initialize it first.';
  }
  if (stderr.includes('Permission denied')) {
    return 'Permission denied. Check file permissions.';
  }
  if (stderr.includes('Authentication failed')) {
    return 'Authentication failed. Check your credentials.';
  }
  if (stderr.includes('could not read Username') || stderr.includes('terminal prompts disabled')) {
    return 'Authentication is required for push. Reconnect GitHub and try again.';
  }
  if (stderr.includes('invalid username or password')) {
    return 'GitHub authentication failed. Verify your token and try again.';
  }
  if (stderr.includes('Please tell me who you are') || stderr.includes('unable to auto-detect email address')) {
    return 'Git author identity is missing. Configure Git username and email in Settings.';
  }
  if (stderr.includes('Could not resolve host')) {
    return 'Network error. Check your internet connection.';
  }
  if (stderr.includes('would be overwritten')) {
    return 'Local changes would be overwritten. Commit or stash them first.';
  }
  if (stderr.includes('conflict')) {
    return 'Merge conflict detected. Resolve conflicts manually.';
  }
  if (stderr.includes('nothing to commit')) {
    return 'Nothing to commit. Working tree is clean.';
  }
  if (stderr.includes('already exists')) {
    return 'A branch or remote with that name already exists.';
  }
  if (stderr.includes('does not appear to be a git repository')) {
    return 'Remote repository not found. Check the URL.';
  }
  if (stderr.includes('rejected')) {
    return 'Push rejected. Pull the latest changes first.';
  }
  if (stderr.includes('timeout')) {
    return 'Operation timed out. Check your connection and try again.';
  }

  return fallbackMessage;
}

function getGitExecutable() {
  const configuredPath = typeof appSettings.gitPath === 'string'
    ? appSettings.gitPath.trim()
    : '';

  if (configuredPath && configuredPath.length <= MAX_SETTINGS_PATH_LENGTH) {
    return configuredPath;
  }

  return 'git';
}

async function isGitRepositoryRoot(projectPath) {
  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    return false;
  }

  try {
    await fs.access(path.join(projectPath, '.git'));
    return true;
  } catch {
    return false;
  }
}

async function executeGitArgs(args, cwd, operation = 'Git Operation', options = {}) {
  const gitExecutable = getGitExecutable();
  const commandDisplay = typeof options.commandDisplay === 'string' && options.commandDisplay.trim()
    ? options.commandDisplay.trim()
    : [gitExecutable, ...args].join(' ');
  logger.info(`Executing: ${commandDisplay}`, { cwd, operation });

  const result = await executeCommandWithArgs(gitExecutable, args, {
    cwd,
    timeout: Number.isFinite(options.timeout) && options.timeout > 0 ? options.timeout : 60000,
    env: options.env && typeof options.env === 'object' ? options.env : null
  });

  if (!result.success) {
    const safeErrorMessage = options.sensitive
      ? 'Sensitive Git command failed'
      : result.error;
    logger.error(`Git command failed: ${commandDisplay}`, {
      error: safeErrorMessage,
      stderr: result.stderr,
      cwd,
      operation
    });

    return {
      success: false,
      error: mapGitErrorToUserMessage(result.stderr, safeErrorMessage),
      stderr: result.stderr,
      details: options.sensitive ? safeErrorMessage : (result.details || safeErrorMessage)
    };
  }

  const output = typeof result.output === 'string' ? result.output : '';
  logger.info(`Git command succeeded: ${commandDisplay}`, { stdout: output.substring(0, 200) });
  return {
    success: true,
    output,
    stderr: result.stderr
  };
}

function splitUnifiedDiffIntoHunks(diffOutput) {
  const diffText = typeof diffOutput === 'string' ? diffOutput : '';
  if (!diffText.trim()) {
    return [];
  }

  const lines = diffText.split(/\r?\n/);
  const headerLines = [];
  const hunks = [];
  let currentHunk = null;

  for (const line of lines) {
    if (line.startsWith('@@ ')) {
      if (currentHunk) {
        hunks.push(currentHunk);
      }
      currentHunk = {
        header: line,
        lines: [line]
      };
      continue;
    }

    if (currentHunk) {
      currentHunk.lines.push(line);
    } else {
      headerLines.push(line);
    }
  }

  if (currentHunk) {
    hunks.push(currentHunk);
  }

  return hunks.map((hunk, index) => {
    const previewLines = hunk.lines
      .slice(1)
      .filter((line) => line && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')))
      .slice(0, 8)
      .map((line) => line.slice(0, 220));

    const patchLines = [...headerLines, ...hunk.lines];
    const patchText = `${patchLines.join('\n')}\n`;
    return {
      id: index + 1,
      header: hunk.header,
      preview: previewLines,
      patch: patchText
    };
  });
}

async function applyGitPatchToIndex(projectPath, patchText, { reverse = false } = {}) {
  const gitExecutable = getGitExecutable();
  const args = ['apply', '--cached', '--recount', '--whitespace=nowarn'];
  if (reverse) {
    args.push('--reverse');
  }
  args.push('-');

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(gitExecutable, args, {
      cwd: projectPath,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      resolve({
        success: false,
        error: error.message || 'Failed to apply patch',
        stdout,
        stderr
      });
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, output: stdout, stderr });
        return;
      }

      const fallback = `git apply failed with code ${code}`;
      resolve({
        success: false,
        error: mapGitErrorToUserMessage(stderr, fallback),
        stdout,
        stderr
      });
    });

    try {
      child.stdin.write(patchText || '', 'utf8');
      child.stdin.end();
    } catch (error) {
      resolve({
        success: false,
        error: error.message || 'Failed to write patch data',
        stdout,
        stderr
      });
    }
  });
}

function deriveGitPushProgressDetail(rawLine) {
  const line = typeof rawLine === 'string' ? rawLine.trim() : '';
  if (!line) {
    return null;
  }

  const countingMatch = line.match(/^Counting objects:\s+(\d+)%/i);
  if (countingMatch) {
    return `Counting objects... ${countingMatch[1]}%`;
  }

  const compressingMatch = line.match(/^Compressing objects:\s+(\d+)%/i);
  if (compressingMatch) {
    return `Compressing objects... ${compressingMatch[1]}%`;
  }

  const writingMatch = line.match(/^Writing objects:\s+(\d+)%/i);
  if (writingMatch) {
    return `Uploading objects... ${writingMatch[1]}%`;
  }

  const resolvingMatch = line.match(/^remote:\s*Resolving deltas:\s+(\d+)%/i);
  if (resolvingMatch) {
    return `Remote processing... ${resolvingMatch[1]}%`;
  }

  if (/^Enumerating objects:/i.test(line)) {
    return 'Preparing objects for push...';
  }

  if (/^To\s+https?:\/\//i.test(line)) {
    return 'Finalizing push on GitHub...';
  }

  if (/set up to track/i.test(line)) {
    return 'Branch tracking configured.';
  }

  if (/^remote:\s*/i.test(line)) {
    const remoteText = line.replace(/^remote:\s*/i, '').trim();
    if (remoteText) {
      return remoteText;
    }
  }

  return null;
}

async function executeGitPushWithProgress({
  cwd,
  branch,
  timeout = GIT_PUSH_TIMEOUT_MS,
  onProgress,
  isCancelled = () => false
}) {
  const gitExecutable = getGitExecutable();
  const args = ['push', '--progress', '-u', 'origin', branch];
  const commandDisplay = `${gitExecutable} push --progress -u origin ${branch}`;
  logger.info(`Executing: ${commandDisplay}`, { cwd, operation: `Push ${branch}` });

  return new Promise((resolve) => {
    let resolved = false;
    let stdout = '';
    let stderr = '';
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let lastProgressDetail = '';
    const pushStartTime = Date.now();

    const child = spawn(gitExecutable, args, {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0'
      }
    });

    const safeResolve = (result) => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimeout(timeoutHandle);
      clearInterval(heartbeatTimer);
      resolve(result);
    };

    const emitProgressDetail = (line) => {
      const detail = deriveGitPushProgressDetail(line);
      if (!detail || detail === lastProgressDetail) {
        return;
      }
      lastProgressDetail = detail;
      if (typeof onProgress === 'function') {
        onProgress(detail);
      }
    };

    const consumeChunk = (chunk, streamType) => {
      if (isCancelled()) {
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
        safeResolve({
          success: false,
          cancelled: true,
          error: 'Operation cancelled',
          stderr
        });
        return;
      }

      const text = chunk.toString();
      if (streamType === 'stdout') {
        stdout += text;
        stdoutBuffer += text;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || '';
        lines.forEach((line) => emitProgressDetail(line));
      } else {
        stderr += text;
        stderrBuffer += text;
        const lines = stderrBuffer.split(/\r?\n/);
        stderrBuffer = lines.pop() || '';
        lines.forEach((line) => emitProgressDetail(line));
      }
    };

    const timeoutHandle = setTimeout(() => {
      if (resolved) {
        return;
      }
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      safeResolve({
        success: false,
        error: 'Command timed out',
        stderr,
        details: 'Command timed out'
      });
    }, timeout);

    const heartbeatTimer = setInterval(() => {
      if (resolved) {
        return;
      }

      if (isCancelled()) {
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
        safeResolve({
          success: false,
          cancelled: true,
          error: 'Operation cancelled',
          stderr
        });
        return;
      }

      if (typeof onProgress !== 'function') {
        return;
      }
      const elapsedSeconds = Math.max(1, Math.floor((Date.now() - pushStartTime) / 1000));
      const baseDetail = lastProgressDetail || `Pushing ${branch}...`;
      onProgress(`${baseDetail} (${elapsedSeconds}s elapsed)`);
    }, 6000);

    child.stdout?.on('data', (chunk) => consumeChunk(chunk, 'stdout'));
    child.stderr?.on('data', (chunk) => consumeChunk(chunk, 'stderr'));

    child.on('error', (error) => {
      if (error && error.code === 'ENOENT') {
        safeResolve({
          success: false,
          error: `Required command not found: ${gitExecutable}`,
          stderr,
          details: error.message
        });
        return;
      }

      safeResolve({
        success: false,
        error: error?.message || 'Push process failed to start',
        stderr,
        details: error?.message || 'Push process failed to start'
      });
    });

    child.on('close', (code) => {
      if (stdoutBuffer) {
        emitProgressDetail(stdoutBuffer);
      }
      if (stderrBuffer) {
        emitProgressDetail(stderrBuffer);
      }

      if (code === 0) {
        logger.info(`Git command succeeded: ${commandDisplay}`, { stdout: stdout.substring(0, 200) });
        safeResolve({
          success: true,
          output: stdout,
          stderr
        });
        return;
      }

      const fallback = `git push failed with code ${code}`;
      const userError = mapGitErrorToUserMessage(stderr, fallback);
      logger.error(`Git command failed: ${commandDisplay}`, {
        error: userError,
        stderr,
        cwd,
        operation: `Push ${branch}`
      });
      safeResolve({
        success: false,
        error: userError,
        stderr,
        details: fallback
      });
    });
  });
}

// Git Command Wrapper with advanced error handling
async function executeGitCommand(command, cwd, operation = 'Git Operation') {
  return new Promise((resolve) => {
    logger.info(`Executing: ${command}`, { cwd, operation });

    exec(command, { cwd, timeout: 60000 }, (error, stdout, stderr) => {
      if (error) {
        logger.error(`Git command failed: ${command}`, {
          error: error.message,
          stderr,
          cwd,
          operation
        });

        // Provide user-friendly error messages
        const userMessage = mapGitErrorToUserMessage(stderr, error.message);

        resolve({
          success: false,
          error: userMessage,
          stderr,
          details: error.message
        });
      } else {
        logger.info(`Git command succeeded: ${command}`, { stdout: stdout.substring(0, 200) });
        resolve({
          success: true,
          output: stdout,
          stderr
        });
      }
    });
  });
}

// ============================================
// ADVANCED FEATURE 1: Real-Time File Watcher
// ============================================
function startFileWatcher(projectPath) {
  const normalizedProjectPath = path.resolve(projectPath);

  // Limit the number of active watchers to prevent resource exhaustion
  if (fileWatchers.size >= 10) {
    // Close the oldest watcher
    const oldestKey = fileWatchers.keys().next().value;
    stopFileWatcher(oldestKey);
    logger.warn('Max file watchers reached, closing oldest', { closed: oldestKey });
  }

  // Stop existing watcher if any
  stopFileWatcher(normalizedProjectPath);

  try {
    const watcher = chokidar.watch(normalizedProjectPath, {
      ignored: /(^|[\/\\])\../, // ignore dotfiles except .git
      persistent: true,
      ignoreInitial: true,
      depth: 3,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100
      }
    });

    const watcherEntry = {
      watcher,
      updateTimeout: null
    };

    const debouncedUpdate = () => {
      if (watcherEntry.updateTimeout) {
        clearTimeout(watcherEntry.updateTimeout);
      }
      watcherEntry.updateTimeout = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('git-status-changed', normalizedProjectPath);
        }
      }, 500);
    };

    watcher
      .on('add', debouncedUpdate)
      .on('change', debouncedUpdate)
      .on('unlink', debouncedUpdate)
      .on('error', (error) => {
        logger.error('File watcher error', { projectPath: normalizedProjectPath, error: error.message });
      });

    fileWatchers.set(normalizedProjectPath, watcherEntry);
    logger.info('File watcher started', { projectPath: normalizedProjectPath });
  } catch (error) {
    logger.error('Failed to start file watcher', { projectPath: normalizedProjectPath, error: error.message });
  }
}

function stopFileWatcher(projectPath) {
  const normalizedProjectPath = path.resolve(projectPath);
  if (fileWatchers.has(normalizedProjectPath)) {
    const watcherEntry = fileWatchers.get(normalizedProjectPath);
    if (watcherEntry && watcherEntry.updateTimeout) {
      clearTimeout(watcherEntry.updateTimeout);
    }

    if (watcherEntry && watcherEntry.watcher) {
      watcherEntry.watcher.close();
    }
    fileWatchers.delete(normalizedProjectPath);
    logger.info('File watcher stopped', { projectPath: normalizedProjectPath });
  }
}

// ============================================
// ADVANCED FEATURE 2: Operation History (Undo/Redo)
// ============================================
function recordGitOperation(operation) {
  const record = {
    ...operation,
    timestamp: new Date().toISOString(),
    id: Date.now()
  };

  gitOperationHistory.unshift(record);

  // Keep only last MAX_HISTORY operations
  if (gitOperationHistory.length > MAX_HISTORY) {
    gitOperationHistory = gitOperationHistory.slice(0, MAX_HISTORY);
  }

  logger.info('Git operation recorded', record);

  // Notify renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('git-history-updated', gitOperationHistory);
  }
}

// ============================================
// ADVANCED FEATURE 3: Project Templates
// ============================================
const projectTemplates = {
  'react-app': {
    name: 'React Application',
    description: 'Modern React app with TypeScript',
    files: {
      'package.json': JSON.stringify({
        name: 'react-app',
        version: '1.0.0',
        dependencies: {
          'react': '^18.2.0',
          'react-dom': '^18.2.0'
        },
        scripts: {
          'start': 'react-scripts start',
          'build': 'react-scripts build'
        }
      }, null, 2),
      'src/App.jsx': `import React from 'react';\n\nfunction App() {\n  return (\n    <div className="App">\n      <h1>Hello React!</h1>\n    </div>\n  );\n}\n\nexport default App;`,
      'src/index.jsx': `import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport App from './App';\n\nconst root = ReactDOM.createRoot(document.getElementById('root'));\nroot.render(<App />);`,
      'public/index.html': `<!DOCTYPE html>\n<html>\n<head>\n  <title>React App</title>\n</head>\n<body>\n  <div id="root"></div>\n</body>\n</html>`,
      'README.md': '# React Application\n\nCreated with Project Manager Pro\n\n## Getting Started\n\n```bash\nnpm install\nnpm start\n```'
    }
  },
  'node-api': {
    name: 'Node.js API',
    description: 'Express REST API with TypeScript',
    files: {
      'package.json': JSON.stringify({
        name: 'node-api',
        version: '1.0.0',
        main: 'src/index.js',
        dependencies: {
          'express': '^4.18.0',
          'cors': '^2.8.5'
        },
        scripts: {
          'start': 'node src/index.js',
          'dev': 'nodemon src/index.js'
        }
      }, null, 2),
      'src/index.js': `const express = require('express');\nconst cors = require('cors');\n\nconst app = express();\nconst PORT = process.env.PORT || 3000;\n\napp.use(cors());\napp.use(express.json());\n\napp.get('/api/health', (req, res) => {\n  res.json({ status: 'OK', timestamp: new Date() });\n});\n\napp.listen(PORT, () => {\n  console.log(\`Server running on port \${PORT}\`);\n});`,
      'README.md': '# Node.js API\n\nCreated with Project Manager Pro\n\n## Getting Started\n\n```bash\nnpm install\nnpm start\n```'
    }
  },
  'python-app': {
    name: 'Python Application',
    description: 'Flask web application',
    files: {
      'app.py': `from flask import Flask, jsonify\n\napp = Flask(__name__)\n\n@app.route('/api/health')\ndef health():\n    return jsonify({'status': 'OK'})\n\nif __name__ == '__main__':\n    app.run(debug=True, port=5000)`,
      'requirements.txt': 'Flask==2.3.0\nFlask-CORS==4.0.0',
      'README.md': '# Python Flask App\n\nCreated with Project Manager Pro\n\n## Getting Started\n\n```bash\npip install -r requirements.txt\npython app.py\n```'
    }
  }
};

// Load settings
async function loadSettings() {
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');

  try {
    const stats = await fs.stat(settingsPath);
    if (stats.size > MAX_SETTINGS_FILE_SIZE_BYTES) {
      logger.warn('Settings file too large; using defaults', { bytes: stats.size, maxBytes: MAX_SETTINGS_FILE_SIZE_BYTES });
      appSettings = buildDefaultAppSettings(projectsBasePath);
      return;
    }

    const data = await fs.readFile(settingsPath, 'utf-8');
    const parsedSettings = JSON.parse(data);
    appSettings = sanitizeAppSettings(parsedSettings, projectsBasePath);
    projectsBasePath = appSettings.defaultProjectPath;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.warn('Failed to load settings; using defaults', { error: error.message });
    }
    appSettings = buildDefaultAppSettings(projectsBasePath);
  }
}

// Save settings
async function saveSettings() {
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');

  try {
    appSettings = sanitizeAppSettings(appSettings, projectsBasePath);
    projectsBasePath = appSettings.defaultProjectPath;
    await fs.writeFile(settingsPath, JSON.stringify(appSettings, null, 2));
    return true;
  } catch (error) {
    console.error('Error saving settings:', error);
    return false;
  }
}

function getRecentProjectsFilePath() {
  return path.join(app.getPath('userData'), 'recent-projects.json');
}

async function readRecentProjectsFromDisk() {
  try {
    const data = await fs.readFile(getRecentProjectsFilePath(), 'utf-8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveRecentProjectsToDisk(projects) {
  const normalized = Array.isArray(projects) ? projects : [];
  await fs.writeFile(getRecentProjectsFilePath(), JSON.stringify(normalized, null, 2));
  return true;
}

// Ensure projects directory exists
async function ensureProjectsDir() {
  try {
    await fs.mkdir(projectsBasePath, { recursive: true });
  } catch (error) {
    console.error('Error creating projects directory:', error);
  }
}

function createTray() {
  const trayIconPath = path.join(__dirname, 'assets', 'logo.png');
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(trayIconPath).resize({ width: 16, height: 16 });
  } catch {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip(`Project Manager Pro ${appVersionInfo.displayVersion}`);

  const buildTrayMenu = () => {
    const isVisible = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
    const isMaximized = mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized();
    const tierLabel = licenseState.isProUnlocked
      ? `Pro (${licenseState.tier || 'Licensed'})`
      : 'Free';

    return Menu.buildFromTemplate([
      // ── Header ──
      {
        label: `Project Manager Pro ${appVersionInfo.displayVersion}`,
        enabled: false,
        icon: trayIcon
      },
      {
        label: `License: ${tierLabel}`,
        enabled: false
      },
      { type: 'separator' },

      // ── Window Controls ──
      {
        label: isVisible ? 'Hide Window' : 'Show Window',
        click: () => {
          if (!mainWindow || mainWindow.isDestroyed()) return;
          if (mainWindow.isVisible()) {
            mainWindow.hide();
          } else {
            mainWindow.show();
            mainWindow.focus();
          }
        },
        accelerator: 'CmdOrCtrl+Shift+H'
      },
      {
        label: isMaximized ? 'Restore Window' : 'Maximize Window',
        click: () => {
          if (!mainWindow || mainWindow.isDestroyed()) return;
          if (mainWindow.isMaximized()) {
            mainWindow.unmaximize();
          } else {
            mainWindow.maximize();
          }
        },
        enabled: isVisible
      },
      {
        label: 'Minimize to Tray',
        click: () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.minimize();
          }
        },
        enabled: isVisible
      },
      { type: 'separator' },

      // ── Quick Actions ──
      {
        label: 'Quick Actions',
        submenu: [
          {
            label: 'Open Projects Folder',
            click: () => shell.openPath(projectsBasePath)
          },
          {
            label: 'Open App Data Folder',
            click: () => shell.openPath(app.getPath('userData'))
          },
          { type: 'separator' },
          {
            label: 'Reload Window',
            click: () => {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.reload();
              }
            },
            accelerator: 'CmdOrCtrl+Shift+R'
          },
          {
            label: 'Toggle DevTools',
            click: () => {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.toggleDevTools();
              }
            },
            accelerator: 'F12'
          }
        ]
      },

      // ── Settings Toggles ──
      {
        label: 'Settings',
        submenu: [
          {
            label: 'Theme',
            submenu: [
              {
                label: 'Dark',
                type: 'radio',
                checked: appSettings.theme === 'dark',
                click: async () => {
                  appSettings.theme = 'dark';
                  await saveSettings();
                  if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('theme-changed', 'dark');
                  }
                }
              },
              {
                label: 'Light',
                type: 'radio',
                checked: appSettings.theme === 'light',
                click: async () => {
                  appSettings.theme = 'light';
                  await saveSettings();
                  if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('theme-changed', 'light');
                  }
                }
              }
            ]
          },
          { type: 'separator' },
          {
            label: 'Auto Save',
            type: 'checkbox',
            checked: appSettings.autoSave,
            click: async (menuItem) => {
              appSettings.autoSave = menuItem.checked;
              await saveSettings();
            }
          },
          {
            label: 'Close to Tray',
            type: 'checkbox',
            checked: Boolean(appSettings.closeToTray),
            click: async (menuItem) => {
              appSettings.closeToTray = menuItem.checked;
              await saveSettings();
            }
          },
          {
            label: 'Git Integration',
            type: 'checkbox',
            checked: appSettings.gitIntegration,
            click: async (menuItem) => {
              appSettings.gitIntegration = menuItem.checked;
              await saveSettings();
            }
          },
          {
            label: 'File Watcher',
            type: 'checkbox',
            checked: appSettings.enableFileWatcher,
            click: async (menuItem) => {
              appSettings.enableFileWatcher = menuItem.checked;
              await saveSettings();
            }
          },
          {
            label: 'Auto Update',
            type: 'checkbox',
            checked: appSettings.autoUpdate,
            click: async (menuItem) => {
              appSettings.autoUpdate = menuItem.checked;
              await saveSettings();
            }
          }
        ]
      },
      { type: 'separator' },

      // ── Info & Links ──
      {
        label: 'About',
        click: () => {
          dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'Project Manager Pro',
            message: `Project Manager Pro ${appVersionInfo.displayVersion}`,
            detail: [
              `Channel: ${appVersionInfo.channel}`,
              `License: ${tierLabel}`,
              `Electron: v${process.versions.electron}`,
              `Node.js: ${process.version}`,
              `Platform: ${process.platform} ${process.arch}`
            ].join('\n'),
            buttons: ['OK']
          });
        }
      },
      { type: 'separator' },

      // ── Exit ──
      {
        label: 'Quit Project Manager Pro',
        click: () => {
          forceAppQuit = true;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.close();
            return;
          }
          app.quit();
        },
        accelerator: 'CmdOrCtrl+Q'
      }
    ]);
  };

  // Set initial menu
  tray.setContextMenu(buildTrayMenu());

  // Rebuild menu on every click to reflect current state
  tray.on('click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });

  tray.on('right-click', () => {
    tray.setContextMenu(buildTrayMenu());
  });
}

function broadcastOperationQueueUpdate() {
  const snapshot = operationQueue.getSnapshot();
  BrowserWindow.getAllWindows().forEach((window) => {
    if (!window || window.isDestroyed()) {
      return;
    }
    try {
      window.webContents.send('operation-queue-updated', snapshot);
    } catch (error) {
      logger.warn('Failed to broadcast operation queue update', { error: error.message });
    }
  });
}

operationQueue.on('updated', () => {
  broadcastOperationQueueUpdate();
});

function isPathWithinBase(basePath, targetPath) {
  const normalizedBase = path.resolve(basePath);
  const normalizedTarget = path.resolve(targetPath);

  if (process.platform === 'win32') {
    const baseLower = normalizedBase.toLowerCase();
    const targetLower = normalizedTarget.toLowerCase();
    return targetLower === baseLower || targetLower.startsWith(`${baseLower}${path.sep}`);
  }

  return normalizedTarget === normalizedBase || normalizedTarget.startsWith(`${normalizedBase}${path.sep}`);
}

function isTrustedLocalAppUrl(rawUrl) {
  try {
    const parsedUrl = new URL(rawUrl);
    if (parsedUrl.protocol !== 'file:') {
      return false;
    }

    if (parsedUrl.host && parsedUrl.host !== 'localhost') {
      return false;
    }

    const filePath = path.resolve(fileURLToPath(parsedUrl));
    return isPathWithinBase(__dirname, filePath);
  } catch {
    return false;
  }
}

function validateExternalUrl(rawUrl) {
  try {
    const parsedUrl = new URL(rawUrl);
    const allowedProtocols = new Set(['http:', 'https:', 'file:']);

    if (!allowedProtocols.has(parsedUrl.protocol)) {
      return { valid: false, error: 'Unsupported URL protocol', protocol: parsedUrl.protocol };
    }

    if (parsedUrl.protocol === 'file:') {
      if (parsedUrl.host && parsedUrl.host !== 'localhost') {
        return { valid: false, error: 'Invalid file URL host' };
      }

      let filePath;
      try {
        filePath = path.resolve(fileURLToPath(parsedUrl));
      } catch {
        return { valid: false, error: 'Invalid file URL' };
      }

      if (filePath === path.parse(filePath).root) {
        return { valid: false, error: 'Refusing to open filesystem root' };
      }
    }

    return { valid: true, url: parsedUrl.toString() };
  } catch {
    return { valid: false, error: 'Invalid URL' };
  }
}

async function openExternalSafely(rawUrl) {
  const validation = validateExternalUrl(rawUrl);
  if (!validation.valid) {
    logger.warn('Blocked opening URL', {
      url: String(rawUrl),
      error: validation.error,
      protocol: validation.protocol || null
    });
    return { success: false, error: validation.error };
  }

  try {
    await shell.openExternal(validation.url);
    return { success: true };
  } catch (error) {
    logger.warn('Failed to open external URL', { url: validation.url, error: error.message });
    return { success: false, error: 'Failed to open URL' };
  }
}

function installSessionSecurityPolicies() {
  if (sessionSecurityPoliciesInstalled) {
    return;
  }

  const defaultSession = session.defaultSession;
  if (!defaultSession) {
    return;
  }

  defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    logger.warn('Denied permission request', {
      permission,
      url: webContents?.getURL() || 'unknown'
    });
    callback(false);
  });

  if (typeof defaultSession.setPermissionCheckHandler === 'function') {
    defaultSession.setPermissionCheckHandler(() => false);
  }

  sessionSecurityPoliciesInstalled = true;
}

function attachWindowSecurityGuards(targetWindow, label) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  installSessionSecurityPolicies();

  const contents = targetWindow.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    if (typeof url === 'string' && url) {
      void openExternalSafely(url);
    }
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, navigationUrl) => {
    if (isTrustedLocalAppUrl(navigationUrl)) {
      return;
    }

    event.preventDefault();
    logger.warn('Blocked navigation attempt', { window: label, url: navigationUrl });

    if (/^https?:/i.test(navigationUrl)) {
      void openExternalSafely(navigationUrl);
    }
  });

  contents.on('will-attach-webview', (event, webPreferences, params) => {
    event.preventDefault();
    logger.warn('Blocked webview attachment attempt', { window: label, src: params?.src || null });
  });
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 700,
    height: 500,
    frame: false,
    transparent: false,
    backgroundColor: '#1e1e1e',
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    webPreferences: {
      preload: path.join(__dirname, 'splash-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    }
  });

  attachWindowSecurityGuards(splashWindow, 'splash');
  splashWindow.loadFile('splash.html');
  splashWindow.center();

  splashWindow.on('closed', () => {
    splashWindow = null;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    frame: false,
    backgroundColor: '#1e1e1e',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: false, // Don't show until ready - will load in background
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: true,
      webviewTag: false
    }
  });

  attachWindowSecurityGuards(mainWindow, 'main');
  mainWindow.loadFile('index.html');

  // Remove default menu
  Menu.setApplicationMenu(null);

  // Wait for BOTH conditions: main window ready AND splash progress at 100%
  let windowReady = false;
  let splashDone = !splashWindow || splashWindow.isDestroyed();
  let splashCompleteHandler = null;
  const splashFallbackTimer = setTimeout(() => {
    if (!splashDone) {
      splashDone = true;
      logger.warn('Splash completion timeout reached; showing main window');
      showMainWindow();
    }
  }, 15000);

  function showMainWindow() {
    if (!windowReady || !splashDone) return;
    clearTimeout(splashFallbackTimer);
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
    }
    mainWindow.maximize();
    mainWindow.show();
  }

  mainWindow.once('ready-to-show', () => {
    windowReady = true;
    showMainWindow();
  });

  if (!splashDone) {
    splashCompleteHandler = () => {
      splashDone = true;
      showMainWindow();
    };
    ipcMain.once('splash-complete', splashCompleteHandler);
  }

  mainWindow.on('close', (event) => {
    if (!allowRendererConfirmedClose && !pendingRendererCloseRequest && !forceAppQuit && appSettings.closeToTray) {
      event.preventDefault();
      mainWindow.hide();
      return;
    }

    if (allowRendererConfirmedClose) {
      return;
    }

    if (pendingRendererCloseRequest) {
      event.preventDefault();
      return;
    }

    const contents = mainWindow && !mainWindow.isDestroyed()
      ? mainWindow.webContents
      : null;

    if (!contents || contents.isDestroyed() || !contents.getURL()) {
      allowRendererConfirmedClose = true;
      return;
    }

    event.preventDefault();
    pendingRendererCloseRequest = true;

    try {
      contents.send('app-close-requested');
      if (closeRequestTimeout) {
        clearTimeout(closeRequestTimeout);
      }
      closeRequestTimeout = setTimeout(() => {
        if (pendingRendererCloseRequest && mainWindow && !mainWindow.isDestroyed()) {
          logger.warn('Renderer close confirmation timed out; forcing close');
          pendingRendererCloseRequest = false;
          allowRendererConfirmedClose = true;
          mainWindow.close();
        }
      }, 10000);
    } catch (error) {
      logger.warn('Unable to notify renderer for close confirmation', { error: error.message });
      allowRendererConfirmedClose = true;
      pendingRendererCloseRequest = false;
      if (closeRequestTimeout) {
        clearTimeout(closeRequestTimeout);
        closeRequestTimeout = null;
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.close();
      }
    }
  });

  mainWindow.on('closed', () => {
    clearTimeout(splashFallbackTimer);
    if (splashCompleteHandler) {
      ipcMain.removeListener('splash-complete', splashCompleteHandler);
      splashCompleteHandler = null;
    }
    if (closeRequestTimeout) {
      clearTimeout(closeRequestTimeout);
      closeRequestTimeout = null;
    }
    allowRendererConfirmedClose = false;
    pendingRendererCloseRequest = false;
    forceAppQuit = false;
    mainWindow = null;
  });
}

// Ensure single instance of the application
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  await loadAppVersionInfo();
  await loadLicenseState();
  updateManager.initialize({ channel: appVersionInfo.channel });

  // Show splash screen immediately
  createSplashWindow();

  // Load settings and create main window in background
  try {
    await loadSettings();
    updateManager.setChannel(appSettings.updateChannel || appVersionInfo.channel);
    await migrateGitHubTokenStorage();
    await ensureProjectsDir();
    await extensionManager.initialize();
    createWindow();
    createTray();
    registerGlobalShortcuts();
    logger.info('Application started successfully');
  } catch (error) {
    console.error('Failed to initialize application:', error);
    logger.error('Application startup failed', { error: error.message });

    // Still try to show the main window even if some init failed
    if (!mainWindow) {
      createWindow();
    }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();

  // Clean up tray
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
    tray = null;
  }

  // Clean up all file watchers to prevent resource leaks
  for (const [projectPath, watcherEntry] of fileWatchers) {
    try {
      if (watcherEntry && watcherEntry.updateTimeout) {
        clearTimeout(watcherEntry.updateTimeout);
      }
      if (watcherEntry && watcherEntry.watcher) {
        watcherEntry.watcher.close();
      }
      logger.info('File watcher cleaned up on quit', { projectPath });
    } catch (error) {
      console.error('Error closing file watcher:', error);
    }
  }
  fileWatchers.clear();
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// Register global shortcuts
function registerGlobalShortcuts() {
  globalShortcut.register('CommandOrControl+Shift+P', () => {
    if (mainWindow) {
      mainWindow.webContents.send('show-command-palette');
    }
  });

  // DevTools toggle
  globalShortcut.register('CommandOrControl+Shift+I', () => {
    if (mainWindow) {
      if (mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools();
      } else {
        mainWindow.webContents.openDevTools();
      }
    }
  });

  globalShortcut.register('F12', () => {
    if (mainWindow) {
      if (mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools();
      } else {
        mainWindow.webContents.openDevTools();
      }
    }
  });
}

// IPC Handlers
ipcMain.handle('minimize-window', () => {
  mainWindow.minimize();
});

ipcMain.handle('maximize-window', () => {
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});

ipcMain.handle('close-window', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
  }
});

ipcMain.handle('confirm-app-close', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }

  forceAppQuit = true;
  pendingRendererCloseRequest = false;
  if (closeRequestTimeout) {
    clearTimeout(closeRequestTimeout);
    closeRequestTimeout = null;
  }
  allowRendererConfirmedClose = true;
  mainWindow.close();
  return true;
});

ipcMain.handle('cancel-app-close', () => {
  forceAppQuit = false;
  pendingRendererCloseRequest = false;
  if (closeRequestTimeout) {
    clearTimeout(closeRequestTimeout);
    closeRequestTimeout = null;
  }
  return true;
});

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: projectsBasePath
  });

  if (!result.canceled) {
    projectsBasePath = result.filePaths[0];
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('select-file', async (event, options = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: options.properties || ['openFile'],
    filters: options.filters || [],
    defaultPath: options.defaultPath || projectsBasePath
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('get-projects-path', () => {
  return projectsBasePath;
});

// Settings handlers
ipcMain.handle('get-settings', () => {
  return getRendererSafeSettings(appSettings);
});

ipcMain.handle('save-settings', async (event, settings) => {
  const incomingSettings = settings && typeof settings === 'object' && !Array.isArray(settings)
    ? settings
    : {};
  const previousTheme = appSettings.theme;
  const previousUpdateChannel = appSettings.updateChannel;
  appSettings = sanitizeAppSettings({ ...appSettings, ...incomingSettings }, projectsBasePath);
  projectsBasePath = appSettings.defaultProjectPath;
  const success = await saveSettings();
  if (success) {
    await ensureProjectsDir();
    if (previousUpdateChannel !== appSettings.updateChannel) {
      updateManager.setChannel(appSettings.updateChannel);
    }
  }
  if (
    success &&
    previousTheme !== appSettings.theme &&
    mainWindow &&
    !mainWindow.isDestroyed()
  ) {
    mainWindow.webContents.send('theme-changed', appSettings.theme);
  }
  return success;
});

// File dialog for saving
ipcMain.handle('save-dialog', async (event, options) => {
  const result = await dialog.showSaveDialog(mainWindow, options);
  return result.filePath;
});

// Reload window
ipcMain.handle('reload-window', () => {
  if (mainWindow) {
    mainWindow.reload();
  }
});

// Git operations
ipcMain.handle('init-git', async (event, projectPath) => {
  const validation = validateGitPath(projectPath);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  return executeGitArgs(['init'], validation.path, 'Initialize Git');
});

ipcMain.handle('git-status', async (event, projectPath) => {
  const validation = validateGitPath(projectPath);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  if (!(await isGitRepositoryRoot(validation.path))) {
    return { success: false, error: 'This is not a git repository. Initialize it first.' };
  }

  return executeGitArgs(['status', '--porcelain'], validation.path, 'Status');
});

ipcMain.handle('git-commit', async (event, projectPath, message) => {
  const validation = validateGitPath(projectPath);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  if (!message || !message.trim()) {
    return { success: false, error: 'Commit message cannot be empty' };
  }

  const normalizedMessage = message.trim();
  if (/[`$\r\n]/.test(normalizedMessage)) {
    return { success: false, error: 'Commit message contains unsupported characters' };
  }

  const addResult = await executeGitArgs(['add', '.'], validation.path, 'Stage Changes');
  if (!addResult.success) {
    return addResult;
  }

  const result = await executeGitArgs(['commit', '-m', normalizedMessage], validation.path, 'Commit');

  // Record operation for undo functionality
  if (result.success) {
    recordGitOperation({
      type: 'commit',
      message: normalizedMessage,
      projectPath: validation.path
    });
  }

  return result;
});

// Git pull with conflict detection
ipcMain.handle('git-pull', async (event, projectPath) => {
  const validation = validateGitPath(projectPath);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  // Check for uncommitted changes first
  const statusCheck = await executeGitArgs(['status', '--porcelain'], validation.path, 'Status Check');
  if (statusCheck.success && statusCheck.output && statusCheck.output.trim()) {
    logger.warn('Pull attempted with uncommitted changes', { projectPath: validation.path });
  }

  return executeGitArgs(['pull'], validation.path, 'Pull');
});

// Git push with upstream tracking
ipcMain.handle('git-push', async (event, projectPath) => {
  const validation = validateGitPath(projectPath);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  // First try regular push
  let result = await executeGitArgs(['push'], validation.path, 'Push');

  // If it fails due to no upstream, try with -u origin HEAD
  if (!result.success && result.stderr && result.stderr.includes('no upstream branch')) {
    logger.info('No upstream branch, setting up tracking', { projectPath: validation.path });
    result = await executeGitArgs(['push', '-u', 'origin', 'HEAD'], validation.path, 'Push with upstream');
  }

  return result;
});

// Git fetch
ipcMain.handle('git-fetch', async (event, projectPath) => {
  const validation = validateGitPath(projectPath);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  return executeGitArgs(['fetch'], validation.path, 'Fetch');
});

// Git sync (pull then push)
ipcMain.handle('git-sync', async (event, projectPath) => {
  const validation = validateGitPath(projectPath);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const pullResult = await executeGitArgs(['pull'], validation.path, 'Sync Pull');
  if (!pullResult.success) {
    return pullResult;
  }

  const pushResult = await executeGitArgs(['push'], validation.path, 'Sync Push');
  if (!pushResult.success) {
    return pushResult;
  }

  return {
    success: true,
    output: [pullResult.output, pushResult.output].filter(Boolean).join('\n')
  };
});

// Git get branches
ipcMain.handle('git-branches', async (event, projectPath) => {
  const validation = validateGitPath(projectPath);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  if (!(await isGitRepositoryRoot(validation.path))) {
    return { success: false, error: 'This is not a git repository. Initialize it first.' };
  }

  return executeGitArgs(['branch', '-a'], validation.path, 'List Branches');
});

// Git create branch
ipcMain.handle('git-create-branch', async (event, projectPath, branchName) => {
  const pathValidation = validateGitPath(projectPath);
  if (!pathValidation.valid) {
    return { success: false, error: pathValidation.error };
  }

  const branchValidation = validateGitRefName(branchName, 'Branch name');
  if (!branchValidation.valid) {
    return { success: false, error: branchValidation.error };
  }

  return executeGitArgs(['checkout', '-b', branchValidation.value], pathValidation.path, 'Create Branch');
});

// Git checkout branch
ipcMain.handle('git-checkout', async (event, projectPath, branchName) => {
  const pathValidation = validateGitPath(projectPath);
  if (!pathValidation.valid) {
    return { success: false, error: pathValidation.error };
  }

  const branchValidation = validateGitRefName(branchName, 'Branch name');
  if (!branchValidation.valid) {
    return { success: false, error: branchValidation.error };
  }

  return executeGitArgs(['checkout', branchValidation.value], pathValidation.path, 'Checkout Branch');
});

// Git delete branch
ipcMain.handle('git-delete-branch', async (event, projectPath, branchName) => {
  const pathValidation = validateGitPath(projectPath);
  if (!pathValidation.valid) {
    return { success: false, error: pathValidation.error };
  }

  const branchValidation = validateGitRefName(branchName, 'Branch name');
  if (!branchValidation.valid) {
    return { success: false, error: branchValidation.error };
  }

  return executeGitArgs(['branch', '-d', branchValidation.value], pathValidation.path, 'Delete Branch');
});

// Git stash
ipcMain.handle('git-stash', async (event, projectPath, message) => {
  const pathValidation = validateGitPath(projectPath);
  if (!pathValidation.valid) {
    return { success: false, error: pathValidation.error };
  }

  const stashMessage = typeof message === 'string' ? message.trim() : '';
  if (stashMessage && /["`$\r\n]/.test(stashMessage)) {
    return { success: false, error: 'Stash message contains unsupported characters' };
  }

  const stashArgs = stashMessage
    ? ['stash', 'push', '-m', stashMessage]
    : ['stash'];
  return executeGitArgs(stashArgs, pathValidation.path, 'Stash');
});

// Git stash list
ipcMain.handle('git-stash-list', async (event, projectPath) => {
  const pathValidation = validateGitPath(projectPath);
  if (!pathValidation.valid) {
    return { success: false, error: pathValidation.error };
  }

  return executeGitArgs(['stash', 'list'], pathValidation.path, 'Stash List');
});

// Git stash apply
ipcMain.handle('git-stash-apply', async (event, projectPath, stashIndex) => {
  const pathValidation = validateGitPath(projectPath);
  if (!pathValidation.valid) {
    return { success: false, error: pathValidation.error };
  }

  let validatedStashIndex = null;
  if (stashIndex !== undefined && stashIndex !== null && stashIndex !== '') {
    const parsedIndex = Number.parseInt(stashIndex, 10);
    if (!Number.isInteger(parsedIndex) || parsedIndex < 0) {
      return { success: false, error: 'Invalid stash index' };
    }
    validatedStashIndex = parsedIndex;
  }

  const stashRef = validatedStashIndex !== null ? `stash@{${validatedStashIndex}}` : null;
  const stashApplyArgs = stashRef ? ['stash', 'apply', stashRef] : ['stash', 'apply'];
  return executeGitArgs(stashApplyArgs, pathValidation.path, 'Stash Apply');
});

// Git stash pop
ipcMain.handle('git-stash-pop', async (event, projectPath) => {
  const pathValidation = validateGitPath(projectPath);
  if (!pathValidation.valid) {
    return { success: false, error: pathValidation.error };
  }

  return executeGitArgs(['stash', 'pop'], pathValidation.path, 'Stash Pop');
});

// Git diff
ipcMain.handle('git-diff', async (event, projectPath, filename) => {
  const pathValidation = validateGitPath(projectPath);
  if (!pathValidation.valid) {
    return { success: false, error: pathValidation.error };
  }

  let diffTarget = null;
  if (filename) {
    const fileValidation = validateGitFilePathInput(filename);
    if (!fileValidation.valid) {
      return { success: false, error: fileValidation.error };
    }
    diffTarget = fileValidation.value;
  }

  const diffArgs = ['diff'];
  if (diffTarget) {
    diffArgs.push('--', diffTarget);
  }
  return executeGitArgs(diffArgs, pathValidation.path, 'Diff');
});

ipcMain.handle('git-diff-hunks', async (event, projectPath, filename, mode = 'unstaged') => {
  const pathValidation = validateGitPath(projectPath);
  if (!pathValidation.valid) {
    return { success: false, error: pathValidation.error };
  }

  const fileValidation = validateGitFilePathInput(filename);
  if (!fileValidation.valid) {
    return { success: false, error: fileValidation.error };
  }

  const normalizedMode = mode === 'staged' ? 'staged' : 'unstaged';
  const diffArgs = normalizedMode === 'staged'
    ? ['diff', '--cached', '--', fileValidation.value]
    : ['diff', '--', fileValidation.value];
  const diffResult = await executeGitArgs(diffArgs, pathValidation.path, `Diff Hunks (${normalizedMode})`);
  if (!diffResult.success) {
    return diffResult;
  }

  const hunks = splitUnifiedDiffIntoHunks(diffResult.output);
  return {
    success: true,
    mode: normalizedMode,
    hunks: hunks.map((hunk) => ({
      id: hunk.id,
      header: hunk.header,
      preview: hunk.preview
    }))
  };
});

ipcMain.handle('git-apply-hunks', async (event, projectPath, filename, mode = 'unstaged', hunkIds = []) => {
  const pathValidation = validateGitPath(projectPath);
  if (!pathValidation.valid) {
    return { success: false, error: pathValidation.error };
  }

  const fileValidation = validateGitFilePathInput(filename);
  if (!fileValidation.valid) {
    return { success: false, error: fileValidation.error };
  }

  const normalizedMode = mode === 'staged' ? 'staged' : 'unstaged';
  const requestedIds = Array.isArray(hunkIds)
    ? [...new Set(hunkIds.map((id) => Number.parseInt(id, 10)).filter((id) => Number.isInteger(id) && id > 0))]
    : [];
  if (requestedIds.length === 0) {
    return { success: false, error: 'Select at least one hunk' };
  }

  const diffArgs = normalizedMode === 'staged'
    ? ['diff', '--cached', '--', fileValidation.value]
    : ['diff', '--', fileValidation.value];
  const diffResult = await executeGitArgs(diffArgs, pathValidation.path, `Diff Hunks (${normalizedMode})`);
  if (!diffResult.success) {
    return diffResult;
  }

  const hunks = splitUnifiedDiffIntoHunks(diffResult.output);
  if (hunks.length === 0) {
    return { success: false, error: 'No hunks found for this file' };
  }

  const selectedHunks = hunks.filter((hunk) => requestedIds.includes(hunk.id));
  if (selectedHunks.length === 0) {
    return { success: false, error: 'Selected hunks no longer match current diff. Refresh and try again.' };
  }

  let appliedCount = 0;
  for (const hunk of selectedHunks) {
    const applyResult = await applyGitPatchToIndex(pathValidation.path, hunk.patch, {
      reverse: normalizedMode === 'staged'
    });
    if (!applyResult.success) {
      return {
        success: false,
        error: applyResult.error || 'Failed to apply selected hunks',
        appliedCount
      };
    }
    appliedCount += 1;
  }

  return {
    success: true,
    mode: normalizedMode,
    appliedCount,
    totalRequested: selectedHunks.length
  };
});

ipcMain.handle('git-list-conflicts', async (event, projectPath) => {
  const pathValidation = validateGitPath(projectPath);
  if (!pathValidation.valid) {
    return { success: false, error: pathValidation.error, conflicts: [] };
  }

  const statusResult = await executeGitArgs(['status', '--porcelain'], pathValidation.path, 'List Conflicts');
  if (!statusResult.success) {
    return { ...statusResult, conflicts: [] };
  }

  const conflictCodes = new Set(['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']);
  const conflicts = [];
  const lines = (statusResult.output || '').split('\n').map((line) => line.trimEnd()).filter(Boolean);
  for (const line of lines) {
    if (line.length < 4) {
      continue;
    }

    const code = line.slice(0, 2);
    if (!conflictCodes.has(code)) {
      continue;
    }

    const rawFile = line.slice(3).trim();
    const file = rawFile.includes(' -> ')
      ? rawFile.split(' -> ').pop().trim()
      : rawFile;
    if (!file) {
      continue;
    }

    conflicts.push({
      file,
      code
    });
  }

  return {
    success: true,
    conflicts
  };
});

ipcMain.handle('git-resolve-conflict', async (event, projectPath, filename, strategy = 'mark-resolved') => {
  const pathValidation = validateGitPath(projectPath);
  if (!pathValidation.valid) {
    return { success: false, error: pathValidation.error };
  }

  const fileValidation = validateGitFilePathInput(filename);
  if (!fileValidation.valid) {
    return { success: false, error: fileValidation.error };
  }

  const normalizedStrategy = typeof strategy === 'string' ? strategy.trim() : '';
  if (!['ours', 'theirs', 'mark-resolved'].includes(normalizedStrategy)) {
    return { success: false, error: 'Unsupported conflict strategy' };
  }

  if (normalizedStrategy === 'ours' || normalizedStrategy === 'theirs') {
    const checkoutResult = await executeGitArgs(
      ['checkout', `--${normalizedStrategy}`, '--', fileValidation.value],
      pathValidation.path,
      `Resolve Conflict ${normalizedStrategy}`
    );
    if (!checkoutResult.success) {
      return checkoutResult;
    }
  }

  const addResult = await executeGitArgs(['add', '--', fileValidation.value], pathValidation.path, 'Mark Conflict Resolved');
  if (!addResult.success) {
    return addResult;
  }

  return { success: true };
});

ipcMain.handle('git-abort-merge', async (event, projectPath) => {
  const pathValidation = validateGitPath(projectPath);
  if (!pathValidation.valid) {
    return { success: false, error: pathValidation.error };
  }

  return executeGitArgs(['merge', '--abort'], pathValidation.path, 'Abort Merge');
});

ipcMain.handle('git-continue-merge', async (event, projectPath) => {
  const pathValidation = validateGitPath(projectPath);
  if (!pathValidation.valid) {
    return { success: false, error: pathValidation.error };
  }

  return executeGitArgs(['merge', '--continue'], pathValidation.path, 'Continue Merge');
});

// Git log
ipcMain.handle('git-log', async (event, projectPath, limit = 50) => {
  const pathValidation = validateGitPath(projectPath);
  if (!pathValidation.valid) {
    return { success: false, error: pathValidation.error };
  }

  const parsedLimit = Number.parseInt(limit, 10);
  const safeLimit = Number.isInteger(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 200)) : 50;

  return executeGitArgs(
    ['log', '--pretty=format:%H|%an|%ae|%ad|%s', '--date=iso', '-n', String(safeLimit)],
    pathValidation.path,
    'Log'
  );
});

// Git remote list
ipcMain.handle('git-remote-list', async (event, projectPath) => {
  const pathValidation = validateGitPath(projectPath);
  if (!pathValidation.valid) {
    return { success: false, error: pathValidation.error };
  }

  return executeGitArgs(['remote', '-v'], pathValidation.path, 'Remote List');
});

// Git add remote
ipcMain.handle('git-add-remote', async (event, projectPath, name, url) => {
  const pathValidation = validateGitPath(projectPath);
  if (!pathValidation.valid) {
    return { success: false, error: pathValidation.error };
  }

  const remoteNameValidation = validateGitRemoteName(name);
  if (!remoteNameValidation.valid) {
    return { success: false, error: remoteNameValidation.error };
  }

  const remoteUrlValidation = validateGitRemoteUrl(url);
  if (!remoteUrlValidation.valid) {
    return { success: false, error: remoteUrlValidation.error };
  }

  return executeGitArgs(
    ['remote', 'add', remoteNameValidation.value, remoteUrlValidation.value],
    pathValidation.path,
    'Add Remote'
  );
});

// Git remove remote
ipcMain.handle('git-remove-remote', async (event, projectPath, name) => {
  const pathValidation = validateGitPath(projectPath);
  if (!pathValidation.valid) {
    return { success: false, error: pathValidation.error };
  }

  const remoteNameValidation = validateGitRemoteName(name);
  if (!remoteNameValidation.valid) {
    return { success: false, error: remoteNameValidation.error };
  }

  return executeGitArgs(['remote', 'remove', remoteNameValidation.value], pathValidation.path, 'Remove Remote');
});

// Git merge
ipcMain.handle('git-merge', async (event, projectPath, branchName) => {
  const pathValidation = validateGitPath(projectPath);
  if (!pathValidation.valid) {
    return { success: false, error: pathValidation.error };
  }

  const branchValidation = validateGitRefName(branchName, 'Branch name');
  if (!branchValidation.valid) {
    return { success: false, error: branchValidation.error };
  }

  return executeGitArgs(['merge', branchValidation.value], pathValidation.path, 'Merge');
});

// Advanced Git Operations

// Git rebase
ipcMain.handle('git-rebase', async (event, projectPath, targetBranch) => {
  const pathValidation = validateGitPath(projectPath);
  if (!pathValidation.valid) {
    return { success: false, error: pathValidation.error };
  }

  const branchValidation = validateGitRefName(targetBranch, 'Target branch');
  if (!branchValidation.valid) {
    return { success: false, error: branchValidation.error };
  }

  return executeGitArgs(['rebase', branchValidation.value], pathValidation.path, 'Rebase');
});

// Git cherry-pick
ipcMain.handle('git-cherry-pick', async (event, projectPath, commitHash, noCommit = false) => {
  const pathValidation = validateGitPath(projectPath);
  if (!pathValidation.valid) {
    return { success: false, error: pathValidation.error };
  }

  const hashValidation = validateGitHash(commitHash);
  if (!hashValidation.valid) {
    return { success: false, error: hashValidation.error };
  }

  const cherryPickArgs = noCommit
    ? ['cherry-pick', '--no-commit', hashValidation.value]
    : ['cherry-pick', hashValidation.value];
  return executeGitArgs(cherryPickArgs, pathValidation.path, 'Cherry Pick');
});

// Git tag list
ipcMain.handle('git-tag-list', async (event, projectPath) => {
  const pathValidation = validateGitPath(projectPath);
  if (!pathValidation.valid) {
    return { success: false, error: pathValidation.error };
  }

  return executeGitArgs(['tag', '-l', '-n'], pathValidation.path, 'Tag List');
});

// Git create tag
ipcMain.handle('git-tag-create', async (event, projectPath, tagName, message, pushToRemote = false) => {
  const pathValidation = validateGitPath(projectPath);
  if (!pathValidation.valid) {
    return { success: false, error: pathValidation.error };
  }

  const tagValidation = validateGitRefName(tagName, 'Tag name');
  if (!tagValidation.valid) {
    return { success: false, error: tagValidation.error };
  }

  const tagMessage = typeof message === 'string' ? message.trim() : '';
  if (tagMessage && /["`$\r\n]/.test(tagMessage)) {
    return { success: false, error: 'Tag message contains unsupported characters' };
  }

  const createTagArgs = tagMessage
    ? ['tag', '-a', tagValidation.value, '-m', tagMessage]
    : ['tag', tagValidation.value];
  const createResult = await executeGitArgs(createTagArgs, pathValidation.path, 'Tag Create');

  if (!createResult.success) {
    return createResult;
  }

  if (!pushToRemote) {
    return { success: true, output: createResult.output };
  }

  const pushResult = await executeGitArgs(['push', 'origin', tagValidation.value], pathValidation.path, 'Tag Push');
  if (!pushResult.success) {
    return { success: true, output: createResult.output, pushWarning: pushResult.error };
  }

  return { success: true, output: createResult.output, pushed: true };
});

// Git delete tag
ipcMain.handle('git-tag-delete', async (event, projectPath, tagName, deleteRemote = false) => {
  const pathValidation = validateGitPath(projectPath);
  if (!pathValidation.valid) {
    return { success: false, error: pathValidation.error };
  }

  const tagValidation = validateGitRefName(tagName, 'Tag name');
  if (!tagValidation.valid) {
    return { success: false, error: tagValidation.error };
  }

  const deleteResult = await executeGitArgs(['tag', '-d', tagValidation.value], pathValidation.path, 'Tag Delete');
  if (!deleteResult.success) {
    return deleteResult;
  }

  if (!deleteRemote) {
    return { success: true, output: deleteResult.output };
  }

  const remoteRefspec = `:refs/tags/${tagValidation.value}`;
  const pushDeleteResult = await executeGitArgs(['push', 'origin', remoteRefspec], pathValidation.path, 'Tag Delete Remote');
  return {
    success: true,
    output: deleteResult.output,
    remoteDeleted: pushDeleteResult.success
  };
});

// Git reset
ipcMain.handle('git-reset', async (event, projectPath, target, mode = 'mixed') => {
  const pathValidation = validateGitPath(projectPath);
  if (!pathValidation.valid) {
    return { success: false, error: pathValidation.error };
  }

  const resetTarget = typeof target === 'string' ? target.trim() : '';
  if (
    !resetTarget ||
    !/^[A-Za-z0-9._/@~^:-]+$/.test(resetTarget) ||
    resetTarget.includes('..') ||
    resetTarget.startsWith('-') ||
    resetTarget.includes('@{')
  ) {
    return { success: false, error: 'Invalid reset target' };
  }

  const modeFlag = mode === 'soft' ? '--soft' : mode === 'hard' ? '--hard' : '--mixed';
  return executeGitArgs(['reset', modeFlag, resetTarget], pathValidation.path, 'Reset');
});

// Git revert
ipcMain.handle('git-revert', async (event, projectPath, commitHash) => {
  const pathValidation = validateGitPath(projectPath);
  if (!pathValidation.valid) {
    return { success: false, error: pathValidation.error };
  }

  const hashValidation = validateGitHash(commitHash);
  if (!hashValidation.valid) {
    return { success: false, error: hashValidation.error };
  }

  return executeGitArgs(['revert', hashValidation.value, '--no-edit'], pathValidation.path, 'Revert');
});

// Git clean
ipcMain.handle('git-clean', async (event, projectPath, force = false, includeDirectories = false) => {
  const pathValidation = validateGitPath(projectPath);
  if (!pathValidation.valid) {
    return { success: false, error: pathValidation.error };
  }

  const cleanArgs = ['clean'];
  if (force) cleanArgs.push('-f');
  if (includeDirectories) cleanArgs.push('-d');
  return executeGitArgs(cleanArgs, pathValidation.path, 'Clean');
});

// GitHub Integration

function normalizeGitHubTokenInput(tokenInput) {
  if (typeof tokenInput !== 'string') {
    return { valid: false, error: 'GitHub token is required' };
  }

  const token = tokenInput.trim();
  if (!token) {
    return { valid: false, error: 'GitHub token is required' };
  }

  if (token.length < 20 || token.length > 512 || /\s/.test(token)) {
    return { valid: false, error: 'GitHub token format is invalid' };
  }

  return { valid: true, token };
}

function getStoredGitHubToken() {
  const encryptedToken = appSettings[GITHUB_TOKEN_ENCRYPTED_KEY];
  if (typeof encryptedToken === 'string' && encryptedToken.trim()) {
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(Buffer.from(encryptedToken, 'base64'));
      } catch (error) {
        logger.warn('Failed to decrypt stored GitHub token', { error: error.message });
      }
    }
  }

  const legacyToken = appSettings[GITHUB_TOKEN_LEGACY_KEY];
  return typeof legacyToken === 'string' ? legacyToken.trim() : '';
}

async function persistGitHubToken(token) {
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(token).toString('base64');
    appSettings[GITHUB_TOKEN_ENCRYPTED_KEY] = encrypted;
    delete appSettings[GITHUB_TOKEN_LEGACY_KEY];
  } else {
    appSettings[GITHUB_TOKEN_LEGACY_KEY] = token;
    delete appSettings[GITHUB_TOKEN_ENCRYPTED_KEY];
  }

  return saveSettings();
}

async function clearStoredGitHubToken() {
  delete appSettings[GITHUB_TOKEN_ENCRYPTED_KEY];
  delete appSettings[GITHUB_TOKEN_LEGACY_KEY];
  return saveSettings();
}

async function migrateGitHubTokenStorage() {
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
    return;
  }

  const legacyToken = typeof appSettings[GITHUB_TOKEN_LEGACY_KEY] === 'string'
    ? appSettings[GITHUB_TOKEN_LEGACY_KEY].trim()
    : '';

  if (!legacyToken || typeof appSettings[GITHUB_TOKEN_ENCRYPTED_KEY] === 'string') {
    return;
  }

  const saved = await persistGitHubToken(legacyToken);
  if (saved) {
    logger.info('Migrated GitHub token storage to encrypted format');
  } else {
    logger.warn('Failed to migrate GitHub token storage');
  }
}

function extractGitHubErrorMessage(payload, fallback = 'GitHub request failed') {
  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.errors) && payload.errors[0] && payload.errors[0].message) {
      return String(payload.errors[0].message);
    }
    if (typeof payload.message === 'string' && payload.message.trim()) {
      return payload.message.trim();
    }
  }

  return fallback;
}

function normalizeGitHubRepoData(repoData) {
  if (!repoData || typeof repoData !== 'object' || Array.isArray(repoData)) {
    return { valid: false, error: 'Repository details are invalid' };
  }

  const name = typeof repoData.name === 'string' ? repoData.name.trim() : '';
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name.startsWith('.') || name.endsWith('.')) {
    return { valid: false, error: 'Repository name is invalid' };
  }

  const descriptionRaw = typeof repoData.description === 'string' ? repoData.description.trim() : '';
  const description = descriptionRaw.slice(0, 300);

  return {
    valid: true,
    value: {
      name,
      description,
      isPrivate: Boolean(repoData.isPrivate),
      addReadme: Boolean(repoData.addReadme),
      addGitignore: Boolean(repoData.addGitignore),
      addLicense: Boolean(repoData.addLicense)
    }
  };
}

function buildAuthenticatedGitHubRemoteUrl(repoUrl, token) {
  if (typeof repoUrl !== 'string' || !repoUrl.trim()) {
    return null;
  }
  if (typeof token !== 'string' || !token.trim()) {
    return null;
  }

  try {
    const parsed = new URL(repoUrl);
    if (parsed.protocol !== 'https:') {
      return null;
    }

    const safeToken = encodeURIComponent(token.trim());
    return `https://x-access-token:${safeToken}@${parsed.host}${parsed.pathname}`;
  } catch {
    return null;
  }
}

function normalizeGitHubUploadSelection(rawSelection) {
  if (rawSelection == null) {
    return { valid: true, value: [] };
  }

  if (!Array.isArray(rawSelection)) {
    return { valid: false, error: 'Selected upload paths are invalid' };
  }

  if (rawSelection.length > MAX_GITHUB_UPLOAD_CANDIDATES) {
    return { valid: false, error: 'Too many selected upload items' };
  }

  const unique = [];
  const seen = new Set();

  for (const rawPath of rawSelection) {
    const validation = validateGitFilePathInput(rawPath);
    if (!validation.valid) {
      return { valid: false, error: 'Selected upload paths contain invalid entries' };
    }

    const normalizedPath = validation.value;
    if (!seen.has(normalizedPath)) {
      seen.add(normalizedPath);
      unique.push(normalizedPath);
    }
  }

  return { valid: true, value: unique };
}

function isResolvedPathInsideRoot(rootPath, candidatePath) {
  const rootResolved = path.resolve(rootPath);
  const candidateResolved = path.resolve(candidatePath);

  if (process.platform === 'win32') {
    const rootLower = rootResolved.toLowerCase();
    const candidateLower = candidateResolved.toLowerCase();
    return candidateLower === rootLower || candidateLower.startsWith(rootLower + path.sep);
  }

  return candidateResolved === rootResolved || candidateResolved.startsWith(rootResolved + path.sep);
}

function isGitHubUploadPathExcluded(relativePath) {
  if (typeof relativePath !== 'string') {
    return false;
  }

  const normalized = relativePath.replace(/\\/g, '/').trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) {
    return false;
  }

  if (segments.includes('.git')) {
    return true;
  }

  return segments.some((segment) => GITHUB_UPLOAD_HARD_EXCLUDED_DIRS.has(segment));
}

function chunkArray(values, chunkSize) {
  if (!Array.isArray(values) || values.length === 0) {
    return [];
  }

  const chunks = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function safeRemoveDirectory(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') {
    return;
  }

  try {
    await fs.rm(targetPath, { recursive: true, force: true });
  } catch (error) {
    logger.warn('Failed to cleanup temporary directory', {
      targetPath,
      error: error.message
    });
  }
}

async function copyGitHubUploadPathRecursive(sourcePath, destinationPath) {
  const sourceBaseName = path.basename(sourcePath).toLowerCase();
  if (sourceBaseName === '.git' || GITHUB_UPLOAD_HARD_EXCLUDED_DIRS.has(sourceBaseName)) {
    return 0;
  }

  const sourceStat = await fs.lstat(sourcePath);
  if (sourceStat.isSymbolicLink()) {
    return 0;
  }

  if (sourceStat.isDirectory()) {
    await fs.mkdir(destinationPath, { recursive: true });
    const entries = await fs.readdir(sourcePath, { withFileTypes: true });
    let copiedFiles = 0;
    for (const entry of entries) {
      const entryNameLower = entry.name.toLowerCase();
      if (entryNameLower === '.git' || GITHUB_UPLOAD_HARD_EXCLUDED_DIRS.has(entryNameLower)) {
        continue;
      }
      const entrySourcePath = path.join(sourcePath, entry.name);
      const entryDestinationPath = path.join(destinationPath, entry.name);
      copiedFiles += await copyGitHubUploadPathRecursive(entrySourcePath, entryDestinationPath);
    }
    return copiedFiles;
  }

  if (!sourceStat.isFile()) {
    return 0;
  }

  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.copyFile(sourcePath, destinationPath);
  return 1;
}

function buildDefaultUploadReadme(repoName, description) {
  const safeName = typeof repoName === 'string' && repoName.trim() ? repoName.trim() : 'Project';
  const safeDescription = typeof description === 'string' ? description.trim() : '';
  const lines = [`# ${safeName}`];
  if (safeDescription) {
    lines.push('', safeDescription);
  } else {
    lines.push('', 'Project uploaded with Project Manager.');
  }
  lines.push('', '## Getting Started', '', 'Describe setup and usage for this project here.');
  return lines.join('\n') + '\n';
}

function buildDefaultUploadGitignore() {
  return [
    '# Dependencies',
    'node_modules/',
    '',
    '# Build outputs',
    'dist/',
    'build/',
    'out/',
    '',
    '# Logs',
    '*.log',
    'npm-debug.log*',
    'yarn-debug.log*',
    'yarn-error.log*',
    '',
    '# Environment',
    '.env',
    '.env.*',
    '',
    '# OS files',
    '.DS_Store',
    'Thumbs.db'
  ].join('\n') + '\n';
}

function buildDefaultUploadLicense(ownerName) {
  const year = new Date().getFullYear();
  const holder = typeof ownerName === 'string' && ownerName.trim() ? ownerName.trim() : 'Project Manager User';
  return [
    'MIT License',
    '',
    `Copyright (c) ${year} ${holder}`,
    '',
    'Permission is hereby granted, free of charge, to any person obtaining a copy',
    'of this software and associated documentation files (the "Software"), to deal',
    'in the Software without restriction, including without limitation the rights',
    'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
    'copies of the Software, and to permit persons to whom the Software is',
    'furnished to do so, subject to the following conditions:',
    '',
    'The above copyright notice and this permission notice shall be included in all',
    'copies or substantial portions of the Software.',
    '',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
    'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
    'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
    'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
    'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
    'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
    'SOFTWARE.'
  ].join('\n') + '\n';
}

async function writeGitHubUploadOptionalFiles(uploadRoot, repoSettings, ownerName) {
  let addedFileCount = 0;

  if (repoSettings.addReadme) {
    const readmePath = path.join(uploadRoot, 'README.md');
    if (!(await pathExists(readmePath))) {
      await fs.writeFile(readmePath, buildDefaultUploadReadme(repoSettings.name, repoSettings.description), 'utf8');
      addedFileCount += 1;
    }
  }

  if (repoSettings.addGitignore) {
    const gitignorePath = path.join(uploadRoot, '.gitignore');
    if (!(await pathExists(gitignorePath))) {
      await fs.writeFile(gitignorePath, buildDefaultUploadGitignore(), 'utf8');
      addedFileCount += 1;
    }
  }

  if (repoSettings.addLicense) {
    const licensePath = path.join(uploadRoot, 'LICENSE');
    if (!(await pathExists(licensePath))) {
      await fs.writeFile(licensePath, buildDefaultUploadLicense(ownerName), 'utf8');
      addedFileCount += 1;
    }
  }

  return addedFileCount;
}

async function listGitHubUploadCandidates(projectRoot) {
  const items = [];
  const queue = [{ absPath: projectRoot, relativePath: '', depth: 0 }];
  let truncated = false;

  while (queue.length > 0) {
    const current = queue.pop();
    let entries;
    try {
      entries = await fs.readdir(current.absPath, { withFileTypes: true });
    } catch (error) {
      logger.warn('Skipping unreadable directory while building upload candidates', {
        projectRoot,
        absPath: current.absPath,
        error: error.message
      });
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

    for (const entry of entries) {
      const entryNameLower = entry.name.toLowerCase();
      if (entryNameLower === '.git' || GITHUB_UPLOAD_HARD_EXCLUDED_DIRS.has(entryNameLower)) {
        continue;
      }

      const absoluteEntryPath = path.join(current.absPath, entry.name);
      const relativeEntryPath = current.relativePath
        ? `${current.relativePath}/${entry.name}`
        : entry.name;
      const normalizedRelativePath = relativeEntryPath.replace(/\\/g, '/');

      let stat;
      try {
        stat = await fs.lstat(absoluteEntryPath);
      } catch {
        continue;
      }

      const isDirectory = stat.isDirectory() && !stat.isSymbolicLink();
      items.push({
        path: normalizedRelativePath,
        parentPath: current.relativePath || '',
        name: entry.name,
        type: isDirectory ? 'directory' : 'file',
        size: isDirectory ? 0 : Number(stat.size) || 0,
        mtimeMs: Number(stat.mtimeMs) || 0
      });

      if (items.length >= MAX_GITHUB_UPLOAD_CANDIDATES) {
        truncated = true;
        break;
      }

      if (isDirectory && current.depth < MAX_GITHUB_UPLOAD_DEPTH) {
        queue.push({
          absPath: absoluteEntryPath,
          relativePath: normalizedRelativePath,
          depth: current.depth + 1
        });
      }
    }

    if (truncated) {
      break;
    }
  }

  return { items, truncated };
}

async function requestGitHubApi({ token, method = 'GET', apiPath, body = null }) {
  const https = require('https');
  const headers = {
    'Authorization': `token ${token}`,
    'User-Agent': 'ProjectManager',
    'Accept': 'application/vnd.github+json'
  };

  let requestBody = null;
  if (body != null) {
    requestBody = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(requestBody);
  }

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: apiPath,
      method,
      headers
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        if (data.trim()) {
          try {
            parsed = JSON.parse(data);
          } catch {
            // Response is not JSON. Keep raw payload for diagnostics.
          }
        }

        const statusCode = Number(res.statusCode || 0);
        const success = statusCode >= 200 && statusCode < 300;
        if (success) {
          resolve({ success: true, statusCode, data, parsed });
          return;
        }

        const fallbackMessage = statusCode
          ? `GitHub API request failed (${statusCode})`
          : 'GitHub API request failed';
        resolve({
          success: false,
          statusCode,
          data,
          parsed,
          error: extractGitHubErrorMessage(parsed, fallbackMessage)
        });
      });
    });

    req.setTimeout(GITHUB_REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('GitHub request timed out'));
    });

    req.on('error', (error) => {
      resolve({ success: false, statusCode: 0, error: error.message });
    });

    if (requestBody != null) {
      req.write(requestBody);
    }
    req.end();
  });
}

// Save GitHub token
ipcMain.handle('github-save-token', async (event, token) => {
  const tokenValidation = normalizeGitHubTokenInput(token);
  if (!tokenValidation.valid) {
    return { success: false, error: tokenValidation.error };
  }

  const authResult = await requestGitHubApi({
    token: tokenValidation.token,
    method: 'GET',
    apiPath: '/user'
  });

  if (!authResult.success) {
    return { success: false, error: authResult.error || 'Failed to validate GitHub token' };
  }

  const saved = await persistGitHubToken(tokenValidation.token);
  if (!saved) {
    return { success: false, error: 'Failed to persist GitHub token' };
  }

  return {
    success: true,
    user: authResult.parsed || null
  };
});

// Get GitHub user info
ipcMain.handle('github-get-user', async () => {
  const token = getStoredGitHubToken();
  if (!token) {
    return { success: false, error: 'No GitHub token found' };
  }

  const result = await requestGitHubApi({
    token,
    method: 'GET',
    apiPath: '/user'
  });

  if (!result.success) {
    if (result.statusCode === 401) {
      await clearStoredGitHubToken();
    }
    return { success: false, error: result.error || 'Failed to fetch user info' };
  }

  return { success: true, user: result.parsed || null };
});

// Create GitHub repository
ipcMain.handle('github-create-repo', async (event, repoData) => {
  const token = getStoredGitHubToken();
  if (!token) {
    return { success: false, error: 'No GitHub token found' };
  }

  const repoValidation = normalizeGitHubRepoData(repoData);
  if (!repoValidation.valid) {
    return { success: false, error: repoValidation.error };
  }

  const createResult = await requestGitHubApi({
    token,
    method: 'POST',
    apiPath: '/user/repos',
    body: {
      name: repoValidation.value.name,
      description: repoValidation.value.description,
      private: repoValidation.value.isPrivate,
      auto_init: repoValidation.value.addReadme
    }
  });

  if (!createResult.success) {
    return {
      success: false,
      error: createResult.error || 'Failed to create repository',
      details: createResult.data
    };
  }

  return { success: true, repo: createResult.parsed || null };
});

ipcMain.handle('github-list-upload-candidates', async (event, projectPath) => {
  const pathValidation = validateGitPath(projectPath);
  if (!pathValidation.valid) {
    return { success: false, error: pathValidation.error };
  }

  try {
    const scanResult = await listGitHubUploadCandidates(pathValidation.path);
    return {
      success: true,
      items: scanResult.items,
      truncated: Boolean(scanResult.truncated)
    };
  } catch (error) {
    logger.error('Failed to list upload candidates', {
      projectPath,
      error: error.message
    });
    return { success: false, error: error.message || 'Failed to list upload candidates' };
  }
});

// Upload project to GitHub (with step-by-step progress)
async function handleGitHubUploadProjectRequest(sender, projectPath, repoData, cancellation = { isCancelled: () => false }) {
  const token = getStoredGitHubToken();
  if (!token) {
    return { success: false, error: 'No GitHub token found' };
  }

  const pathValidation = validateGitPath(projectPath);
  if (!pathValidation.valid) {
    return { success: false, error: pathValidation.error };
  }

  const repoValidation = normalizeGitHubRepoData(repoData);
  if (!repoValidation.valid) {
    return { success: false, error: repoValidation.error };
  }

  const selectionValidation = normalizeGitHubUploadSelection(repoData?.selectedPaths);
  if (!selectionValidation.valid) {
    return { success: false, error: selectionValidation.error };
  }

  if (selectionValidation.value.length === 0) {
    return { success: false, error: 'Select at least one file or folder to upload' };
  }

  const selectedUploadPaths = [];
  let excludedSelectionCount = 0;
  for (const selectedPath of selectionValidation.value) {
    if (isGitHubUploadPathExcluded(selectedPath)) {
      excludedSelectionCount += 1;
      continue;
    }

    const absoluteSelectedPath = path.resolve(pathValidation.path, selectedPath);
    if (!isResolvedPathInsideRoot(pathValidation.path, absoluteSelectedPath)) {
      return { success: false, error: `Invalid upload path: ${selectedPath}` };
    }

    try {
      await fs.stat(absoluteSelectedPath);
      selectedUploadPaths.push(selectedPath);
    } catch {
      return { success: false, error: `Selected path no longer exists: ${selectedPath}` };
    }
  }

  if (selectedUploadPaths.length === 0) {
    const suffix = excludedSelectionCount > 0
      ? ' Generated folders are excluded automatically (for example: node_modules, dist, build).'
      : '';
    return {
      success: false,
      error: `Select at least one uploadable file or folder.${suffix}`
    };
  }

  const progressTarget = sender && typeof sender.send === 'function'
    ? sender
    : (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null);
  const sendProgress = (step, status, detail) => {
    if (progressTarget && typeof progressTarget.send === 'function') {
      progressTarget.send('github-upload-progress', { step, status, detail });
    }
  };
  const assertNotCancelled = () => {
    if (cancellation?.isCancelled && cancellation.isCancelled()) {
      const error = new Error('Operation cancelled');
      error.cancelled = true;
      throw error;
    }
  };

  try {
    assertNotCancelled();

    // Step 1: Create the repository
    sendProgress('create-repo', 'active', 'Creating repository on GitHub...');
    const createResult = await requestGitHubApi({
      token,
      method: 'POST',
      apiPath: '/user/repos',
      body: {
        name: repoValidation.value.name,
        description: repoValidation.value.description,
        private: repoValidation.value.isPrivate
      }
    });

    if (!createResult.success || !createResult.parsed || !createResult.parsed.clone_url) {
      const message = createResult.error || 'Failed to create repository';
      sendProgress('create-repo', 'error', message);
      return { success: false, error: message, details: createResult.data };
    }
    sendProgress('create-repo', 'done', repoValidation.value.isPrivate ? 'Private repo created' : 'Public repo created');
    assertNotCancelled();

    const repoUrlValidation = validateGitRemoteUrl(createResult.parsed.clone_url);
    if (!repoUrlValidation.valid) {
      const message = repoUrlValidation.error || 'GitHub returned an invalid repository URL';
      sendProgress('create-repo', 'error', message);
      return { success: false, error: message };
    }

    const repoUrl = repoUrlValidation.value;
    const authenticatedRepoUrl = buildAuthenticatedGitHubRemoteUrl(repoUrl, token);
    const preferredBranch = typeof appSettings.defaultBranch === 'string' &&
      /^[A-Za-z0-9._/-]+$/.test(appSettings.defaultBranch) &&
      !appSettings.defaultBranch.includes('..')
      ? appSettings.defaultBranch
      : 'main';

    let uploadWorkspacePath = null;
    try {
      // Step 2: Prepare isolated upload workspace and initialize git
      assertNotCancelled();
      sendProgress('init-git', 'active', 'Preparing isolated upload workspace...');
      uploadWorkspacePath = await fs.mkdtemp(path.join(os.tmpdir(), GITHUB_UPLOAD_TEMP_PREFIX));
      let copiedFileCount = 0;

      for (let index = 0; index < selectedUploadPaths.length; index += 1) {
        assertNotCancelled();
        const selectedPath = selectedUploadPaths[index];
        const sourcePath = path.resolve(pathValidation.path, selectedPath);
        const destinationPath = path.resolve(uploadWorkspacePath, selectedPath);

        if (!isResolvedPathInsideRoot(uploadWorkspacePath, destinationPath)) {
          const message = `Invalid upload destination for ${selectedPath}`;
          sendProgress('init-git', 'error', message);
          return { success: false, error: message };
        }

        sendProgress(
          'init-git',
          'active',
          `Preparing selected files... ${index + 1}/${selectedUploadPaths.length}`
        );
        copiedFileCount += await copyGitHubUploadPathRecursive(sourcePath, destinationPath);
      }

      assertNotCancelled();
      const optionalFileCount = await writeGitHubUploadOptionalFiles(
        uploadWorkspacePath,
        repoValidation.value,
        createResult.parsed?.owner?.login || ''
      );
      copiedFileCount += optionalFileCount;

      if (copiedFileCount === 0) {
        const message = 'Selected upload items do not contain uploadable files';
        sendProgress('init-git', 'error', message);
        return { success: false, error: message };
      }

      sendProgress('init-git', 'active', 'Initializing temporary Git repository...');
      const initResult = await executeGitArgs(['init'], uploadWorkspacePath, 'Initialize Upload Workspace Git');
      if (!initResult.success) {
        sendProgress('init-git', 'error', initResult.error);
        return { success: false, error: initResult.error };
      }

      sendProgress('init-git', 'done', `Workspace ready (${copiedFileCount} file${copiedFileCount === 1 ? '' : 's'})`);

      // Step 3: Add remote
      assertNotCancelled();
      sendProgress('add-remote', 'active', 'Configuring remote origin...');
      const addRemoteArgs = authenticatedRepoUrl
        ? ['remote', 'add', 'origin', authenticatedRepoUrl]
        : ['remote', 'add', 'origin', repoUrl];
      const addRemoteOptions = authenticatedRepoUrl
        ? {
            commandDisplay: `git remote add origin ${repoUrl}`,
            sensitive: true
          }
        : {};
      const addRemoteResult = await executeGitArgs(addRemoteArgs, uploadWorkspacePath, 'Add Upload Remote', addRemoteOptions);
      if (!addRemoteResult.success) {
        sendProgress('add-remote', 'error', addRemoteResult.error);
        return { success: false, error: addRemoteResult.error };
      }
      sendProgress('add-remote', 'done', repoUrl.replace('https://github.com/', ''));

      // Step 4: Stage files
      assertNotCancelled();
      sendProgress('stage-files', 'active', 'Staging selected files...');
      const stageResult = await executeGitArgs(['add', '--all', '.'], uploadWorkspacePath, 'Stage Upload Workspace');
      if (!stageResult.success) {
        sendProgress('stage-files', 'error', stageResult.error);
        return { success: false, error: stageResult.error };
      }

      const stagedDiffResult = await executeGitArgs(['diff', '--cached', '--numstat'], uploadWorkspacePath, 'Staged File Count');
      const fileCountResult = stagedDiffResult.success && stagedDiffResult.output
        ? stagedDiffResult.output.trim().split('\n').filter((line) => line).length
        : 0;
      if (fileCountResult === 0) {
        const message = 'No files were staged for upload';
        sendProgress('stage-files', 'error', message);
        return { success: false, error: message };
      }
      sendProgress('stage-files', 'done', `${fileCountResult} file${fileCountResult !== 1 ? 's' : ''} staged`);

      // Step 5: Commit
      assertNotCancelled();
      sendProgress('commit', 'active', 'Creating initial commit...');

      const gitUsername = typeof appSettings.gitUsername === 'string' ? appSettings.gitUsername.trim() : '';
      const gitEmail = typeof appSettings.gitEmail === 'string' ? appSettings.gitEmail.trim() : '';
      if (gitUsername) {
        await executeGitArgs(['config', 'user.name', gitUsername], uploadWorkspacePath, 'Set Upload Git Username');
      }
      if (gitEmail) {
        await executeGitArgs(['config', 'user.email', gitEmail], uploadWorkspacePath, 'Set Upload Git Email');
      }

      const commitResult = await executeGitArgs(['commit', '-m', 'Initial commit'], uploadWorkspacePath, 'Initial Upload Commit');
      if (!commitResult.success && !(commitResult.stderr && commitResult.stderr.includes('nothing to commit'))) {
        sendProgress('commit', 'error', commitResult.error);
        return { success: false, error: commitResult.error };
      }

      const branchResult = await executeGitArgs(['branch', '-M', preferredBranch], uploadWorkspacePath, `Set Upload Branch ${preferredBranch}`);
      if (!branchResult.success) {
        sendProgress('commit', 'error', branchResult.error);
        return { success: false, error: branchResult.error };
      }
      sendProgress('commit', 'done', 'Initial commit created');

      // Step 6: Push
      assertNotCancelled();
      sendProgress('push', 'active', 'Pushing to GitHub...');
      const pushResult = await executeGitPushWithProgress({
        cwd: uploadWorkspacePath,
        branch: preferredBranch,
        timeout: GIT_PUSH_TIMEOUT_MS,
        onProgress: (detail) => sendProgress('push', 'active', detail),
        isCancelled: () => Boolean(cancellation?.isCancelled && cancellation.isCancelled())
      });

      if (!pushResult.success) {
        sendProgress('push', 'error', pushResult.error);
        return { success: false, error: `Repository created but push failed: ${pushResult.error}` };
      }
      sendProgress('push', 'done', `Pushed to ${preferredBranch}`);
      return { success: true, repo: createResult.parsed, pushed: true };
    } finally {
      await safeRemoveDirectory(uploadWorkspacePath);
    }
  } catch (error) {
    if (error && error.cancelled) {
      return { success: false, cancelled: true, error: 'Operation cancelled' };
    }
    return { success: false, error: error.message };
  }
}

ipcMain.handle('github-upload-project', async (event, projectPath, repoData) => {
  return handleGitHubUploadProjectRequest(event.sender, projectPath, repoData);
});

// Disconnect GitHub
ipcMain.handle('github-disconnect', async () => {
  try {
    await clearStoredGitHubToken();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Terminal operations
ipcMain.handle('open-terminal', async (event, projectPath) => {
  const fallbackPath = appSettings.defaultProjectPath || projectsBasePath;
  const pathValidation = validateGitPath(projectPath || fallbackPath);
  if (!pathValidation.valid) {
    return { success: false, error: pathValidation.error };
  }

  const fallbackValidation = validateGitPath(fallbackPath);
  const workingDirectory = appSettings.terminalCwd === false && fallbackValidation.valid
    ? fallbackValidation.path
    : pathValidation.path;
  const terminalChoice = typeof appSettings.terminalApp === 'string' && ALLOWED_TERMINAL_APPS.has(appSettings.terminalApp)
    ? appSettings.terminalApp
    : 'cmd';
  const configuredTerminalPath = typeof appSettings.terminalPath === 'string'
    ? appSettings.terminalPath.trim()
    : '';
  const terminalExecutable = configuredTerminalPath && configuredTerminalPath.length <= MAX_SETTINGS_PATH_LENGTH
    ? configuredTerminalPath
    : null;
  const runAsAdmin = Boolean(appSettings.terminalAdmin) && process.platform === 'win32';

  const launchDetached = (command, args, options = {}) => new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workingDirectory,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      ...options
    });
    child.on('error', reject);
    child.unref();
    resolve();
  });

  try {
    if (process.platform === 'win32') {
      let command = terminalExecutable || 'cmd';
      let args = [];

      if (!terminalExecutable) {
        if (terminalChoice === 'powershell') {
          command = 'powershell';
          const escapedPath = workingDirectory.replace(/'/g, "''");
          args = ['-NoExit', '-Command', `Set-Location -LiteralPath '${escapedPath}'`];
        } else if (terminalChoice === 'wt') {
          command = 'wt';
          args = ['-d', workingDirectory];
        } else if (terminalChoice === 'bash') {
          command = 'bash';
          args = [`--cd=${workingDirectory}`];
        } else {
          command = 'cmd';
          args = ['/K', `cd /d "${workingDirectory}"`];
        }
      }

      if (runAsAdmin) {
        const escapedCommand = command.replace(/'/g, "''");
        const escapedWorkingDirectory = workingDirectory.replace(/'/g, "''");
        const argsLiteral = args.length > 0
          ? `@(${args.map((arg) => `'${String(arg).replace(/'/g, "''")}'`).join(', ')})`
          : '@()';
        const elevationResult = await executeWindowsCommand(
          `powershell -NoProfile -Command "Start-Process -FilePath '${escapedCommand}' -Verb RunAs -WorkingDirectory '${escapedWorkingDirectory}' -ArgumentList ${argsLiteral}"`,
          30000
        );
        if (!elevationResult.success) {
          return { success: false, error: elevationResult.error || 'Failed to launch elevated terminal' };
        }
        return { success: true };
      }

      await launchDetached(command, args);
      return { success: true };
    }

    if (process.platform === 'darwin') {
      if (terminalExecutable) {
        await launchDetached(terminalExecutable, []);
      } else {
        await launchDetached('open', ['-a', 'Terminal', workingDirectory], { cwd: undefined });
      }
      return { success: true };
    }

    if (terminalExecutable) {
      await launchDetached(terminalExecutable, []);
    } else {
      await launchDetached('gnome-terminal', [`--working-directory=${workingDirectory}`]);
    }
    return { success: true };
  } catch (error) {
    logger.error('Failed to open terminal', {
      projectPath,
      workingDirectory,
      terminalChoice,
      terminalExecutable,
      runAsAdmin,
      error: error.message
    });
    return { success: false, error: error.message || 'Failed to open terminal' };
  }
});

// Search projects
ipcMain.handle('search-projects', async (event, searchPath, query) => {
  try {
    const results = [];
    const searchDir = searchPath || projectsBasePath;
    
    async function searchRecursive(dir, depth = 0) {
      if (depth > 2) return; // Limit search depth
      
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const fullPath = path.join(dir, entry.name);
            
            // Skip node_modules, .git, etc.
            if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
              // Check if it's a project (has package.json, requirements.txt, etc.)
              const hasPackageJson = await fileExists(path.join(fullPath, 'package.json'));
              const hasRequirements = await fileExists(path.join(fullPath, 'requirements.txt'));
              const hasPom = await fileExists(path.join(fullPath, 'pom.xml'));
              
              if (hasPackageJson || hasRequirements || hasPom) {
                if (!query || entry.name.toLowerCase().includes(query.toLowerCase())) {
                  results.push({
                    name: entry.name,
                    path: fullPath,
                    type: hasPackageJson ? 'node' : hasRequirements ? 'python' : 'java'
                  });
                }
              }
              
              // Continue searching subdirectories
              await searchRecursive(fullPath, depth + 1);
            }
          }
        }
      } catch (error) {
        console.error(`Error searching directory ${dir}:`, error);
      }
    }
    
    await searchRecursive(searchDir);
    return results;
  } catch (error) {
    console.error('Error searching projects:', error);
    return [];
  }
});

// Helper function to check if file exists
async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function performCloneRepository(repoUrl, targetPath, cancellation = { isCancelled: () => false }) {
  const clonePath = path.resolve(targetPath || projectsBasePath);
  const normalizedRepoUrl = typeof repoUrl === 'string' ? repoUrl.trim() : '';

  if (!normalizedRepoUrl) {
    return { success: false, error: 'Repository URL is required' };
  }

  const remoteUrlValidation = validateGitRemoteUrl(normalizedRepoUrl);
  if (!remoteUrlValidation.valid) {
    return { success: false, error: remoteUrlValidation.error };
  }

  try {
    const stats = await fs.stat(clonePath);
    if (!stats.isDirectory()) {
      return { success: false, error: 'Clone target path is not a directory' };
    }
  } catch {
    return { success: false, error: 'Clone target path does not exist' };
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const cloneProcess = spawn('git', ['clone', remoteUrlValidation.value], {
      cwd: clonePath,
      windowsHide: true
    });

    cloneProcess.stdout.on('data', (data) => {
      stdout += data.toString();
      if (cancellation.isCancelled()) {
        try {
          cloneProcess.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
    });

    cloneProcess.stderr.on('data', (data) => {
      stderr += data.toString();
      if (cancellation.isCancelled()) {
        try {
          cloneProcess.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
    });

    cloneProcess.on('error', (error) => {
      resolve({ success: false, error: error.message, stderr });
    });

    cloneProcess.on('close', (code) => {
      if (cancellation.isCancelled()) {
        resolve({ success: false, cancelled: true, error: 'Operation cancelled', stderr, output: stdout });
        return;
      }
      if (code === 0) {
        resolve({ success: true, output: stdout, stderr });
      } else {
        const errorMessage = stderr.trim() || `git clone exited with code ${code}`;
        resolve({ success: false, error: errorMessage, stderr, output: stdout });
      }
    });
  });
}

async function performExportProject(projectPath, outputPath) {
  return new Promise((resolve) => {
    exec(`powershell Compress-Archive -Path "${projectPath}\\*" -DestinationPath "${outputPath}" -Force`,
      (error) => {
        if (error) {
          resolve({ success: false, error: error.message });
        } else {
          resolve({ success: true, path: outputPath });
        }
      }
    );
  });
}

operationQueue.registerRunner('clone-repository', async (payload, cancellation) => {
  const repoUrl = payload?.repoUrl || '';
  const targetPath = payload?.targetPath || projectsBasePath;
  return performCloneRepository(repoUrl, targetPath, cancellation);
});

operationQueue.registerRunner('export-project', async (payload) => {
  const projectPath = typeof payload?.projectPath === 'string' ? payload.projectPath : '';
  const outputPath = typeof payload?.outputPath === 'string' ? payload.outputPath : '';
  if (!projectPath || !outputPath) {
    throw new Error('projectPath and outputPath are required');
  }
  return performExportProject(projectPath, outputPath);
});

operationQueue.registerRunner('github-upload-project', async (payload, cancellation) => {
  const projectPath = typeof payload?.projectPath === 'string' ? payload.projectPath : '';
  const repoData = payload?.repoData && typeof payload.repoData === 'object' ? payload.repoData : {};
  const sender = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  return handleGitHubUploadProjectRequest(sender, projectPath, repoData, cancellation);
});

// Clone repository
ipcMain.handle('clone-repository', async (event, repoUrl, targetPath) => {
  return performCloneRepository(repoUrl, targetPath);
});

// Import project
ipcMain.handle('import-project', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Project to Import'
  });
  
  if (!result.canceled) {
    const projectPath = result.filePaths[0];
    const projectName = path.basename(projectPath);
    
    // Detect project type
    let projectType = 'empty';
    if (await fileExists(path.join(projectPath, 'package.json'))) {
      const packageJson = JSON.parse(await fs.readFile(path.join(projectPath, 'package.json'), 'utf-8'));
      if (packageJson.dependencies && packageJson.dependencies.electron) {
        projectType = 'electron';
      } else if (packageJson.dependencies && packageJson.dependencies.react) {
        projectType = 'react';
      } else if (packageJson.dependencies && packageJson.dependencies.vue) {
        projectType = 'vue';
      } else {
        projectType = 'nodejs';
      }
    } else if (await fileExists(path.join(projectPath, 'requirements.txt'))) {
      projectType = 'python';
    } else if (await fileExists(path.join(projectPath, 'pom.xml'))) {
      projectType = 'java';
    } else if (await fileExists(path.join(projectPath, 'CMakeLists.txt'))) {
      projectType = 'cpp';
    } else if (await fileExists(path.join(projectPath, 'index.html'))) {
      projectType = 'web';
    }
    
    return {
      success: true,
      project: {
        name: projectName,
        path: projectPath,
        type: projectType
      }
    };
  }
  
  return { success: false };
});

// Export project
ipcMain.handle('export-project', async (event, projectPath) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Project As',
    defaultPath: path.join(os.homedir(), 'Downloads', `${path.basename(projectPath)}.zip`),
    filters: [
      { name: 'ZIP Archive', extensions: ['zip'] }
    ]
  });
  
  if (!result.canceled) {
    return performExportProject(projectPath, result.filePath);
  }
  
  return { success: false };
});

// Delete project
ipcMain.handle('delete-project', async (event, projectPath) => {
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Delete Project',
    message: `Are you sure you want to delete this project?`,
    detail: projectPath,
    buttons: ['Cancel', 'Delete'],
    defaultId: 0,
    cancelId: 0
  });
  
  if (result.response === 1) {
    try {
      const normalizedPath = path.resolve(projectPath);
      const normalizedPathForCompare = process.platform === 'win32'
        ? normalizedPath.toLowerCase()
        : normalizedPath;
      const normalizedProjectsBase = path.resolve(projectsBasePath);
      const normalizedProjectsBaseForCompare = process.platform === 'win32'
        ? normalizedProjectsBase.toLowerCase()
        : normalizedProjectsBase;

      if (
        normalizedPathForCompare !== normalizedProjectsBaseForCompare &&
        !normalizedPathForCompare.startsWith(normalizedProjectsBaseForCompare + path.sep)
      ) {
        return { success: false, error: 'Can only delete projects within the configured workspace directory' };
      }

      stopFileWatcher(normalizedPath);
      await fs.rm(normalizedPath, { recursive: true, force: true });
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  
  return { success: false, cancelled: true };
});

ipcMain.handle('rename-project', async (event, projectPath, newNameInput) => {
  const rawProjectPath = typeof projectPath === 'string' ? projectPath.trim() : '';
  const newName = typeof newNameInput === 'string' ? newNameInput.trim() : '';

  if (!rawProjectPath) {
    return { success: false, error: 'Project path is required.' };
  }

  if (!newName) {
    return { success: false, error: 'Project name cannot be empty.' };
  }

  if (!/^[a-zA-Z0-9-_\s.]+$/.test(newName)) {
    return { success: false, error: 'Project name contains invalid characters.' };
  }

  if (newName.length > 80) {
    return { success: false, error: 'Project name is too long (max 80 characters).' };
  }

  const sourcePath = path.resolve(rawProjectPath);

  try {
    const stats = await fs.stat(sourcePath);
    if (!stats.isDirectory()) {
      return { success: false, error: 'Project path is not a directory.' };
    }
  } catch {
    return { success: false, error: 'Project path does not exist.' };
  }

  const parentDir = path.dirname(sourcePath);
  const targetPath = path.resolve(path.join(parentDir, newName));

  if (path.dirname(targetPath) !== parentDir) {
    return { success: false, error: 'Invalid target project name.' };
  }

  if (targetPath.toLowerCase() === sourcePath.toLowerCase()) {
    return {
      success: true,
      oldPath: sourcePath,
      project: {
        name: path.basename(targetPath),
        path: targetPath,
        type: 'unknown'
      }
    };
  }

  try {
    await fs.access(targetPath);
    return { success: false, error: 'A folder with this project name already exists.' };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      return { success: false, error: `Unable to verify project rename target: ${error.message}` };
    }
  }

  try {
    await fs.rename(sourcePath, targetPath);
    stopFileWatcher(sourcePath);
    return {
      success: true,
      oldPath: sourcePath,
      project: {
        name: path.basename(targetPath),
        path: targetPath,
        type: 'unknown'
      }
    };
  } catch (error) {
    return { success: false, error: `Failed to rename project: ${error.message}` };
  }
});

// Show about dialog
ipcMain.handle('show-about', async () => {
  await loadAppVersionInfo();
  const versionInfo = getAppVersionInfo();
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'About Project Manager Pro',
    message: 'Project Manager Pro',
    detail: `Version ${versionInfo.version}\n\nA professional project management application with VSCode-like interface.\n\n(c) ${new Date().getFullYear()} Project Manager Pro`,
    buttons: ['OK']
  });
});

// Get app version info
ipcMain.handle('get-app-version-info', async () => {
  await loadAppVersionInfo();
  return getAppVersionInfo();
});

ipcMain.handle('get-update-state', async () => {
  return updateManager.getState();
});

ipcMain.handle('check-for-updates', async () => {
  return updateManager.checkForUpdates();
});

ipcMain.handle('set-update-channel', async (event, channel) => {
  const result = updateManager.setChannel(channel);
  if (result.success) {
    appSettings = sanitizeAppSettings({ ...appSettings, updateChannel: result.state.channel }, projectsBasePath);
    await saveSettings();
  }
  return result;
});

ipcMain.handle('download-update', async () => {
  return updateManager.downloadUpdate();
});

ipcMain.handle('install-update', async () => {
  return updateManager.installUpdate();
});

ipcMain.handle('rollback-update', async () => {
  const result = await updateManager.rollbackToStable();
  if (result.success) {
    appSettings = sanitizeAppSettings({ ...appSettings, updateChannel: 'stable' }, projectsBasePath);
    await saveSettings();
  }
  return result;
});

ipcMain.handle('create-workspace-snapshot', async (event, name = '') => {
  try {
    const recentProjects = await readRecentProjectsFromDisk();
    const snapshot = await workspaceServices.createSnapshot({
      name,
      workspacePath: projectsBasePath,
      settings: getRendererSafeSettings(appSettings),
      recentProjects
    });
    return { success: true, snapshot };
  } catch (error) {
    return { success: false, error: error.message || 'Failed to create snapshot' };
  }
});

ipcMain.handle('get-workspace-snapshots', async () => {
  try {
    const snapshots = await workspaceServices.listSnapshots();
    return { success: true, snapshots };
  } catch (error) {
    return { success: false, error: error.message || 'Failed to load snapshots', snapshots: [] };
  }
});

ipcMain.handle('restore-workspace-snapshot', async (event, snapshotId) => {
  try {
    const snapshot = await workspaceServices.loadSnapshot(snapshotId);
    appSettings = sanitizeAppSettings(snapshot.settings || {}, projectsBasePath);
    projectsBasePath = appSettings.defaultProjectPath;
    await saveSettings();
    await ensureProjectsDir();
    await saveRecentProjectsToDisk(snapshot.recentProjects || []);
    return {
      success: true,
      restored: {
        id: snapshot.id,
        name: snapshot.name,
        workspacePath: snapshot.workspacePath,
        createdAt: snapshot.createdAt
      }
    };
  } catch (error) {
    return { success: false, error: error.message || 'Failed to restore snapshot' };
  }
});

ipcMain.handle('save-project-task-profile', async (event, projectPath, profiles) => {
  try {
    const pathValidation = validateGitPath(projectPath);
    if (!pathValidation.valid) {
      return { success: false, error: pathValidation.error };
    }
    const savedProfiles = await workspaceServices.saveTaskProfiles(pathValidation.path, profiles);
    return { success: true, profiles: savedProfiles };
  } catch (error) {
    return { success: false, error: error.message || 'Failed to save task profiles' };
  }
});

ipcMain.handle('get-project-task-profiles', async (event, projectPath) => {
  try {
    const pathValidation = validateGitPath(projectPath);
    if (!pathValidation.valid) {
      return { success: false, error: pathValidation.error, profiles: [] };
    }
    const profiles = await workspaceServices.getTaskProfiles(pathValidation.path);
    return { success: true, profiles };
  } catch (error) {
    return { success: false, error: error.message || 'Failed to load task profiles', profiles: [] };
  }
});

ipcMain.handle('run-project-task-profile', async (event, projectPath, profileId) => {
  try {
    const pathValidation = validateGitPath(projectPath);
    if (!pathValidation.valid) {
      return { success: false, error: pathValidation.error };
    }

    const profiles = await workspaceServices.getTaskProfiles(pathValidation.path);
    const profile = profiles.find((item) => item && item.id === profileId);
    if (!profile) {
      return { success: false, error: 'Task profile not found' };
    }

    const parsedCommand = parseAllowedRunCommand(profile.command || '');
    if (!parsedCommand) {
      return { success: false, error: 'This task command is blocked by security policy.' };
    }

    const cwdCandidate = typeof profile.cwd === 'string' && profile.cwd.trim()
      ? path.resolve(pathValidation.path, profile.cwd.trim())
      : pathValidation.path;
    const cwdValidation = await validateCommandWorkingDirectory(cwdCandidate);
    if (!cwdValidation.valid) {
      return { success: false, error: cwdValidation.error };
    }

    const result = await executeCommandWithArgs(parsedCommand.executable, parsedCommand.args, {
      cwd: cwdValidation.path,
      timeout: 120000,
      maxBuffer: COMMAND_MAX_BUFFER_BYTES
    });

    if (!result.success) {
      return { success: false, error: result.error || 'Task failed', stderr: result.stderr || '' };
    }

    return { success: true, stdout: result.output || '', stderr: result.stderr || '' };
  } catch (error) {
    return { success: false, error: error.message || 'Failed to run task profile' };
  }
});

ipcMain.handle('build-search-index', async (event, workspacePathInput) => {
  try {
    const workspacePathValue = typeof workspacePathInput === 'string' && workspacePathInput.trim()
      ? workspacePathInput.trim()
      : projectsBasePath;
    const result = await workspaceServices.buildSearchIndex({ workspacePath: workspacePathValue });
    return result;
  } catch (error) {
    return { success: false, error: error.message || 'Failed to build search index' };
  }
});

ipcMain.handle('query-search-index', async (event, query, limit = 60) => {
  try {
    return workspaceServices.querySearchIndex(query, limit);
  } catch (error) {
    return { success: false, error: error.message || 'Failed to query search index', results: [] };
  }
});

ipcMain.handle('enqueue-operation', async (event, type, payload) => {
  try {
    const operationType = typeof type === 'string' ? type.trim() : '';
    if (!operationType) {
      return { success: false, error: 'Operation type is required' };
    }

    if (PRO_QUEUE_OPERATION_TYPES.has(operationType) && !licenseState.isProUnlocked) {
      return {
        success: false,
        error: 'This feature requires Pro. Register your product key in Help > Register Product.'
      };
    }

    const job = operationQueue.enqueue(operationType, payload);
    return { success: true, job };
  } catch (error) {
    return { success: false, error: error.message || 'Failed to enqueue operation' };
  }
});

ipcMain.handle('get-operation-queue', async () => {
  return { success: true, jobs: operationQueue.getSnapshot() };
});

ipcMain.handle('cancel-operation', async (event, jobId) => {
  return operationQueue.cancel(jobId);
});

ipcMain.handle('retry-operation', async (event, jobId) => {
  return operationQueue.retry(jobId);
});

ipcMain.handle('get-user-data-path', async () => {
  return app.getPath('userData');
});

ipcMain.handle('open-user-data-folder', async () => {
  const userDataPath = app.getPath('userData');
  const openError = await shell.openPath(userDataPath);

  if (openError) {
    return { success: false, error: openError, path: userDataPath };
  }

  return { success: true, path: userDataPath };
});

ipcMain.handle('get-license-status', async () => {
  return getLicenseStatus();
});

ipcMain.handle('register-product-key', async (event, productKey) => {
  return registerProductKey(productKey);
});

// Open external link
ipcMain.handle('open-external', async (event, url) => {
  return openExternalSafely(url);
});

// Copy to clipboard
ipcMain.handle('copy-to-clipboard', (event, text) => {
  clipboard.writeText(text);
});

// Get clipboard content
ipcMain.handle('get-clipboard', () => {
  return clipboard.readText();
});

// Run controlled npm/pip/git commands
ipcMain.handle('run-command', async (event, command, projectPath) => {
  const normalizedCommand = typeof command === 'string' ? command.trim() : '';
  const pathValidation = await validateCommandWorkingDirectory(projectPath);

  if (!pathValidation.valid) {
    logger.warn('Blocked command due to invalid project path', { command: normalizedCommand, projectPath });
    return { success: false, error: pathValidation.error };
  }

  const parsedCommand = parseAllowedRunCommand(normalizedCommand);
  if (!parsedCommand) {
    logger.warn('Blocked non-allowlisted command', { command: normalizedCommand, cwd: pathValidation.path });
    return { success: false, error: 'This command is not allowed for security reasons.' };
  }

  logger.info(`Running command: ${parsedCommand.normalizedCommand}`, {
    cwd: pathValidation.path,
    executable: parsedCommand.executable,
    args: parsedCommand.args
  });

  const result = await executeCommandWithArgs(parsedCommand.executable, parsedCommand.args, {
    cwd: pathValidation.path,
    timeout: 120000,
    maxBuffer: COMMAND_MAX_BUFFER_BYTES
  });

  if (!result.success) {
    logger.error(`Command failed: ${parsedCommand.normalizedCommand}`, { error: result.error, stderr: result.stderr });
    const userError = result.error === 'Command timed out' ? 'Command timed out after 2 minutes' : result.error;
    return { success: false, error: userError, stderr: result.stderr };
  }

  logger.info(`Command succeeded: ${parsedCommand.normalizedCommand}`);
  return { success: true, stdout: result.output || '', stderr: result.stderr || '' };
});

// Check for VSCode installation
ipcMain.handle('check-vscode', async () => {
  const launcher = await resolveVsCodeLauncher();
  return Boolean(launcher);
});

// Get system info
ipcMain.handle('get-system-info', () => {
  const versionInfo = getAppVersionInfo();
  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    v8Version: process.versions.v8,
    osRelease: os.release(),
    totalMemory: os.totalmem(),
    freeMemory: os.freemem(),
    cpus: os.cpus().length,
    homedir: os.homedir(),
    appVersion: versionInfo.version,
    appDisplayVersion: versionInfo.displayVersion,
    appReleaseChannel: versionInfo.channel,
    proUnlocked: Boolean(licenseState.isProUnlocked)
  };
});

ipcMain.handle('create-project', async (event, projectData) => {
  const {
    name,
    type,
    description,
    path: customPath,
    initGit: initGitRequested,
    openInVSCode: openInVSCodeRequested
  } = projectData || {};
  const shouldInitGit = typeof initGitRequested === 'boolean'
    ? initGitRequested
    : Boolean(appSettings.gitAutoInit);
  const shouldOpenInVSCode = typeof openInVSCodeRequested === 'boolean'
    ? openInVSCodeRequested
    : Boolean(appSettings.openInVSCode);
  const preferredDefaultBranch = typeof appSettings.defaultBranch === 'string' &&
    /^[A-Za-z0-9._/-]+$/.test(appSettings.defaultBranch) &&
    !appSettings.defaultBranch.includes('..')
    ? appSettings.defaultBranch
    : 'main';

  // Validate project name
  if (!name || name.trim().length === 0) {
    return { success: false, error: 'Project name cannot be empty' };
  }
  if (!/^[a-zA-Z0-9-_\s]+$/.test(name)) {
    return { success: false, error: 'Project name contains invalid characters. Use only letters, numbers, hyphens, underscores, and spaces.' };
  }
  if (name.length > 50) {
    return { success: false, error: 'Project name is too long (max 50 characters)' };
  }

  const projectPath = path.join(customPath || projectsBasePath, name);

  try {
    // Create project directory
    await fs.mkdir(projectPath, { recursive: true });
    
    // Create project structure based on type
    switch(type) {
      case 'electron':
        await createElectronProject(projectPath, name, description);
        break;
      case 'python':
        await createPythonProject(projectPath, name, description);
        break;
      case 'web':
        await createWebProject(projectPath, name, description);
        break;
      case 'nodejs':
        await createNodeProject(projectPath, name, description);
        break;
      case 'react':
        await createReactProject(projectPath, name, description);
        break;
      case 'vue':
        await createVueProject(projectPath, name, description);
        break;
      case 'cpp':
        await createCppProject(projectPath, name, description);
        break;
      case 'java':
        await createJavaProject(projectPath, name, description);
        break;
      default:
        await createEmptyProject(projectPath, name, description);
    }

    if (shouldInitGit) {
      const initResult = await executeGitArgs(['init'], projectPath, 'Initialize Git Repository');
      if (!initResult.success) {
        return { success: false, error: initResult.error };
      }

      if (preferredDefaultBranch) {
        const branchResult = await executeGitArgs(['branch', '-M', preferredDefaultBranch], projectPath, 'Set Default Branch');
        if (!branchResult.success) {
          logger.warn('Failed to set default branch after project creation', {
            projectPath,
            preferredDefaultBranch,
            error: branchResult.error
          });
        }
      }
    }
    
    // Open in VS Code when requested.
    if (shouldOpenInVSCode) {
      const openInCodeResult = await openPathInVsCode(projectPath);
      if (!openInCodeResult.success) {
        logger.warn('Failed to open project in VS Code after creation', {
          projectPath,
          error: openInCodeResult.error
        });
      }
    }
    
    return { success: true, path: projectPath };
  } catch (error) {
    console.error('Error creating project:', error);
    return { success: false, error: error.message };
  }
});

// Get all projects from the projects directory
ipcMain.handle('get-projects', async () => {
  try {
    const projectsPath = appSettings.defaultProjectPath || projectsBasePath;

    // Check if projects directory exists
    try {
      await fs.access(projectsPath);
    } catch (error) {
      // Directory doesn't exist, create it
      await fs.mkdir(projectsPath, { recursive: true });
      return [];
    }

    const items = await fs.readdir(projectsPath, { withFileTypes: true });
    const projects = [];

    for (const item of items) {
      if (item.isDirectory()) {
        const projectPath = path.join(projectsPath, item.name);
        const project = {
          name: item.name,
          path: projectPath,
          type: 'unknown',
          lastModified: null,
          isGitRepo: false,
          hasPackageJson: false
        };

        try {
          // Check if it's a git repository
          const gitPath = path.join(projectPath, '.git');
          try {
            await fs.access(gitPath);
            project.isGitRepo = true;
            project.type = 'git';
          } catch (e) {
            // Not a git repo
          }

          // Check for package.json
          const packageJsonPath = path.join(projectPath, 'package.json');
          try {
            await fs.access(packageJsonPath);
            project.hasPackageJson = true;
            const packageData = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
            project.type = packageData.type || 'node';
            project.description = packageData.description || '';
          } catch (e) {
            // No package.json
          }

          // Get last modified time
          const stats = await fs.stat(projectPath);
          project.lastModified = stats.mtime;

        } catch (error) {
          console.error(`Error reading project ${item.name}:`, error);
        }

        projects.push(project);
      }
    }

    // Sort by last modified (most recent first)
    projects.sort((a, b) => {
      if (!a.lastModified) return 1;
      if (!b.lastModified) return -1;
      return b.lastModified - a.lastModified;
    });

    return projects;
  } catch (error) {
    console.error('Error getting projects:', error);
    return [];
  }
});

ipcMain.handle('get-recent-projects', async () => {
  return readRecentProjectsFromDisk();
});

ipcMain.handle('save-recent-project', async (event, project) => {
  try {
    let recentProjects = await readRecentProjectsFromDisk();

    // Remove any existing entry with the same path to avoid duplicates
    recentProjects = recentProjects.filter(p => p.path !== project.path);

    // Add new project to the beginning
    recentProjects.unshift(project);

    // Keep only last 10 projects
    recentProjects = recentProjects.slice(0, 10);

    await saveRecentProjectsToDisk(recentProjects);
    return true;
  } catch (error) {
    console.error('Error saving recent project:', error);
    return false;
  }
});

ipcMain.handle('open-in-vscode', async (event, projectPath) => {
  if (!projectPath || typeof projectPath !== 'string') {
    return { success: false, error: 'Invalid project path' };
  }

  const resolvedPath = path.resolve(projectPath);

  try {
    const stats = await fs.stat(resolvedPath);
    if (!stats.isDirectory()) {
      return { success: false, error: 'Project path is not a directory' };
    }
  } catch {
    return { success: false, error: 'Project path does not exist' };
  }

  const result = await openPathInVsCode(resolvedPath);
  if (!result.success) {
    logger.error('Error opening VS Code', { projectPath: resolvedPath, error: result.error });
    return { success: false, error: result.error };
  }

  return { success: true };
});

ipcMain.handle('open-in-explorer', async (event, projectPath) => {
  if (!projectPath || typeof projectPath !== 'string') {
    return { success: false, error: 'Invalid project path' };
  }

  const resolvedPath = path.resolve(projectPath);
  const errorMessage = await shell.openPath(resolvedPath);

  if (errorMessage) {
    logger.warn('Failed to open path in explorer', { projectPath: resolvedPath, error: errorMessage });
    return { success: false, error: errorMessage };
  }

  return { success: true };
});

// File Watcher IPC Handlers
ipcMain.handle('start-file-watcher', async (event, projectPath) => {
  try {
    const pathValidation = validateGitPath(projectPath);
    if (!pathValidation.valid) {
      return { success: false, error: pathValidation.error };
    }

    startFileWatcher(pathValidation.path);
    logger.info('File watcher started via IPC', { projectPath: pathValidation.path });
    return { success: true };
  } catch (error) {
    logger.error('Failed to start file watcher', { projectPath, error: error.message });
    return { success: false, error: error.message };
  }
});

ipcMain.handle('stop-file-watcher', async (event, projectPath) => {
  try {
    if (!projectPath || typeof projectPath !== 'string') {
      return { success: false, error: 'Invalid project path' };
    }

    const normalizedPath = path.resolve(projectPath);
    stopFileWatcher(normalizedPath);
    logger.info('File watcher stopped via IPC', { projectPath: normalizedPath });
    return { success: true };
  } catch (error) {
    logger.error('Failed to stop file watcher', { projectPath, error: error.message });
    return { success: false, error: error.message };
  }
});

// Undo/Redo IPC Handler
ipcMain.handle('undo-last-operation', async (event) => {
  if (gitOperationHistory.length === 0) {
    return { success: false, error: 'No operations to undo' };
  }

  const lastOp = gitOperationHistory[0];
  logger.info('Undoing operation', lastOp);

  // For commits, use git reset
  if (lastOp.type === 'commit') {
    const result = await executeGitArgs(['reset', '--soft', 'HEAD~1'], lastOp.projectPath, 'Undo Commit');

    if (result.success) {
      // Remove from history
      gitOperationHistory.shift();

      // Notify renderer
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('git-history-updated', gitOperationHistory);
      }
    }

    return result;
  }

  // For other operations, inform user it's not supported yet
  return { success: false, error: 'Undo not supported for this operation yet' };
});

ipcMain.handle('get-operation-history', async () => {
  return gitOperationHistory;
});

// Template System IPC Handlers
ipcMain.handle('create-from-template', async (event, templateId, projectName, targetPath, options = {}) => {
  const template = projectTemplates[templateId];
  if (!template) {
    logger.error('Template not found', { templateId });
    return { success: false, error: 'Template not found' };
  }

  const templateOptions = options && typeof options === 'object' && !Array.isArray(options)
    ? options
    : {};
  const shouldInitGit = typeof templateOptions.initGit === 'boolean'
    ? templateOptions.initGit
    : Boolean(appSettings.gitAutoInit);
  const shouldOpenInVSCode = typeof templateOptions.openInVSCode === 'boolean'
    ? templateOptions.openInVSCode
    : Boolean(appSettings.openInVSCode);
  const preferredDefaultBranch = typeof appSettings.defaultBranch === 'string' &&
    /^[A-Za-z0-9._/-]+$/.test(appSettings.defaultBranch) &&
    !appSettings.defaultBranch.includes('..')
    ? appSettings.defaultBranch
    : 'main';

  const projectPath = path.join(targetPath || projectsBasePath, projectName);

  try {
    // Check if directory already exists
    try {
      await fs.access(projectPath);
      return { success: false, error: 'A project with this name already exists' };
    } catch (e) {
      // Directory doesn't exist, continue
    }

    // Create project directory
    await fs.mkdir(projectPath, { recursive: true });

    // Create all files from template
    for (const [filePath, content] of Object.entries(template.files)) {
      const fullPath = path.join(projectPath, filePath);
      const dir = path.dirname(fullPath);

      // Create directory if needed
      await fs.mkdir(dir, { recursive: true });

      // Write file
      await fs.writeFile(fullPath, content);
    }

    logger.info('Project created from template', { templateId, projectName, projectPath });

    if (shouldInitGit) {
      const initResult = await executeGitArgs(['init'], projectPath, 'Initialize Git');
      if (!initResult.success) {
        return { success: false, error: initResult.error };
      }

      if (preferredDefaultBranch) {
        const branchResult = await executeGitArgs(['branch', '-M', preferredDefaultBranch], projectPath, 'Set Default Branch');
        if (!branchResult.success) {
          logger.warn('Failed to set default branch for template project', {
            projectPath,
            preferredDefaultBranch,
            error: branchResult.error
          });
        }
      }
    }

    if (shouldOpenInVSCode) {
      const openInCodeResult = await openPathInVsCode(projectPath);
      if (!openInCodeResult.success) {
        logger.warn('Failed to open template project in VS Code after creation', {
          projectPath,
          error: openInCodeResult.error
        });
      }
    }

    return { success: true, path: projectPath };
  } catch (error) {
    logger.error('Failed to create project from template', { templateId, projectName, error: error.message });
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-templates', async () => {
  return Object.entries(projectTemplates).map(([id, template]) => ({
    id,
    name: template.name,
    description: template.description
  }));
});

// Project creation functions
async function createElectronProject(projectPath, name, description) {
  const packageJson = {
    name: name.toLowerCase().replace(/\s+/g, '-'),
    version: "0.1.0",
    description: description,
    main: "main.js",
    scripts: {
      start: "electron .",
      build: "electron-builder"
    },
    devDependencies: {
      electron: "^27.0.0"
    }
  };
  
  const mainJs = `const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: true
    }
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});`;

  const preloadJs = `const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('appInfo', {
  electron: process.versions.electron
});`;

  const indexHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${name}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      margin: 0;
      padding: 20px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      height: 100vh;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
    }
    h1 { margin-bottom: 10px; }
    p { opacity: 0.9; }
  </style>
</head>
	<body>
	  <h1>Welcome to ${name}</h1>
	  <p>${description}</p>
	  <p>Electron: <span id="electron-version"></span></p>
	  <script>
	    const version = window.appInfo && window.appInfo.electron ? window.appInfo.electron : 'unknown';
	    document.getElementById('electron-version').textContent = version;
	  </script>
	</body>
	</html>`;
	  
  await fs.writeFile(path.join(projectPath, 'package.json'), JSON.stringify(packageJson, null, 2));
  await fs.writeFile(path.join(projectPath, 'main.js'), mainJs);
  await fs.writeFile(path.join(projectPath, 'preload.js'), preloadJs);
  await fs.writeFile(path.join(projectPath, 'index.html'), indexHtml);
  await fs.writeFile(path.join(projectPath, '.gitignore'), 'node_modules/\ndist/\n*.log');
  await fs.writeFile(path.join(projectPath, 'README.md'), `# ${name}\n\n${description}\n\n## Getting Started\n\n\`\`\`bash\nnpm install\nnpm start\n\`\`\``);
}

async function createPythonProject(projectPath, name, description) {
  const mainPy = `#!/usr/bin/env python3
"""
${name}
${description}
"""

def main():
    """Main function"""
    print(f"Welcome to ${name}")
    print(f"${description}")
    
if __name__ == "__main__":
    main()
`;

  const requirements = `# Core dependencies
numpy>=1.21.0
pandas>=1.3.0
requests>=2.26.0
`;

  const gitignore = `# Python
__pycache__/
*.py[cod]
*$py.class
*.so
.Python
env/
venv/
ENV/
build/
dist/
*.egg-info/
.venv
pip-log.txt
pip-delete-this-directory.txt

# IDE
.vscode/
.idea/
*.swp
*.swo
*~

# Project specific
*.log
.DS_Store
`;

  const readme = `# ${name}

${description}

## Setup

\`\`\`bash
python -m venv venv
source venv/bin/activate  # On Windows: venv\\Scripts\\activate
pip install -r requirements.txt
\`\`\`

## Usage

\`\`\`bash
python main.py
\`\`\`
`;

  await fs.writeFile(path.join(projectPath, 'main.py'), mainPy);
  await fs.writeFile(path.join(projectPath, 'requirements.txt'), requirements);
  await fs.writeFile(path.join(projectPath, '.gitignore'), gitignore);
  await fs.writeFile(path.join(projectPath, 'README.md'), readme);
  
  // Create project structure
  await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'tests'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'docs'), { recursive: true });
  
  await fs.writeFile(path.join(projectPath, 'src', '__init__.py'), '');
  await fs.writeFile(path.join(projectPath, 'tests', '__init__.py'), '');
}

async function createWebProject(projectPath, name, description) {
  const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${name}</title>
    <link rel="stylesheet" href="css/style.css">
</head>
<body>
    <div class="container">
        <header>
            <h1>${name}</h1>
            <nav>
                <ul>
                    <li><a href="#home">Home</a></li>
                    <li><a href="#about">About</a></li>
                    <li><a href="#services">Services</a></li>
                    <li><a href="#contact">Contact</a></li>
                </ul>
            </nav>
        </header>
        
        <main>
            <section id="hero">
                <h2>Welcome to ${name}</h2>
                <p>${description}</p>
                <button class="cta-button">Get Started</button>
            </section>
        </main>
        
        <footer>
            <p>&copy; 2026 ${name}. All rights reserved.</p>
        </footer>
    </div>
    
    <script src="js/script.js"></script>
</body>
</html>`;

  const styleCss = `* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    line-height: 1.6;
    color: #333;
}

.container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 0 20px;
}

header {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    padding: 1rem 0;
    box-shadow: 0 2px 10px rgba(0,0,0,0.1);
}

header h1 {
    display: inline-block;
    margin-right: 2rem;
}

nav {
    display: inline-block;
}

nav ul {
    list-style: none;
    display: flex;
    gap: 2rem;
}

nav a {
    color: white;
    text-decoration: none;
    transition: opacity 0.3s;
}

nav a:hover {
    opacity: 0.8;
}

#hero {
    padding: 4rem 0;
    text-align: center;
    background: #f8f9fa;
    margin: 2rem 0;
    border-radius: 10px;
}

#hero h2 {
    font-size: 2.5rem;
    margin-bottom: 1rem;
}

#hero p {
    font-size: 1.2rem;
    margin-bottom: 2rem;
    color: #666;
}

.cta-button {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    padding: 1rem 2rem;
    font-size: 1.1rem;
    border-radius: 50px;
    cursor: pointer;
    transition: transform 0.3s;
}

.cta-button:hover {
    transform: translateY(-2px);
}

footer {
    background: #333;
    color: white;
    text-align: center;
    padding: 2rem 0;
    margin-top: 4rem;
}`;

  const scriptJs = `// ${name} JavaScript
document.addEventListener('DOMContentLoaded', function() {
    console.log('${name} loaded successfully');
    
    // Smooth scrolling for navigation links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                target.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
            }
        });
    });
    
    // CTA button click handler
    const ctaButton = document.querySelector('.cta-button');
    if (ctaButton) {
        ctaButton.addEventListener('click', function() {
            alert('Welcome to ${name}!');
        });
    }
});`;

  await fs.mkdir(path.join(projectPath, 'css'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'js'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'images'), { recursive: true });
  
  await fs.writeFile(path.join(projectPath, 'index.html'), indexHtml);
  await fs.writeFile(path.join(projectPath, 'css', 'style.css'), styleCss);
  await fs.writeFile(path.join(projectPath, 'js', 'script.js'), scriptJs);
  await fs.writeFile(path.join(projectPath, 'README.md'), `# ${name}\n\n${description}\n\n## Features\n\n- Responsive design\n- Modern CSS with gradients\n- Smooth scrolling\n- Clean structure`);
}

async function createNodeProject(projectPath, name, description) {
  const packageJson = {
    name: name.toLowerCase().replace(/\s+/g, '-'),
    version: "1.0.0",
    description: description,
    main: "index.js",
    scripts: {
      start: "node index.js",
      dev: "nodemon index.js",
      test: "jest"
    },
    keywords: [],
    author: "",
    license: "ISC",
    dependencies: {
      express: "^4.18.0",
      dotenv: "^16.0.0"
    },
    devDependencies: {
      nodemon: "^2.0.0",
      jest: "^29.0.0"
    }
  };
  
  const indexJs = `const express = require('express');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Routes
app.get('/', (req, res) => {
    res.json({
        name: '${name}',
        description: '${description}',
        version: '1.0.0'
    });
});

app.get('/api/status', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString()
    });
});

// Error handling
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
app.listen(PORT, () => {
    console.log(\`Server is running on http://localhost:\${PORT}\`);
});

module.exports = app;`;

  const envExample = `# Environment Variables
PORT=3000
NODE_ENV=development
`;

  const gitignore = `node_modules/
.env
.DS_Store
*.log
dist/
coverage/
`;

  await fs.writeFile(path.join(projectPath, 'package.json'), JSON.stringify(packageJson, null, 2));
  await fs.writeFile(path.join(projectPath, 'index.js'), indexJs);
  await fs.writeFile(path.join(projectPath, '.env.example'), envExample);
  await fs.writeFile(path.join(projectPath, '.gitignore'), gitignore);
  await fs.writeFile(path.join(projectPath, 'README.md'), `# ${name}\n\n${description}\n\n## Installation\n\n\`\`\`bash\nnpm install\n\`\`\`\n\n## Usage\n\n\`\`\`bash\nnpm start\n\`\`\``);
  
  await fs.mkdir(path.join(projectPath, 'public'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'routes'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'models'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'controllers'), { recursive: true });
}

async function createReactProject(projectPath, name, description) {
  const packageJson = {
    name: name.toLowerCase().replace(/\s+/g, '-'),
    version: "0.1.0",
    private: true,
    description: description,
    dependencies: {
      "react": "^18.2.0",
      "react-dom": "^18.2.0",
      "react-scripts": "5.0.1"
    },
    scripts: {
      "start": "react-scripts start",
      "build": "react-scripts build",
      "test": "react-scripts test",
      "eject": "react-scripts eject"
    },
    "eslintConfig": {
      "extends": ["react-app"]
    },
    "browserslist": {
      "production": [">0.2%", "not dead", "not op_mini all"],
      "development": ["last 1 chrome version", "last 1 firefox version", "last 1 safari version"]
    }
  };
  
  await fs.writeFile(path.join(projectPath, 'package.json'), JSON.stringify(packageJson, null, 2));
  await fs.writeFile(path.join(projectPath, '.gitignore'), 'node_modules/\n.DS_Store\nbuild/\n.env.local\n');
  await fs.writeFile(path.join(projectPath, 'README.md'), `# ${name}\n\n${description}\n\n## Available Scripts\n\n### \`npm start\`\n\nRuns the app in development mode.\n\n### \`npm run build\`\n\nBuilds the app for production.`);
  
  // Create src directory and basic files
  const srcPath = path.join(projectPath, 'src');
  await fs.mkdir(srcPath, { recursive: true });
  
  const appJs = `import React from 'react';
import './App.css';

function App() {
  return (
    <div className="App">
      <header className="App-header">
        <h1>${name}</h1>
        <p>${description}</p>
        <button className="App-button">Get Started</button>
      </header>
    </div>
  );
}

export default App;`;
  
  const indexJs = `import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);`;
  
  const appCss = `.App {
  text-align: center;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
}

.App-header {
  color: white;
}

.App-header h1 {
  font-size: 3rem;
  margin-bottom: 1rem;
}

.App-button {
  background: white;
  color: #667eea;
  border: none;
  padding: 1rem 2rem;
  font-size: 1.1rem;
  border-radius: 50px;
  cursor: pointer;
  transition: transform 0.3s;
  margin-top: 2rem;
}

.App-button:hover {
  transform: translateY(-2px);
}`;
  
  const indexCss = `body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen',
    'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue',
    sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

code {
  font-family: source-code-pro, Menlo, Monaco, Consolas, 'Courier New',
    monospace;
}`;
  
  await fs.writeFile(path.join(srcPath, 'App.js'), appJs);
  await fs.writeFile(path.join(srcPath, 'index.js'), indexJs);
  await fs.writeFile(path.join(srcPath, 'App.css'), appCss);
  await fs.writeFile(path.join(srcPath, 'index.css'), indexCss);
  
  // Create public directory
  const publicPath = path.join(projectPath, 'public');
  await fs.mkdir(publicPath, { recursive: true });
  
  const indexHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#000000" />
    <meta name="description" content="${description}" />
    <title>${name}</title>
  </head>
  <body>
    <noscript>You need to enable JavaScript to run this app.</noscript>
    <div id="root"></div>
  </body>
</html>`;
  
  await fs.writeFile(path.join(publicPath, 'index.html'), indexHtml);
}

async function createVueProject(projectPath, name, description) {
  const packageJson = {
    name: name.toLowerCase().replace(/\s+/g, '-'),
    version: "0.1.0",
    private: true,
    description: description,
    scripts: {
      serve: "vue-cli-service serve",
      build: "vue-cli-service build"
    },
    dependencies: {
      "vue": "^3.2.0",
      "vue-router": "^4.0.0",
      "vuex": "^4.0.0"
    },
    devDependencies: {
      "@vue/cli-service": "^5.0.0"
    }
  };
  
  await fs.writeFile(path.join(projectPath, 'package.json'), JSON.stringify(packageJson, null, 2));
  await fs.writeFile(path.join(projectPath, '.gitignore'), 'node_modules/\n.DS_Store\ndist/\n*.log');
  await fs.writeFile(path.join(projectPath, 'README.md'), `# ${name}\n\n${description}\n\n## Project setup\n\`\`\`\nnpm install\n\`\`\`\n\n### Compiles and hot-reloads for development\n\`\`\`\nnpm run serve\n\`\`\``);
  
  // Create src directory
  const srcPath = path.join(projectPath, 'src');
  await fs.mkdir(srcPath, { recursive: true });
  
  const mainJs = `import { createApp } from 'vue'
import App from './App.vue'

createApp(App).mount('#app')`;
  
  const appVue = `<template>
  <div id="app">
    <header>
      <h1>{{ title }}</h1>
      <p>{{ description }}</p>
      <button @click="handleClick">Get Started</button>
    </header>
  </div>
</template>

<script>
export default {
  name: 'App',
  data() {
    return {
      title: '${name}',
      description: '${description}'
    }
  },
  methods: {
    handleClick() {
      alert('Welcome to ${name}!');
    }
  }
}
</script>

<style>
#app {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  text-align: center;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
}

header h1 {
  font-size: 3rem;
  margin-bottom: 1rem;
}

button {
  background: white;
  color: #667eea;
  border: none;
  padding: 1rem 2rem;
  font-size: 1.1rem;
  border-radius: 50px;
  cursor: pointer;
  transition: transform 0.3s;
  margin-top: 2rem;
}

button:hover {
  transform: translateY(-2px);
}
</style>`;
  
  await fs.writeFile(path.join(srcPath, 'main.js'), mainJs);
  await fs.writeFile(path.join(srcPath, 'App.vue'), appVue);
  
  // Create public directory
  const publicPath = path.join(projectPath, 'public');
  await fs.mkdir(publicPath, { recursive: true });
  
  const indexHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1.0">
    <title>${name}</title>
  </head>
  <body>
    <div id="app"></div>
  </body>
</html>`;
  
  await fs.writeFile(path.join(publicPath, 'index.html'), indexHtml);
}

async function createCppProject(projectPath, name, description) {
  const mainCpp = `#include <iostream>
#include <string>

// ${name}
// ${description}

int main() {
    std::cout << "Welcome to ${name}" << std::endl;
    std::cout << "${description}" << std::endl;
    
    std::cout << "\\nPress Enter to continue...";
    std::cin.get();
    
    return 0;
}`;

  const cmakeLists = `cmake_minimum_required(VERSION 3.10)
project(${name.replace(/\s+/g, '_')})

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Add source files
add_executable(\${PROJECT_NAME} src/main.cpp)

# Include directories
target_include_directories(\${PROJECT_NAME} PUBLIC include)`;

  const buildScript = `#!/bin/bash
# Build script for ${name}

mkdir -p build
cd build
cmake ..
make
echo "Build complete. Executable: ./build/${name.replace(/\s+/g, '_')}"`;

  const buildBat = `@echo off
REM Build script for ${name}

if not exist build mkdir build
cd build
cmake -G "MinGW Makefiles" ..
mingw32-make
echo Build complete. Executable: build\\${name.replace(/\s+/g, '_')}.exe
pause`;

  await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'include'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'tests'), { recursive: true });
  
  await fs.writeFile(path.join(projectPath, 'src', 'main.cpp'), mainCpp);
  await fs.writeFile(path.join(projectPath, 'CMakeLists.txt'), cmakeLists);
  await fs.writeFile(path.join(projectPath, 'build.sh'), buildScript);
  await fs.writeFile(path.join(projectPath, 'build.bat'), buildBat);
  await fs.writeFile(path.join(projectPath, '.gitignore'), 'build/\n*.exe\n*.o\n*.out');
  await fs.writeFile(path.join(projectPath, 'README.md'), `# ${name}\n\n${description}\n\n## Building\n\n### Linux/Mac\n\`\`\`bash\n./build.sh\n\`\`\`\n\n### Windows\n\`\`\`cmd\nbuild.bat\n\`\`\``);
}

async function createJavaProject(projectPath, name, description) {
  const className = name.replace(/[^a-zA-Z0-9]/g, '');
  const packageName = `com.${className.toLowerCase()}`;
  
  const mainJava = `package ${packageName};

/**
 * ${name}
 * ${description}
 */
public class Main {
    public static void main(String[] args) {
        System.out.println("Welcome to ${name}");
        System.out.println("${description}");
        
        // Your code here
        Application app = new Application();
        app.run();
    }
}`;

  const appJava = `package ${packageName};

public class Application {
    public void run() {
        System.out.println("Application is running...");
    }
}`;

  const pomXml = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 
         http://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <groupId>${packageName}</groupId>
    <artifactId>${className.toLowerCase()}</artifactId>
    <version>1.0-SNAPSHOT</version>

    <properties>
        <maven.compiler.source>11</maven.compiler.source>
        <maven.compiler.target>11</maven.compiler.target>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    </properties>

    <dependencies>
        <dependency>
            <groupId>junit</groupId>
            <artifactId>junit</artifactId>
            <version>4.13.2</version>
            <scope>test</scope>
        </dependency>
    </dependencies>
</project>`;

  const srcPath = path.join(projectPath, 'src', 'main', 'java', ...packageName.split('.'));
  const testPath = path.join(projectPath, 'src', 'test', 'java', ...packageName.split('.'));
  
  await fs.mkdir(srcPath, { recursive: true });
  await fs.mkdir(testPath, { recursive: true });
  
  await fs.writeFile(path.join(srcPath, 'Main.java'), mainJava);
  await fs.writeFile(path.join(srcPath, 'Application.java'), appJava);
  await fs.writeFile(path.join(projectPath, 'pom.xml'), pomXml);
  await fs.writeFile(path.join(projectPath, '.gitignore'), 'target/\n*.class\n.idea/\n*.iml');
  await fs.writeFile(path.join(projectPath, 'README.md'), `# ${name}\n\n${description}\n\n## Build and Run\n\n\`\`\`bash\nmvn clean compile\nmvn exec:java -Dexec.mainClass="${packageName}.Main"\n\`\`\``);
}

async function createEmptyProject(projectPath, name, description) {
  const readme = `# ${name}\n\n${description}\n\n## Getting Started\n\nThis is an empty project. Add your files here to get started.`;

  await fs.writeFile(path.join(projectPath, 'README.md'), readme);
  await fs.writeFile(path.join(projectPath, '.gitignore'), '.DS_Store\n*.log\nnode_modules/');
}

// Delete project files permanently
ipcMain.handle('delete-project-files', async (event, projectPath) => {
  try {
    // Validate path exists
    try {
      await fs.access(projectPath);
    } catch {
      return { success: false, error: 'Project path does not exist' };
    }

    // Security check: ensure path is within allowed directories
    const normalizedPath = path.resolve(projectPath);
    const normalizedPathForCompare = process.platform === 'win32'
      ? normalizedPath.toLowerCase()
      : normalizedPath;
    const homeDir = os.homedir();

    // Prevent deletion of critical system directories
    const forbiddenPaths = [
      homeDir,
      path.join(homeDir, 'Desktop'),
      path.join(homeDir, 'Documents'),
      path.join(homeDir, 'Downloads'),
      'C:\\',
      'C:\\Windows',
      'C:\\Program Files',
      'C:\\Program Files (x86)',
      '/root',
      '/home',
      '/usr',
      '/bin',
      '/etc'
    ];

    const isForbidden = forbiddenPaths.some(forbidden => {
      const normalizedForbidden = path.resolve(forbidden);
      const normalizedForbiddenForCompare = process.platform === 'win32'
        ? normalizedForbidden.toLowerCase()
        : normalizedForbidden;
      return normalizedPathForCompare === normalizedForbiddenForCompare ||
             normalizedPathForCompare.startsWith(normalizedForbiddenForCompare + path.sep);
    });

    if (isForbidden) {
      return { success: false, error: 'Cannot delete system or user directories' };
    }

    // Ensure the path is within the configured projects directory
    const normalizedProjectsBase = path.resolve(projectsBasePath);
    const normalizedProjectsBaseForCompare = process.platform === 'win32'
      ? normalizedProjectsBase.toLowerCase()
      : normalizedProjectsBase;
    if (
      normalizedPathForCompare !== normalizedProjectsBaseForCompare &&
      !normalizedPathForCompare.startsWith(normalizedProjectsBaseForCompare + path.sep)
    ) {
      return { success: false, error: 'Can only delete projects within the configured workspace directory' };
    }

    // Recursively delete directory
    stopFileWatcher(normalizedPath);
    await fs.rm(normalizedPath, { recursive: true, force: true });

    return { success: true };
  } catch (error) {
    console.error('Error deleting project:', error);
    return { success: false, error: error.message };
  }
});

// Save recent projects
ipcMain.handle('save-recent-projects', async (event, projects) => {
  try {
    await saveRecentProjectsToDisk(projects);
    return { success: true };
  } catch (error) {
    console.error('Error saving recent projects:', error);
    return { success: false, error: error.message };
  }
});

// ============================================
// EXTENSION SYSTEM IPC HANDLERS
// ============================================

// Get all installed extensions
ipcMain.handle('get-installed-extensions', async () => {
  try {
    const extensions = extensionManager.getInstalledExtensions();
    return { success: true, extensions };
  } catch (error) {
    logger.error('Failed to get installed extensions', { error: error.message });
    return { success: false, error: error.message, extensions: [] };
  }
});

// Install extension
ipcMain.handle('install-extension', async (event, extensionData) => {
  try {
    const result = await extensionManager.installExtension(extensionData);

    if (result.success && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('extension-installed', result.extension);
    }

    return result;
  } catch (error) {
    logger.error('Failed to install extension', { error: error.message });
    return { success: false, error: error.message };
  }
});

// Uninstall extension
ipcMain.handle('uninstall-extension', async (event, extensionId) => {
  try {
    const result = await extensionManager.uninstallExtension(extensionId);

    if (result.success && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('extension-uninstalled', extensionId);
    }

    return result;
  } catch (error) {
    logger.error('Failed to uninstall extension', { error: error.message });
    return { success: false, error: error.message };
  }
});

// Enable extension
ipcMain.handle('enable-extension', async (event, extensionId) => {
  try {
    const result = await extensionManager.enableExtension(extensionId);

    if (result.success && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('extension-enabled', extensionId);
    }

    return result;
  } catch (error) {
    logger.error('Failed to enable extension', { error: error.message });
    return { success: false, error: error.message };
  }
});

// Disable extension
ipcMain.handle('disable-extension', async (event, extensionId) => {
  try {
    const result = await extensionManager.disableExtension(extensionId);

    if (result.success && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('extension-disabled', extensionId);
    }

    return result;
  } catch (error) {
    logger.error('Failed to disable extension', { error: error.message });
    return { success: false, error: error.message };
  }
});

// Get theme extensions
ipcMain.handle('get-theme-extensions', async () => {
  try {
    const themes = extensionManager.getThemeExtensions();
    return { success: true, themes };
  } catch (error) {
    logger.error('Failed to get theme extensions', { error: error.message });
    return { success: false, error: error.message, themes: [] };
  }
});

// Load theme CSS
ipcMain.handle('load-theme-css', async (event, themeId) => {
  try {
    return await extensionManager.getThemeCSS(themeId);
  } catch (error) {
    logger.error('Failed to load theme CSS', { themeId, error: error.message });
    return { success: false, error: error.message };
  }
});

// Get extension settings
ipcMain.handle('get-extension-settings', async (event, extensionId) => {
  try {
    const settings = appSettings.extensions.settings[extensionId] || {};
    return { success: true, settings };
  } catch (error) {
    logger.error('Failed to get extension settings', { extensionId, error: error.message });
    return { success: false, error: error.message, settings: {} };
  }
});

// Save extension settings
ipcMain.handle('save-extension-settings', async (event, extensionId, settings) => {
  try {
    if (!appSettings.extensions.settings) {
      appSettings.extensions.settings = {};
    }

    appSettings.extensions.settings[extensionId] = settings;
    await saveSettings();

    return { success: true };
  } catch (error) {
    logger.error('Failed to save extension settings', { extensionId, error: error.message });
    return { success: false, error: error.message };
  }
});

// Download theme from URL
ipcMain.handle('download-theme', async (event, themeId, cssUrl, manifestData) => {
  try {
    return await extensionManager.downloadThemeFromURL(themeId, cssUrl, manifestData);
  } catch (error) {
    logger.error('Failed to download theme', { themeId, error: error.message });
    return { success: false, error: error.message };
  }
});
