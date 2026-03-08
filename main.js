const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, dialog, shell, clipboard, globalShortcut, safeStorage, session } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const { exec, execFile, spawn } = require('child_process');
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
const { UpdateManager } = require('./main/update-manager');
const { WorkspaceServices } = require('./main/workspace-services');
const { OperationQueue } = require('./main/operation-queue');
const { createRendererFileService } = require('./main/renderer-file-service');
const { ProjectDiscoveryService } = require('./main/project-discovery-service');
const { Logger } = require('./main/logger');
const { createLicenseManager } = require('./main/license/license-manager');
const { createWindowSecurityManager } = require('./main/window-security-manager');
const { createWindowsCommandUtils } = require('./main/windows-command-utils');
const { createVsCodeLauncherService } = require('./main/vscode-launcher-service');
const {
  GITHUB_TOKEN_ENCRYPTED_KEY,
  GITHUB_TOKEN_LEGACY_KEY,
  MAX_SETTINGS_FILE_SIZE_BYTES,
  MAX_SETTINGS_PATH_LENGTH,
  ALLOWED_TERMINAL_APPS,
  buildDefaultAppSettings,
  sanitizeAppSettings,
  getRendererSafeSettings
} = require('./main/settings/app-settings');

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
const COMMAND_MAX_BUFFER_BYTES = 1024 * 1024 * 5;
const licenseManager = createLicenseManager({
  app,
  fsPromises: fs,
  cryptoModule: crypto,
  osModule: os,
  safeStorageRef: safeStorage,
  processRef: process,
  consoleRef: console
});

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
    if (!licenseManager.isProUnlocked()) {
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
  const fallbackInfo = {
    version: packageVersion,
    displayVersion: `v${packageVersion}`,
    channel: 'stable'
  };

  try {
    const rawContent = await fs.readFile(versionFilePath, 'utf-8');
    const parsed = JSON.parse(rawContent);
    const parsedChannel = parsed && typeof parsed.channel === 'string' && parsed.channel.trim()
      ? parsed.channel.trim()
      : fallbackInfo.channel;
    const parsedDisplayVersion = parsed && typeof parsed.displayVersion === 'string' && parsed.displayVersion.trim()
      ? parsed.displayVersion.trim()
      : fallbackInfo.displayVersion;

    appVersionInfo = {
      version: fallbackInfo.version,
      displayVersion: parsedDisplayVersion,
      channel: parsedChannel
    };
    return;
  } catch (error) {
    console.warn('Failed to load version.json metadata, falling back to defaults:', error.message);
  }

  appVersionInfo = fallbackInfo;
}

function getAppVersionInfo() {
  return { ...appVersionInfo };
}

