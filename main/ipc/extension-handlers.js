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
}

module.exports = {
  registerExtensionIpcHandlers
};
