const path = require('path');
const { fileURLToPath } = require('url');

function createWindowSecurityManager({
  baseDir,
  logger,
  session,
  shell,
  pathModule = path,
  fileURLToPathFn = fileURLToPath,
  UrlClass = URL
} = {}) {
  let sessionSecurityPoliciesInstalled = false;

  function isPathWithinBase(basePath, targetPath) {
    const normalizedBase = pathModule.resolve(basePath);
    const normalizedTarget = pathModule.resolve(targetPath);

    if (process.platform === 'win32') {
      const baseLower = normalizedBase.toLowerCase();
      const targetLower = normalizedTarget.toLowerCase();
      return targetLower === baseLower || targetLower.startsWith(`${baseLower}${pathModule.sep}`);
    }

    return normalizedTarget === normalizedBase || normalizedTarget.startsWith(`${normalizedBase}${pathModule.sep}`);
  }

  function isTrustedLocalAppUrl(rawUrl) {
    try {
      const parsedUrl = new UrlClass(rawUrl);
      if (parsedUrl.protocol !== 'file:') {
        return false;
      }

      if (parsedUrl.host && parsedUrl.host !== 'localhost') {
        return false;
      }

      const filePath = fileURLToPathFn(parsedUrl);
      if (typeof filePath !== 'string' || !filePath) {
        return false;
      }
      const resolvedPath = pathModule.resolve(filePath);
      return isPathWithinBase(baseDir, resolvedPath);
    } catch {
      return false;
    }
  }

  function validateExternalUrl(rawUrl) {
    try {
      const parsedUrl = new UrlClass(rawUrl);
      const allowedProtocols = new Set(['http:', 'https:']);

      if (!allowedProtocols.has(parsedUrl.protocol)) {
        return { valid: false, error: 'Unsupported URL protocol', protocol: parsedUrl.protocol };
      }

      return { valid: true, url: parsedUrl.toString() };
    } catch {
      return { valid: false, error: 'Invalid URL' };
    }
  }

  async function openExternalSafely(rawUrl) {
    const validation = validateExternalUrl(rawUrl);
    if (!validation.valid) {
      logger?.warn('Blocked opening URL', {
        url: String(rawUrl),
        error: validation.error,
        protocol: validation.protocol || null
      });
      return { success: false, error: validation.error };
    }

    if (!shell || typeof shell.openExternal !== 'function') {
      return { success: false, error: 'External URL handler is unavailable' };
    }

    try {
      await shell.openExternal(validation.url);
      return { success: true };
    } catch (error) {
      logger?.warn('Failed to open external URL', { url: validation.url, error: error.message });
      return { success: false, error: 'Failed to open URL' };
    }
  }

  function installSessionSecurityPolicies() {
    if (sessionSecurityPoliciesInstalled) {
      return;
    }

    const defaultSession = session?.defaultSession;
    if (!defaultSession) {
      return;
    }

    defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      logger?.warn('Denied permission request', {
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
      logger?.warn('Blocked navigation attempt', { window: label, url: navigationUrl });

      if (/^https?:/i.test(navigationUrl)) {
        void openExternalSafely(navigationUrl);
      }
    });

    contents.on('will-attach-webview', (event, webPreferences, params) => {
      event.preventDefault();
      logger?.warn('Blocked webview attachment attempt', { window: label, src: params?.src || null });
    });
  }

  return {
    isPathWithinBase,
    isTrustedLocalAppUrl,
    validateExternalUrl,
    openExternalSafely,
    installSessionSecurityPolicies,
    attachWindowSecurityGuards
  };
}

module.exports = {
  createWindowSecurityManager
};
