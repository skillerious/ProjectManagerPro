function registerExtensionIpcHandlers({
  ipcMain,
  extensionManager,
  getMainWindow,
  logger,
  getAppSettings,
  setAppSettings,
  saveSettings
}) {
  ipcMain.handle('get-installed-extensions', async () => {
    try {
      const extensions = extensionManager.getInstalledExtensions();
      return { success: true, extensions };
    } catch (error) {
      logger.error('Failed to get installed extensions', { error: error.message });
      return { success: false, error: error.message, extensions: [] };
    }
  });

  ipcMain.handle('install-extension', async (_event, extensionData) => {
    try {
      const result = await extensionManager.installExtension(extensionData);
      const mainWindow = getMainWindow();
      if (result.success && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('extension-installed', result.extension);
      }
      return result;
    } catch (error) {
      logger.error('Failed to install extension', { extensionId: extensionData?.id, extensionName: extensionData?.name, error: error.message, stack: error.stack });
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('uninstall-extension', async (_event, extensionId) => {
    try {
      const result = await extensionManager.uninstallExtension(extensionId);
      const mainWindow = getMainWindow();
      if (result.success && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('extension-uninstalled', extensionId);
      }
      return result;
    } catch (error) {
      logger.error('Failed to uninstall extension', { extensionId, error: error.message, stack: error.stack });
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('enable-extension', async (_event, extensionId) => {
    try {
      const result = await extensionManager.enableExtension(extensionId);
      const mainWindow = getMainWindow();
      if (result.success && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('extension-enabled', extensionId);
      }
      return result;
    } catch (error) {
      logger.error('Failed to enable extension', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('disable-extension', async (_event, extensionId) => {
    try {
      const result = await extensionManager.disableExtension(extensionId);
      const mainWindow = getMainWindow();
      if (result.success && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('extension-disabled', extensionId);
      }
      return result;
    } catch (error) {
      logger.error('Failed to disable extension', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-theme-extensions', async () => {
    try {
      const themes = extensionManager.getThemeExtensions();
      return { success: true, themes };
    } catch (error) {
      logger.error('Failed to get theme extensions', { error: error.message });
      return { success: false, error: error.message, themes: [] };
    }
  });

  ipcMain.handle('load-theme-css', async (_event, themeId) => {
    try {
      return await extensionManager.getThemeCSS(themeId);
    } catch (error) {
      logger.error('Failed to load theme CSS', { themeId, error: error.message });
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-extension-settings', async (_event, extensionId) => {
    try {
      const appSettings = getAppSettings();
      const settings = appSettings?.extensions?.settings?.[extensionId] || {};
      return { success: true, settings };
    } catch (error) {
      logger.error('Failed to get extension settings', { extensionId, error: error.message });
      return { success: false, error: error.message, settings: {} };
    }
  });

  ipcMain.handle('save-extension-settings', async (_event, extensionId, settings) => {
    try {
      const appSettings = getAppSettings();
      const currentExtensions = appSettings && typeof appSettings.extensions === 'object' && appSettings.extensions
        ? appSettings.extensions
        : {};
      const currentSettings = currentExtensions && typeof currentExtensions.settings === 'object' && currentExtensions.settings
        ? currentExtensions.settings
        : {};

      const nextSettings = {
        ...appSettings,
        extensions: {
          ...currentExtensions,
          settings: {
            ...currentSettings,
            [extensionId]: settings
          }
        }
      };

      setAppSettings(nextSettings);
      await saveSettings();
      return { success: true };
    } catch (error) {
      logger.error('Failed to save extension settings', { extensionId, error: error.message });
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('download-theme', async (_event, themeId, cssUrl, manifestData) => {
    try {
      return await extensionManager.downloadThemeFromURL(themeId, cssUrl, manifestData);
    } catch (error) {
      logger.error('Failed to download theme', { themeId, error: error.message });
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('fetch-repo-extensions', async () => {
    const https = require('https');
    const REPO_API_URL = 'https://api.github.com/repos/skillerious/ProjectManagerPro/contents/extensions';

    try {
      const fetchJson = (url) => new Promise((resolve, reject) => {
        https.get(url, {
          headers: {
            'User-Agent': 'AppManager-Pro/1.0',
            'Accept': 'application/vnd.github.v3+json'
          }
        }, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            return fetchJson(res.headers.location).then(resolve).catch(reject);
          }
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            if (res.statusCode !== 200) {
              reject(new Error(`GitHub API returned ${res.statusCode}`));
              return;
            }
            try { resolve(JSON.parse(body)); }
            catch (e) { reject(e); }
          });
          res.on('error', reject);
        }).on('error', reject);
      });

      const fetchRaw = (url) => new Promise((resolve, reject) => {
        https.get(url, {
          headers: { 'User-Agent': 'AppManager-Pro/1.0' }
        }, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            return fetchRaw(res.headers.location).then(resolve).catch(reject);
          }
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode}`));
              return;
            }
            resolve(body);
          });
          res.on('error', reject);
        }).on('error', reject);
      });

      // List extension directories
      const entries = await fetchJson(REPO_API_URL);
      const dirs = entries.filter(e => e.type === 'dir');
      const mainWindow = getMainWindow();
      const extensions = [];
      let completed = 0;

      for (const dir of dirs) {
        try {
          // Fetch manifest.json for each extension
          const manifestUrl = `https://raw.githubusercontent.com/skillerious/ProjectManagerPro/main/extensions/${dir.name}/manifest.json`;
          const manifestRaw = await fetchRaw(manifestUrl);
          // Strip UTF-8 BOM if present
          const manifestClean = manifestRaw.charCodeAt(0) === 0xFEFF ? manifestRaw.slice(1) : manifestRaw;
          const manifest = JSON.parse(manifestClean);

          // Fetch theme.css if it exists
          let themeCSS = null;
          if (manifest.main === 'theme.css') {
            const cssUrl = `https://raw.githubusercontent.com/skillerious/ProjectManagerPro/main/extensions/${dir.name}/theme.css`;
            themeCSS = await fetchRaw(cssUrl);
          }

          extensions.push({
            ...manifest,
            themeCSS,
            repoDir: dir.name,
            source: 'github-repo'
          });
        } catch (err) {
          logger.warn('Failed to fetch extension from repo', { dir: dir.name, error: err.message });
        }

        completed++;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('extension-download-progress', {
            phase: 'fetching',
            current: completed,
            total: dirs.length,
            name: dir.name
          });
        }
      }

      return { success: true, extensions };
    } catch (error) {
      logger.error('Failed to fetch repo extensions', { error: error.message });
      return { success: false, error: error.message, extensions: [] };
    }
  });
}

module.exports = {
  registerExtensionIpcHandlers
};
