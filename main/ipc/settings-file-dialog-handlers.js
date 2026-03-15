function registerSettingsAndFileDialogIpcHandlers({
  ipcMain,
  dialog,
  getMainWindow,
  getProjectsBasePath,
  setProjectsBasePath,
  getAppSettings,
  setAppSettings,
  sanitizeAppSettings,
  saveSettings,
  ensureProjectsDir,
  projectDiscoveryService,
  updateManager,
  getRendererSafeSettings,
  rendererFileService
}) {
  ipcMain.handle('select-folder', async () => {
    const mainWindow = getMainWindow();
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      defaultPath: getProjectsBasePath()
    });

    if (!result.canceled) {
      setProjectsBasePath(result.filePaths[0]);
      return result.filePaths[0];
    }
    return null;
  });

  ipcMain.handle('select-file', async (_event, options = {}) => {
    const mainWindow = getMainWindow();
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: options.properties || ['openFile'],
      filters: options.filters || [],
      defaultPath: options.defaultPath || getProjectsBasePath()
    });

    if (!result.canceled && result.filePaths.length > 0) {
      return result.filePaths[0];
    }
    return null;
  });

  ipcMain.handle('get-projects-path', () => getProjectsBasePath());

  ipcMain.handle('get-settings', () => getRendererSafeSettings(getAppSettings()));

  ipcMain.handle('save-settings', async (_event, settings) => {
    const incomingSettings = settings && typeof settings === 'object' && !Array.isArray(settings)
      ? settings
      : {};
    const currentSettings = getAppSettings();
    const previousSettings = JSON.parse(JSON.stringify(currentSettings || {}));
    const previousTheme = currentSettings.theme;
    const previousUpdateChannel = currentSettings.updateChannel;
    const previousProjectsPath = getProjectsBasePath();

    const mergedSettings = sanitizeAppSettings(
      { ...currentSettings, ...incomingSettings },
      previousProjectsPath
    );
    setAppSettings(mergedSettings);
    setProjectsBasePath(mergedSettings.defaultProjectPath);

    const success = await saveSettings();
    if (!success) {
      setAppSettings(sanitizeAppSettings(previousSettings, previousProjectsPath));
      setProjectsBasePath(previousProjectsPath);
      return false;
    }

    await ensureProjectsDir();
    if (previousProjectsPath !== getProjectsBasePath()) {
      projectDiscoveryService.invalidate();
    }

    const nextSettings = getAppSettings();
    if (previousUpdateChannel !== nextSettings.updateChannel) {
      updateManager.setChannel(nextSettings.updateChannel);
    }

    const mainWindow = getMainWindow();
    if (
      previousTheme !== nextSettings.theme
      && mainWindow
      && !mainWindow.isDestroyed()
    ) {
      mainWindow.webContents.send('theme-changed', nextSettings.theme);
    }

    return true;
  });

  ipcMain.handle('save-dialog', async (_event, options) => {
    const mainWindow = getMainWindow();
    const result = await dialog.showSaveDialog(mainWindow, options);
    return result.filePath;
  });

  ipcMain.handle('path-exists', async (_event, targetPath) => rendererFileService.checkPathExists(targetPath));

  ipcMain.handle('is-git-repository', async (_event, targetPath) => (
    rendererFileService.checkGitRepositoryPath(targetPath)
  ));

  ipcMain.handle('import-settings-file', async (_event, filePath) => (
    rendererFileService.importSettingsFromJsonFile(filePath)
  ));

  ipcMain.handle('export-settings-file', async (_event, filePath, settingsPayload) => (
    rendererFileService.exportSettingsToJsonFile(filePath, settingsPayload)
  ));

  ipcMain.handle('reload-window', () => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.reload();
    }
  });
}

module.exports = {
  registerSettingsAndFileDialogIpcHandlers
};