function normalizePathSegmentForComparison(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function resolveProjectCreationPath(projectName, requestedPath, fallbackBasePath = projectsBasePath, options = {}) {
  const normalizedProjectName = typeof projectName === 'string' ? projectName.trim() : '';
  const pathMode = typeof options.pathMode === 'string'
    ? options.pathMode.trim().toLowerCase()
    : '';
  const requestedBasePath = typeof requestedPath === 'string' && requestedPath.trim()
    ? requestedPath.trim()
    : fallbackBasePath;
  const safeBasePath = typeof requestedBasePath === 'string' && requestedBasePath.trim()
    ? requestedBasePath.trim()
    : path.join(os.homedir(), 'Projects');
  const resolvedBasePath = path.resolve(safeBasePath);

  if (!normalizedProjectName) {
    return resolvedBasePath;
  }

  if (pathMode === 'base') {
    return path.join(resolvedBasePath, normalizedProjectName);
  }

  if (pathMode === 'full') {
    return resolvedBasePath;
  }

  const baseName = path.basename(resolvedBasePath);
  if (normalizePathSegmentForComparison(baseName) === normalizePathSegmentForComparison(normalizedProjectName)) {
    return resolvedBasePath;
  }

  return path.join(resolvedBasePath, normalizedProjectName);
}

const logger = new Logger({ app });
const windowSecurityManager = createWindowSecurityManager({
  baseDir: __dirname,
  logger,
  session,
  shell
});
const windowsCommandUtils = createWindowsCommandUtils();
const vscodeLauncherService = createVsCodeLauncherService({
  platform: process.platform,
  env: process.env,
  pathModule: path,
  fsPromises: fs,
  spawnFn: spawn,
  windowsCommandUtils
});
const updateManager = new UpdateManager({ logger, app, BrowserWindow });
const workspaceServices = new WorkspaceServices({ app, logger });
const operationQueue = new OperationQueue({ logger });
const projectDiscoveryService = new ProjectDiscoveryService({ logger });
const rendererFileService = createRendererFileService({
  validateGitPath,
  sanitizeAppSettings,
  getRendererSafeSettings,
  getProjectsBasePath: () => projectsBasePath,
  getCurrentSettings: () => appSettings,
  maxSettingsFileSizeBytes: MAX_SETTINGS_FILE_SIZE_BYTES,
  maxSettingsPathLength: MAX_SETTINGS_PATH_LENGTH,
  logger
});

function truncateTelemetryText(value, maxLength = 4000) {
  const text = typeof value === 'string' ? value : String(value || '');
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...[truncated:${text.length - maxLength}]`;
}

function sanitizeRendererFaultPayload(payload = {}) {
  if (!payload || typeof payload !== 'object') {
    return {
      message: truncateTelemetryText(payload, 500),
      eventType: 'unknown'
    };
  }

  return {
    eventType: typeof payload.eventType === 'string' ? truncateTelemetryText(payload.eventType, 120) : 'unknown',
    message: typeof payload.message === 'string' ? truncateTelemetryText(payload.message, 2000) : 'Renderer fault',
    stack: typeof payload.stack === 'string' ? truncateTelemetryText(payload.stack, 20000) : '',
    sourceFile: typeof payload.sourceFile === 'string' ? truncateTelemetryText(payload.sourceFile, 1200) : '',
    lineNumber: Number.isFinite(payload.lineNumber) ? payload.lineNumber : null,
    columnNumber: Number.isFinite(payload.columnNumber) ? payload.columnNumber : null,
    reason: truncateTelemetryText(payload.reason, 2000),
    severity: payload.severity === 'warn' ? 'warn' : 'error'
  };
}

function broadcastLogEntry(entry) {
  BrowserWindow.getAllWindows().forEach((window) => {
    if (!window || window.isDestroyed()) {
      return;
    }
    try {
      window.webContents.send('app-log-entry', entry);
    } catch {
      // Avoid recursive logger broadcasts if renderer send fails.
    }
  });
}

logger.onEntry((entry) => {
  broadcastLogEntry(entry);
});

process.on('uncaughtException', (error) => {
  try {
    logger.error('Uncaught exception in main process', {
      source: 'main-process',
      name: error?.name || 'Error',
      message: error?.message || String(error || 'Unknown error'),
      stack: error?.stack || ''
    });
  } catch {
    console.error('Failed to record uncaught exception');
  }
});

process.on('unhandledRejection', (reason) => {
  try {
    logger.error('Unhandled promise rejection in main process', {
      source: 'main-process',
      reason
    });
  } catch {
    console.error('Failed to record unhandled rejection');
  }
});

app.on('render-process-gone', (_event, _webContents, details) => {
  logger.error('Renderer process exited unexpectedly', {
    source: 'renderer',
    reason: details?.reason || '',
    exitCode: details?.exitCode ?? null
  });
});

app.on('child-process-gone', (_event, details) => {
  logger.warn('Child process exited unexpectedly', {
    source: 'main-process',
    type: details?.type || '',
    reason: details?.reason || '',
    exitCode: details?.exitCode ?? null,
    serviceName: details?.serviceName || ''
  });
});

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
    const commandLine = windowsCommandUtils.buildWindowsCommandLine({ command }, args);
    const result = await windowsCommandUtils.executeWindowsCommand(commandLine, timeout);
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

function redactGitSecrets(text) {
  if (typeof text !== 'string' || !text) {
    return '';
  }

  return text
    .replace(/(https?:\/\/)([^@\s/]+)@/gi, '$1***@')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]+\b/g, 'gh***')
    .replace(/(authorization:\s*token\s+)[^\s]+/gi, '$1***');
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
  const safeCommandDisplay = redactGitSecrets(commandDisplay);
  logger.info(`Executing: ${safeCommandDisplay}`, { cwd, operation });

  const result = await executeCommandWithArgs(gitExecutable, args, {
    cwd,
    timeout: Number.isFinite(options.timeout) && options.timeout > 0 ? options.timeout : 60000,
    env: options.env && typeof options.env === 'object' ? options.env : null
  });

  if (!result.success) {
    const rawStderr = typeof result.stderr === 'string' ? result.stderr : '';
    const safeStderr = redactGitSecrets(rawStderr);
    const safeErrorMessage = options.sensitive
      ? 'Sensitive Git command failed'
      : result.error;
    logger.error(`Git command failed: ${safeCommandDisplay}`, {
      error: safeErrorMessage,
      stderr: safeStderr,
      cwd,
      operation
    });

    return {
      success: false,
      error: mapGitErrorToUserMessage(rawStderr, safeErrorMessage),
      stderr: safeStderr,
      details: options.sensitive ? safeErrorMessage : redactGitSecrets(result.details || safeErrorMessage)
    };
  }

  const output = typeof result.output === 'string' ? result.output : '';
  logger.info(`Git command succeeded: ${safeCommandDisplay}`, {
    stdout: redactGitSecrets(output).substring(0, 200)
  });
  return {
    success: true,
    output,
    stderr: redactGitSecrets(result.stderr || '')
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
    const currentLicenseStatus = licenseManager.getLicenseStatus();
    const tierLabel = currentLicenseStatus.isProUnlocked
      ? `Pro (${currentLicenseStatus.tier || 'Licensed'})`
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

const { attachWindowSecurityGuards, openExternalSafely } = windowSecurityManager;

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
      sandbox: true,
      webSecurity: true,
      webviewTag: false
    }
  });

  attachWindowSecurityGuards(mainWindow, 'main');
  mainWindow.loadFile('index.html');

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl) => {
    logger.error('Renderer failed to load a page', {
      source: 'renderer',
      errorCode,
      errorDescription,
      url: validatedUrl
    });
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error('Main window renderer process exited', {
      source: 'renderer',
      reason: details?.reason || '',
      exitCode: details?.exitCode ?? null
    });
  });

  mainWindow.on('unresponsive', () => {
    logger.warn('Main window became unresponsive', { source: 'renderer' });
  });

  mainWindow.on('responsive', () => {
    logger.info('Main window responsiveness restored', { source: 'renderer' });
  });

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
  await licenseManager.loadLicenseState();
  operationQueue.setPersistencePath(path.join(app.getPath('userData'), 'operation-queue.json'));
  updateManager.initialize({
    channel: appVersionInfo.channel,
    currentVersion: appVersionInfo.version
  });

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
  const previousProjectsPath = projectsBasePath;
  appSettings = sanitizeAppSettings({ ...appSettings, ...incomingSettings }, projectsBasePath);
  projectsBasePath = appSettings.defaultProjectPath;
  const success = await saveSettings();
  if (success) {
    await ensureProjectsDir();
    if (previousProjectsPath !== projectsBasePath) {
      projectDiscoveryService.invalidate();
    }
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

ipcMain.handle('path-exists', async (event, targetPath) => {
  return rendererFileService.checkPathExists(targetPath);
});

ipcMain.handle('is-git-repository', async (event, targetPath) => {
  return rendererFileService.checkGitRepositoryPath(targetPath);
});

ipcMain.handle('import-settings-file', async (event, filePath) => {
  return rendererFileService.importSettingsFromJsonFile(filePath);
});

ipcMain.handle('export-settings-file', async (event, filePath, settingsPayload) => {
  return rendererFileService.exportSettingsToJsonFile(filePath, settingsPayload);
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

  const result = await executeGitArgs(['remote', '-v'], pathValidation.path, 'Remote List');
  if (!result.success) {
    return result;
  }

  return {
    ...result,
    output: redactGitSecrets(result.output || '')
  };
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

  const remoteName = remoteNameValidation.value;
  const remoteUrl = remoteUrlValidation.value;
  const remotesResult = await executeGitArgs(['remote'], pathValidation.path, 'List Remotes');
  if (!remotesResult.success) {
    return remotesResult;
  }

  const existingRemotes = new Set(
    String(remotesResult.output || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  );

  if (existingRemotes.has(remoteName)) {
    const existingUrlResult = await executeGitArgs(
      ['remote', 'get-url', remoteName],
      pathValidation.path,
      'Get Remote URL'
    );
    if (!existingUrlResult.success) {
      return existingUrlResult;
    }

    const existingUrl = String(existingUrlResult.output || '').trim();
    if (existingUrl === remoteUrl) {
      return {
        success: true,
        output: `Remote ${remoteName} is already configured`,
        unchanged: true,
        remoteName,
        remoteUrl: redactGitSecrets(remoteUrl)
      };
    }

    const updateResult = await executeGitArgs(
      ['remote', 'set-url', remoteName, remoteUrl],
      pathValidation.path,
      'Set Remote URL'
    );
    if (!updateResult.success) {
      return updateResult;
    }

    return {
      ...updateResult,
      updated: true,
      remoteName,
      remoteUrl: redactGitSecrets(remoteUrl),
      previousUrl: redactGitSecrets(existingUrl)
    };
  }

  const addResult = await executeGitArgs(
    ['remote', 'add', remoteName, remoteUrl],
    pathValidation.path,
    'Add Remote'
  );
  if (!addResult.success) {
    return addResult;
  }

  return {
    ...addResult,
    added: true,
    remoteName,
    remoteUrl: redactGitSecrets(remoteUrl)
  };
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
        const elevationResult = await windowsCommandUtils.executeWindowsCommand(
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
    const searchDir = typeof searchPath === 'string' && searchPath.trim()
      ? searchPath.trim()
      : projectsBasePath;
    const normalizedQuery = typeof query === 'string' ? query : '';

    return await projectDiscoveryService.searchProjects(searchDir, normalizedQuery);
  } catch (error) {
    logger.warn('Error searching projects', {
      searchPath,
      query,
      error: error.message
    });
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

function invalidateProjectDiscoveryCacheForPath(targetPath = '') {
  try {
    if (typeof targetPath === 'string' && targetPath.trim()) {
      const resolvedPath = path.resolve(targetPath.trim());
      projectDiscoveryService.invalidate(resolvedPath);
      projectDiscoveryService.invalidate(path.dirname(resolvedPath));
    }
    projectDiscoveryService.invalidate(projectsBasePath);
  } catch (error) {
    logger.warn('Failed to invalidate project discovery cache', {
      targetPath,
      error: error.message
    });
  }
}

function deriveRepositoryDirectoryNameFromUrl(repoUrl = '') {
  const normalizedRepoUrl = typeof repoUrl === 'string' ? repoUrl.trim() : '';
  if (!normalizedRepoUrl) {
    return '';
  }

  const withoutTrailingSlash = normalizedRepoUrl.replace(/[\\/]+$/, '');
  const normalizedSlashes = withoutTrailingSlash.replace(/\\/g, '/');
  const lastSlashSegment = normalizedSlashes.split('/').pop() || '';
  const colonIndex = lastSlashSegment.lastIndexOf(':');
  const rawSegment = colonIndex >= 0 ? lastSlashSegment.slice(colonIndex + 1) : lastSlashSegment;
  const cleaned = rawSegment.replace(/\.git$/i, '').trim();
  if (!cleaned) {
    return '';
  }

  return cleaned.replace(/[<>:"|?*]/g, '_');
}

async function buildCloneDestinationSuggestion(basePath, preferredDirectoryName) {
  const normalizedPreferred = typeof preferredDirectoryName === 'string'
    ? preferredDirectoryName.trim().replace(/[<>:"|?*]/g, '_')
    : '';
  if (!normalizedPreferred) {
    return null;
  }

  const rootName = normalizedPreferred.replace(/[-_\s]*\d+$/, '').trim() || normalizedPreferred;
  for (let index = 2; index <= 200; index += 1) {
    const candidateName = `${rootName}-${index}`;
    const candidatePath = path.join(basePath, candidateName);
    try {
      await fs.access(candidatePath);
    } catch {
      return {
        directoryName: candidateName,
        fullPath: candidatePath
      };
    }
  }

  return null;
}

function classifyCloneFailureError(errorMessage = '') {
  const message = typeof errorMessage === 'string' ? errorMessage.trim() : '';
  if (!message) {
    return { errorCode: 'clone_failed', stage: 'finalizing' };
  }

  const destinationMatch = message.match(/destination path ['"]([^'"]+)['"] already exists and is not an empty directory/i);
  if (destinationMatch) {
    return {
      errorCode: 'destination_exists_non_empty',
      stage: 'prepare',
      existingDirectoryName: destinationMatch[1] || ''
    };
  }

  if (/repository not found|not found/i.test(message)) {
    return { errorCode: 'repository_not_found', stage: 'connecting' };
  }

  if (/Authentication failed|Permission denied|access denied/i.test(message)) {
    return { errorCode: 'auth_failed', stage: 'connecting' };
  }

  if (/unable to access|timed out|could not resolve host|failed to connect/i.test(message)) {
    return { errorCode: 'network_error', stage: 'connecting' };
  }

  return { errorCode: 'clone_failed', stage: 'finalizing' };
}

async function performCloneRepository(
  repoUrl,
  targetPath,
  cancellation = { isCancelled: () => false },
  progressReporter = null,
  cloneOptions = {}
) {
  const CLONE_STAGE_PROGRESS_RANGES = {
    prepare: [2, 8],
    initializing: [2, 8],
    connecting: [8, 12],
    counting: [12, 24],
    compressing: [24, 36],
    receiving: [36, 82],
    resolving: [82, 94],
    checkout: [94, 98],
    finalizing: [98, 100],
    complete: [100, 100]
  };

  const toCloneProgressPercent = (stage, stagePercent = null) => {
    const normalizedStage = typeof stage === 'string' ? stage : 'initializing';
    const range = CLONE_STAGE_PROGRESS_RANGES[normalizedStage] || CLONE_STAGE_PROGRESS_RANGES.initializing;
    const [start, end] = range;
    if (!Number.isFinite(stagePercent)) {
      return start;
    }
    const clampedStagePercent = Math.max(0, Math.min(100, Number(stagePercent)));
    return Math.round(start + ((end - start) * (clampedStagePercent / 100)));
  };

  const parseCloneProgressLine = (line) => {
    const trimmed = String(line || '').trim();
    if (!trimmed) {
      return null;
    }

    const stagePatterns = [
      { stage: 'counting', regex: /Counting objects:\s+(\d+)%/i },
      { stage: 'compressing', regex: /Compressing objects:\s+(\d+)%/i },
      { stage: 'receiving', regex: /Receiving objects:\s+(\d+)%/i },
      { stage: 'resolving', regex: /Resolving deltas:\s+(\d+)%/i },
      { stage: 'checkout', regex: /Updating files:\s+(\d+)%/i }
    ];

    for (const entry of stagePatterns) {
      const match = trimmed.match(entry.regex);
      if (match) {
        const stagePercent = Number(match[1]);
        return {
          stage: entry.stage,
          stagePercent,
          percent: toCloneProgressPercent(entry.stage, stagePercent),
          detail: trimmed
        };
      }
    }

    if (/Cloning into/i.test(trimmed)) {
      return {
        stage: 'connecting',
        stagePercent: null,
        percent: toCloneProgressPercent('connecting'),
        detail: trimmed
      };
    }

    if (/Enumerating objects:/i.test(trimmed)) {
      return {
        stage: 'counting',
        stagePercent: null,
        percent: toCloneProgressPercent('counting'),
        detail: trimmed
      };
    }

    if (/Checking connectivity/i.test(trimmed)) {
      return {
        stage: 'finalizing',
        stagePercent: null,
        percent: toCloneProgressPercent('finalizing', 45),
        detail: trimmed
      };
    }

    return null;
  };

  const clonePath = path.resolve(targetPath || projectsBasePath);
  const normalizedRepoUrl = typeof repoUrl === 'string' ? repoUrl.trim() : '';
  const requestedDirectoryName = typeof cloneOptions?.directoryName === 'string'
    ? cloneOptions.directoryName.trim().replace(/[<>:"|?*]/g, '_')
    : '';
  const inferredRepoName = deriveRepositoryDirectoryNameFromUrl(normalizedRepoUrl);
  const cloneDirectoryName = requestedDirectoryName || inferredRepoName;
  const cloneDestinationPath = cloneDirectoryName ? path.join(clonePath, cloneDirectoryName) : '';
  let progressState = {
    stage: '',
    percent: -1
  };

  const emitCloneProgress = (payload = {}) => {
    if (!progressReporter) {
      return;
    }

    const stage = typeof payload.stage === 'string' && payload.stage ? payload.stage : 'initializing';
    const percent = Number.isFinite(payload.percent) ? Math.max(0, Math.min(100, Number(payload.percent))) : null;
    const detail = typeof payload.detail === 'string' ? payload.detail : '';
    const progressLabel = typeof payload.progressLabel === 'string' ? payload.progressLabel : '';
    const phase = typeof payload.phase === 'string' ? payload.phase : 'progress';

    if (phase === 'progress' && progressState.stage === stage && percent !== null && progressState.percent === percent && detail === '') {
      return;
    }

    if (phase === 'progress') {
      progressState = {
        stage,
        percent: percent === null ? progressState.percent : percent
      };
    }

    progressReporter({
      phase,
      stage,
      percent,
      detail,
      progressLabel
    });
  };

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

  emitCloneProgress({
    phase: 'progress',
    stage: 'initializing',
    percent: toCloneProgressPercent('initializing', 20),
    detail: 'Validating repository and destination...'
  });

  if (cloneDestinationPath) {
    try {
      const destinationStats = await fs.stat(cloneDestinationPath);
      if (destinationStats.isDirectory()) {
        const entries = await fs.readdir(cloneDestinationPath);
        if (entries.length > 0) {
          const suggestion = await buildCloneDestinationSuggestion(clonePath, cloneDirectoryName);
          const detail = `Destination folder "${cloneDirectoryName}" already exists and is not empty.`;

          emitCloneProgress({
            phase: 'error',
            stage: 'prepare',
            percent: toCloneProgressPercent('prepare', 100),
            detail
          });

          return {
            success: false,
            errorCode: 'destination_exists_non_empty',
            stage: 'prepare',
            error: detail,
            destinationPath: cloneDestinationPath,
            existingDirectoryName: cloneDirectoryName,
            suggestedDirectoryName: suggestion?.directoryName || '',
            suggestedTargetPath: suggestion?.fullPath || ''
          };
        }
      }
    } catch {
      // Destination does not exist yet; continue.
    }
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let stderrBuffer = '';

    const cloneArgs = ['clone', '--progress', remoteUrlValidation.value];
    if (cloneDirectoryName) {
      cloneArgs.push(cloneDirectoryName);
    }

    const cloneProcess = spawn('git', cloneArgs, {
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
      const text = data.toString();
      stderr += text;
      stderrBuffer += text;

      const lines = stderrBuffer.split(/\r?\n|\r/g);
      stderrBuffer = lines.pop() || '';
      lines.forEach((line) => {
        const progressData = parseCloneProgressLine(line);
        if (!progressData) {
          return;
        }

        emitCloneProgress({
          phase: 'progress',
          stage: progressData.stage,
          percent: progressData.percent,
          detail: progressData.detail,
          progressLabel: Number.isFinite(progressData.percent)
            ? `Progress ${Math.round(progressData.percent)}%`
            : 'Cloning repository...'
        });
      });

      if (cancellation.isCancelled()) {
        try {
          cloneProcess.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
    });

    cloneProcess.on('error', (error) => {
      const classified = classifyCloneFailureError(error?.message || '');

      emitCloneProgress({
        phase: 'error',
        stage: classified.stage || 'finalizing',
        percent: progressState.percent > 0 ? progressState.percent : toCloneProgressPercent(classified.stage || 'finalizing'),
        detail: error.message || 'Clone process failed to start.'
      });
      resolve({
        success: false,
        error: error.message,
        stderr,
        errorCode: classified.errorCode,
        stage: classified.stage
      });
    });

    cloneProcess.on('close', async (code) => {
      if (cancellation.isCancelled()) {
        emitCloneProgress({
          phase: 'error',
          stage: 'finalizing',
          percent: progressState.percent > 0 ? progressState.percent : toCloneProgressPercent('finalizing'),
          detail: 'Clone cancelled'
        });
        resolve({ success: false, cancelled: true, error: 'Operation cancelled', stderr, output: stdout });
        return;
      }
      if (code === 0) {
        emitCloneProgress({
          phase: 'complete',
          stage: 'complete',
          percent: 100,
          detail: 'Repository cloned successfully.',
          progressLabel: 'Clone complete (100%)'
        });
        resolve({
          success: true,
          output: stdout,
          stderr,
          cloneDirectoryName,
          cloneDestinationPath
        });
      } else {
        const errorMessage = stderr.trim() || `git clone exited with code ${code}`;
        const classified = classifyCloneFailureError(errorMessage);
        const existingDirectoryName = classified.existingDirectoryName || cloneDirectoryName;
        const existingPath = existingDirectoryName ? path.join(clonePath, existingDirectoryName) : '';

        let suggestion = null;
        if (classified.errorCode === 'destination_exists_non_empty' && existingDirectoryName) {
          suggestion = await buildCloneDestinationSuggestion(clonePath, existingDirectoryName);
        }

        emitCloneProgress({
          phase: 'error',
          stage: classified.stage || 'finalizing',
          percent: progressState.percent > 0 ? progressState.percent : toCloneProgressPercent(classified.stage || 'finalizing'),
          detail: errorMessage
        });
        resolve({
          success: false,
          error: errorMessage,
          stderr,
          output: stdout,
          errorCode: classified.errorCode,
          stage: classified.stage,
          destinationPath: existingPath || cloneDestinationPath,
          existingDirectoryName,
          suggestedDirectoryName: suggestion?.directoryName || '',
          suggestedTargetPath: suggestion?.fullPath || ''
        });
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
  const directoryName = typeof payload?.directoryName === 'string' ? payload.directoryName : '';
  const result = await performCloneRepository(repoUrl, targetPath, cancellation, null, { directoryName });
  if (result?.success) {
    invalidateProjectDiscoveryCacheForPath(result?.cloneDestinationPath || targetPath);
  }
  return result;
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
ipcMain.handle('clone-repository', async (event, repoUrl, targetPath, options = {}) => {
  const shouldEmitProgress = Boolean(options && options.emitProgress);
  const directoryName = typeof options?.directoryName === 'string' ? options.directoryName : '';
  const sender = event && event.sender && typeof event.sender.send === 'function' ? event.sender : null;
  const progressReporter = shouldEmitProgress && sender
    ? (payload) => {
      sender.send('clone-repository-progress', payload);
    }
    : null;

  const result = await performCloneRepository(
    repoUrl,
    targetPath,
    { isCancelled: () => false },
    progressReporter,
    { directoryName }
  );
  if (result?.success) {
    invalidateProjectDiscoveryCacheForPath(result?.cloneDestinationPath || targetPath || projectsBasePath);
  }
  return result;
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
    
    invalidateProjectDiscoveryCacheForPath(projectPath);

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
      invalidateProjectDiscoveryCacheForPath(normalizedPath);
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
    invalidateProjectDiscoveryCacheForPath(sourcePath);
    invalidateProjectDiscoveryCacheForPath(targetPath);
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

    if (PRO_QUEUE_OPERATION_TYPES.has(operationType) && !licenseManager.isProUnlocked()) {
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

ipcMain.handle('get-log-history', async (_event, options = {}) => {
  try {
    const snapshot = logger.getHistorySnapshot(options && typeof options === 'object' ? options : {});
    return {
      success: true,
      ...snapshot,
      currentLogFile: logger.getCurrentLogFile(),
      logDirectory: logger.getLogDirectory(),
      generatedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || 'Failed to load diagnostic logs',
      entries: [],
      totalEntries: 0,
      filteredEntries: 0,
      stats: null
    };
  }
});

ipcMain.handle('clear-log-history', async () => {
  logger.clearHistory();
  await logger.info('Diagnostic log history cleared', { source: 'diagnostics' });
  return { success: true };
});

ipcMain.handle('open-log-folder', async () => {
  try {
    await logger.initializeLogger();
    const logDirectory = logger.getLogDirectory() || path.join(app.getPath('userData'), 'logs');
    await fs.mkdir(logDirectory, { recursive: true });
    const openError = await shell.openPath(logDirectory);
    if (openError) {
      return {
        success: false,
        error: openError,
        path: logDirectory
      };
    }

    return {
      success: true,
      path: logDirectory
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || 'Failed to open log folder',
      path: ''
    };
  }
});

ipcMain.handle('report-renderer-fault', async (_event, payload = {}) => {
  try {
    const normalized = sanitizeRendererFaultPayload(payload);
    const level = normalized.severity === 'warn' ? 'warn' : 'error';

    if (level === 'warn') {
      await logger.warn('Renderer fault reported', {
        source: 'renderer',
        ...normalized
      });
    } else {
      await logger.error('Renderer fault reported', {
        source: 'renderer',
        ...normalized
      });
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error.message || 'Failed to record renderer fault'
    };
  }
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
  return licenseManager.getLicenseStatus();
});

ipcMain.handle('register-product-key', async (event, productKey) => {
  return licenseManager.registerProductKey(productKey);
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
  const launcher = await vscodeLauncherService.resolveLauncher();
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
    proUnlocked: licenseManager.isProUnlocked()
  };
});

ipcMain.handle('create-project', async (event, projectData) => {
  const {
    name,
    type,
    description,
    path: customPath,
    pathMode: pathModeInput,
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
  const normalizedName = typeof name === 'string' ? name.trim() : '';

  // Validate project name
  if (!normalizedName) {
    return { success: false, error: 'Project name cannot be empty' };
  }
  if (!/^[a-zA-Z0-9-_\s]+$/.test(normalizedName)) {
    return { success: false, error: 'Project name contains invalid characters. Use only letters, numbers, hyphens, underscores, and spaces.' };
  }
  if (normalizedName.length > 50) {
    return { success: false, error: 'Project name is too long (max 50 characters)' };
  }

  const projectPath = resolveProjectCreationPath(normalizedName, customPath, projectsBasePath, {
    pathMode: pathModeInput
  });

  try {
    try {
      const existingStats = await fs.stat(projectPath);
      if (existingStats.isDirectory()) {
        return { success: false, error: 'A project with this name already exists' };
      }
      return { success: false, error: 'A file with this project name already exists' };
    } catch (existingPathError) {
      if (!existingPathError || existingPathError.code !== 'ENOENT') {
        throw existingPathError;
      }
    }

    // Create project directory
    await fs.mkdir(projectPath, { recursive: true });
    
    // Create project structure based on type
    switch(type) {
      case 'electron':
        await createElectronProject(projectPath, normalizedName, description);
        break;
      case 'python':
        await createPythonProject(projectPath, normalizedName, description);
        break;
      case 'web':
        await createWebProject(projectPath, normalizedName, description);
        break;
      case 'nodejs':
        await createNodeProject(projectPath, normalizedName, description);
        break;
      case 'react':
        await createReactProject(projectPath, normalizedName, description);
        break;
      case 'vue':
        await createVueProject(projectPath, normalizedName, description);
        break;
      case 'cpp':
        await createCppProject(projectPath, normalizedName, description);
        break;
      case 'java':
        await createJavaProject(projectPath, normalizedName, description);
        break;
      default:
        await createEmptyProject(projectPath, normalizedName, description);
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
      const openInCodeResult = await vscodeLauncherService.openPathInVsCode(projectPath);
      if (!openInCodeResult.success) {
        logger.warn('Failed to open project in VS Code after creation', {
          projectPath,
          error: openInCodeResult.error
        });
      }
    }

    invalidateProjectDiscoveryCacheForPath(projectPath);
    
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
    const resolvedProjectsPath = path.resolve(projectsPath);

    try {
      await fs.access(resolvedProjectsPath);
    } catch {
      await fs.mkdir(resolvedProjectsPath, { recursive: true });
      projectDiscoveryService.invalidate(resolvedProjectsPath);
      return [];
    }

    const projects = await projectDiscoveryService.getProjects(resolvedProjectsPath);
    return Array.isArray(projects)
      ? projects.map((project) => ({ ...project }))
      : [];
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

  const result = await vscodeLauncherService.openPathInVsCode(resolvedPath);
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
  const normalizedProjectName = typeof projectName === 'string' ? projectName.trim() : '';

  if (!normalizedProjectName) {
    return { success: false, error: 'Project name cannot be empty' };
  }

  if (!/^[a-zA-Z0-9-_\s]+$/.test(normalizedProjectName)) {
    return { success: false, error: 'Project name contains invalid characters. Use only letters, numbers, hyphens, underscores, and spaces.' };
  }

  if (normalizedProjectName.length > 50) {
    return { success: false, error: 'Project name is too long (max 50 characters)' };
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

  const projectPath = resolveProjectCreationPath(normalizedProjectName, targetPath, projectsBasePath, {
    pathMode: templateOptions.pathMode
  });

  try {
    try {
      const existingStats = await fs.stat(projectPath);
      if (existingStats.isDirectory()) {
        return { success: false, error: 'A project with this name already exists' };
      }
      return { success: false, error: 'A file with this project name already exists' };
    } catch (existingPathError) {
      if (!existingPathError || existingPathError.code !== 'ENOENT') {
        throw existingPathError;
      }
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

    logger.info('Project created from template', { templateId, projectName: normalizedProjectName, projectPath });

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
      const openInCodeResult = await vscodeLauncherService.openPathInVsCode(projectPath);
      if (!openInCodeResult.success) {
        logger.warn('Failed to open template project in VS Code after creation', {
          projectPath,
          error: openInCodeResult.error
        });
      }
    }

    invalidateProjectDiscoveryCacheForPath(projectPath);

    return { success: true, path: projectPath };
  } catch (error) {
    logger.error('Failed to create project from template', { templateId, projectName: normalizedProjectName, error: error.message });
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
      electron: "^39.2.3"
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
      sandbox: true,
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
    invalidateProjectDiscoveryCacheForPath(normalizedPath);

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
