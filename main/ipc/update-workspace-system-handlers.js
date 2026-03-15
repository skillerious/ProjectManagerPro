function registerUpdateWorkspaceSystemIpcHandlers({
  ipcMain,
  getMainWindow,
  dialog,
  loadAppVersionInfo,
  getAppVersionInfo,
  updateManager,
  getAppSettings,
  setAppSettings,
  getProjectsBasePath,
  setProjectsBasePath,
  sanitizeAppSettings,
  saveSettings,
  ensureProjectsDir,
  readRecentProjectsFromDisk,
  saveRecentProjectsToDisk,
  getRendererSafeSettings,
  workspaceServices,
  validateGitPath,
  parseAllowedRunCommand,
  validateCommandWorkingDirectory,
  executeCommandWithArgs,
  commandMaxBufferBytes,
  proQueueOperationTypes,
  operationQueue,
  licenseManager,
  logger,
  app,
  shell,
  fsPromises,
  pathModule,
  sanitizeRendererFaultPayload,
  openExternalSafely,
  clipboard,
  vscodeLauncherService,
  osModule = require('os'),
  processRef = process
}) {
  ipcMain.handle('show-about', async () => {
    await loadAppVersionInfo();
    const versionInfo = getAppVersionInfo();
    dialog.showMessageBox(getMainWindow(), {
      type: 'info',
      title: 'About Project Manager Pro',
      message: 'Project Manager Pro',
      detail: `Version ${versionInfo.version}\n\nA professional project management application with VSCode-like interface.\n\n(c) ${new Date().getFullYear()} Project Manager Pro`,
      buttons: ['OK']
    });
  });

  ipcMain.handle('get-app-version-info', async () => {
    await loadAppVersionInfo();
    return getAppVersionInfo();
  });

  ipcMain.handle('get-update-state', async () => updateManager.getState());

  ipcMain.handle('check-for-updates', async () => updateManager.checkForUpdates());

  ipcMain.handle('set-update-channel', async (_event, channel) => {
    const previousChannel = typeof getAppSettings().updateChannel === 'string'
      ? getAppSettings().updateChannel
      : 'stable';
    const result = updateManager.setChannel(channel);
    if (result.success) {
      setAppSettings(sanitizeAppSettings(
        { ...getAppSettings(), updateChannel: result.state.channel },
        getProjectsBasePath()
      ));
      const saved = await saveSettings();
      if (!saved) {
        setAppSettings(sanitizeAppSettings(
          { ...getAppSettings(), updateChannel: previousChannel },
          getProjectsBasePath()
        ));
        updateManager.setChannel(previousChannel);
        return {
          success: false,
          state: updateManager.getState(),
          error: 'Failed to persist update channel setting'
        };
      }
    }
    return result;
  });

  ipcMain.handle('download-update', async () => updateManager.downloadUpdate());

  ipcMain.handle('download-test-update', async (_event, downloadUrl) => (
    updateManager.downloadTestUpdate(downloadUrl)
  ));

  ipcMain.handle('install-update', async () => updateManager.installUpdate());

  ipcMain.handle('rollback-update', async () => {
    const previousChannel = typeof getAppSettings().updateChannel === 'string'
      ? getAppSettings().updateChannel
      : 'stable';
    const result = await updateManager.rollbackToStable();
    if (result.success) {
      setAppSettings(sanitizeAppSettings(
        { ...getAppSettings(), updateChannel: 'stable' },
        getProjectsBasePath()
      ));
      const saved = await saveSettings();
      if (!saved) {
        setAppSettings(sanitizeAppSettings(
          { ...getAppSettings(), updateChannel: previousChannel },
          getProjectsBasePath()
        ));
        updateManager.setChannel(previousChannel);
        return {
          success: false,
          state: updateManager.getState(),
          error: 'Failed to persist rollback channel setting'
        };
      }
    }
    return result;
  });

  ipcMain.handle('create-workspace-snapshot', async (_event, name = '') => {
    try {
      const recentProjects = await readRecentProjectsFromDisk();
      const snapshot = await workspaceServices.createSnapshot({
        name,
        workspacePath: getProjectsBasePath(),
        settings: getRendererSafeSettings(getAppSettings()),
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

  ipcMain.handle('restore-workspace-snapshot', async (_event, snapshotId) => {
    try {
      const snapshot = await workspaceServices.loadSnapshot(snapshotId);
      const restoredSettings = sanitizeAppSettings(snapshot.settings || {}, getProjectsBasePath());
      setAppSettings(restoredSettings);
      setProjectsBasePath(restoredSettings.defaultProjectPath);
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

  ipcMain.handle('save-project-task-profile', async (_event, projectPath, profiles) => {
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

  ipcMain.handle('get-project-task-profiles', async (_event, projectPath) => {
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

  ipcMain.handle('run-project-task-profile', async (_event, projectPath, profileId) => {
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
        ? pathModule.resolve(pathValidation.path, profile.cwd.trim())
        : pathValidation.path;
      const cwdValidation = await validateCommandWorkingDirectory(cwdCandidate);
      if (!cwdValidation.valid) {
        return { success: false, error: cwdValidation.error };
      }

      const result = await executeCommandWithArgs(parsedCommand.executable, parsedCommand.args, {
        cwd: cwdValidation.path,
        timeout: 120000,
        maxBuffer: commandMaxBufferBytes
      });

      if (!result.success) {
        return { success: false, error: result.error || 'Task failed', stderr: result.stderr || '' };
      }

      return { success: true, stdout: result.output || '', stderr: result.stderr || '' };
    } catch (error) {
      return { success: false, error: error.message || 'Failed to run task profile' };
    }
  });

  ipcMain.handle('build-search-index', async (_event, workspacePathInput) => {
    try {
      const workspacePathValue = typeof workspacePathInput === 'string' && workspacePathInput.trim()
        ? workspacePathInput.trim()
        : getProjectsBasePath();
      return workspaceServices.buildSearchIndex({ workspacePath: workspacePathValue });
    } catch (error) {
      return { success: false, error: error.message || 'Failed to build search index' };
    }
  });

  ipcMain.handle('query-search-index', async (_event, query, limit = 60) => {
    try {
      return workspaceServices.querySearchIndex(query, limit);
    } catch (error) {
      return { success: false, error: error.message || 'Failed to query search index', results: [] };
    }
  });

  ipcMain.handle('enqueue-operation', async (_event, type, payload) => {
    try {
      const operationType = typeof type === 'string' ? type.trim() : '';
      if (!operationType) {
        return { success: false, error: 'Operation type is required' };
      }

      if (proQueueOperationTypes.has(operationType) && !licenseManager.isProUnlocked()) {
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

  ipcMain.handle('get-operation-queue', async () => ({ success: true, jobs: operationQueue.getSnapshot() }));

  ipcMain.handle('cancel-operation', async (_event, jobId) => operationQueue.cancel(jobId));

  ipcMain.handle('retry-operation', async (_event, jobId) => operationQueue.retry(jobId));

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
      const logDirectory = logger.getLogDirectory() || pathModule.join(app.getPath('userData'), 'logs');
      await fsPromises.mkdir(logDirectory, { recursive: true });
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

  ipcMain.handle('get-user-data-path', async () => app.getPath('userData'));

  ipcMain.handle('open-user-data-folder', async () => {
    const userDataPath = app.getPath('userData');
    const openError = await shell.openPath(userDataPath);

    if (openError) {
      return { success: false, error: openError, path: userDataPath };
    }

    return { success: true, path: userDataPath };
  });

  ipcMain.handle('get-license-status', async () => licenseManager.getLicenseStatus());

  ipcMain.handle('register-product-key', async (_event, productKey) => (
    licenseManager.registerProductKey(productKey)
  ));

  ipcMain.handle('open-external', async (_event, url) => openExternalSafely(url));

  ipcMain.handle('copy-to-clipboard', (_event, text) => {
    clipboard.writeText(text);
  });

  ipcMain.handle('get-clipboard', () => clipboard.readText());

  ipcMain.handle('run-command', async (_event, command, projectPath) => {
    try {
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
        maxBuffer: commandMaxBufferBytes
      });

      if (!result.success) {
        logger.error(`Command failed: ${parsedCommand.normalizedCommand}`, { error: result.error, stderr: result.stderr });
        const userError = result.error === 'Command timed out' ? 'Command timed out after 2 minutes' : result.error;
        return { success: false, error: userError, stderr: result.stderr };
      }

      logger.info(`Command succeeded: ${parsedCommand.normalizedCommand}`);
      return { success: true, stdout: result.output || '', stderr: result.stderr || '' };
    } catch (error) {
      logger.error('Unexpected error in run-command handler', { error: error?.message });
      return { success: false, error: error?.message || 'An unexpected error occurred' };
    }
  });

  ipcMain.handle('check-vscode', async () => {
    const launcher = await vscodeLauncherService.resolveLauncher();
    return Boolean(launcher);
  });

  ipcMain.handle('submit-issue-report', async (_event, report) => {
    try {
      if (!report || typeof report !== 'object') {
        return { success: false, error: 'Invalid report payload' };
      }

      const category = typeof report.category === 'string' ? report.category.trim() : 'other';
      const description = typeof report.description === 'string' ? report.description.trim() : '';

      if (!description) {
        return { success: false, error: 'Description is required' };
      }

      const settings = getAppSettings();
      const smtpHost = settings.smtpHost || 'smtp.gmail.com';
      const smtpPort = Number(settings.smtpPort) || 587;
      const smtpUser = settings.smtpUser || '';
      const smtpPass = settings.smtpPass || '';
      const recipient = settings.reportRecipient || 'skillerious@gmail.com';

      if (!smtpUser || !smtpPass) {
        return {
          success: false,
          error: 'SMTP not configured. Add your email and app password in Settings > Advanced.'
        };
      }

      const nodemailer = require('nodemailer');

      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        auth: {
          user: smtpUser,
          pass: smtpPass
        },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000
      });

      const versionInfo = getAppVersionInfo();
      const categoryLabels = {
        bug: 'Bug Report',
        crash: 'App Crash / Freeze',
        ui: 'UI / Visual Issue',
        performance: 'Performance',
        feature: 'Feature Request',
        other: 'Other'
      };
      const categoryLabel = categoryLabels[category] || category;
      const categoryColors = {
        bug: { bg: '#2a1520', border: '#d94f6b', text: '#ff8fa3', icon: '&#128027;' },
        crash: { bg: '#2a1215', border: '#e04556', text: '#ff7a85', icon: '&#128165;' },
        ui: { bg: '#1a1a2e', border: '#7c6dd8', text: '#b4a7ff', icon: '&#127912;' },
        performance: { bg: '#1a2215', border: '#5eaa4f', text: '#8fd97e', icon: '&#9889;' },
        feature: { bg: '#152030', border: '#3d8ee8', text: '#7cc0ff', icon: '&#128161;' },
        other: { bg: '#1e1e28', border: '#7888a0', text: '#a8b8d0', icon: '&#128172;' }
      };
      const cc = categoryColors[category] || categoryColors.other;
      const subject = `[Project Manager Pro] ${categoryLabel} — ${versionInfo.displayVersion || versionInfo.version || ''}`;
      const safeDesc = description.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const now = new Date();
      const timestamp = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
        + ' at ' + now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

      const sysInfo = [
        { label: 'App Version', value: versionInfo.displayVersion || versionInfo.version || 'unknown' },
        { label: 'Channel', value: (versionInfo.channel || 'stable').charAt(0).toUpperCase() + (versionInfo.channel || 'stable').slice(1) },
        { label: 'Platform', value: `${processRef.platform} (${processRef.arch})` },
        { label: 'Electron', value: processRef.versions.electron || 'N/A' },
        { label: 'Node.js', value: processRef.version || 'N/A' },
        { label: 'OS Build', value: osModule.release() },
        { label: 'Memory', value: `${Math.round(osModule.totalmem() / (1024 * 1024 * 1024))} GB` }
      ];

      const sysRows = sysInfo.map((item, i) => {
        const rowBg = i % 2 === 0 ? '#161b26' : '#1a2030';
        return `<tr><td style="padding:10px 14px;font-size:13px;font-weight:600;color:#7a8ca6;border-bottom:1px solid #1e2a3a;background:${rowBg};width:120px">${item.label}</td><td style="padding:10px 14px;font-size:13px;color:#d0dced;border-bottom:1px solid #1e2a3a;background:${rowBg};font-family:'Cascadia Code','Fira Code','Consolas',monospace">${item.value}</td></tr>`;
      }).join('');

      const htmlBody = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"></head>
<body style="margin:0;padding:0;background:#0d1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117;padding:32px 16px">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">

<!-- Accent bar -->
<tr><td style="height:4px;background:linear-gradient(90deg,#1f8ee8 0%,#48d2f9 50%,#9fe0ff 100%);border-radius:12px 12px 0 0;font-size:0;line-height:0">&nbsp;</td></tr>

<!-- Main card -->
<tr><td style="background:#131920;border:1px solid #1e2a3a;border-top:none;border-radius:0 0 12px 12px;padding:0">

  <!-- Header -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
  <tr><td style="padding:32px 32px 0 32px;text-align:center">
    <table role="presentation" cellpadding="0" cellspacing="0" align="center">
    <tr><td style="width:52px;height:52px;border-radius:50%;background:#0f1620;border:2px solid #1e2a3a;text-align:center;vertical-align:middle;font-size:22px;line-height:52px">&#128736;</td></tr>
    </table>
    <h1 style="margin:16px 0 4px;font-size:22px;font-weight:700;color:#f0f6ff;letter-spacing:-0.3px">Issue Report</h1>
    <p style="margin:0 0 6px;font-size:13px;color:#5a6d85">${timestamp}</p>
  </td></tr>
  </table>

  <!-- Category badge -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
  <tr><td style="padding:20px 32px 0;text-align:center">
    <table role="presentation" cellpadding="0" cellspacing="0" align="center">
    <tr><td style="background:${cc.bg};border:1px solid ${cc.border};border-radius:999px;padding:7px 18px 7px 14px;font-size:12px;font-weight:700;color:${cc.text};letter-spacing:0.4px;text-transform:uppercase">
      <span style="margin-right:6px">${cc.icon}</span>${categoryLabel}
    </td></tr>
    </table>
  </td></tr>
  </table>

  <!-- Description -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
  <tr><td style="padding:24px 32px 0">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0f1620;border:1px solid #1e2a3a;border-radius:10px">
    <tr><td style="padding:6px 16px;border-bottom:1px solid #1e2a3a">
      <p style="margin:0;font-size:10px;font-weight:700;color:#4a5d78;text-transform:uppercase;letter-spacing:0.6px">Description</p>
    </td></tr>
    <tr><td style="padding:16px">
      <p style="margin:0;font-size:14px;color:#c8d6e8;line-height:1.7;white-space:pre-wrap;word-break:break-word">${safeDesc}</p>
    </td></tr>
    </table>
  </td></tr>
  </table>

  <!-- System info -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
  <tr><td style="padding:24px 32px 0">
    <p style="margin:0 0 10px 2px;font-size:10px;font-weight:700;color:#4a5d78;text-transform:uppercase;letter-spacing:0.6px">System Information</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0f1620;border:1px solid #1e2a3a;border-radius:10px;overflow:hidden">
    ${sysRows}
    </table>
  </td></tr>
  </table>

  <!-- Footer -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
  <tr><td style="padding:28px 32px 24px;text-align:center;border-top:1px solid #1a2232;margin-top:8px">
    <p style="margin:0 0 4px;font-size:11px;color:#3a4d66">Sent automatically from</p>
    <p style="margin:0;font-size:13px;font-weight:600;color:#5a8abf">Project Manager Pro</p>
  </td></tr>
  </table>

</td></tr>
</table>
</td></tr>
</table>
</body></html>`;

      await transporter.sendMail({
        from: smtpUser,
        to: recipient,
        subject,
        html: htmlBody
      });

      logger.info('Issue report sent successfully', { category });
      return { success: true };
    } catch (error) {
      logger.error('Failed to submit issue report', { error: error?.message });
      const message = error?.code === 'EAUTH'
        ? 'Authentication failed. Check your SMTP email and app password in Settings.'
        : error?.code === 'ESOCKET' || error?.code === 'ECONNREFUSED'
          ? 'Could not connect to the mail server. Check your internet connection and SMTP settings.'
          : error?.message || 'Failed to send report';
      return { success: false, error: message };
    }
  });

  ipcMain.handle('get-system-info', () => {
    const versionInfo = getAppVersionInfo();
    return {
      platform: processRef.platform,
      arch: processRef.arch,
      nodeVersion: processRef.version,
      electronVersion: processRef.versions.electron,
      chromeVersion: processRef.versions.chrome,
      v8Version: processRef.versions.v8,
      osRelease: osModule.release(),
      totalMemory: osModule.totalmem(),
      freeMemory: osModule.freemem(),
      cpus: osModule.cpus().length,
      homedir: osModule.homedir(),
      appVersion: versionInfo.version,
      appDisplayVersion: versionInfo.displayVersion,
      appReleaseChannel: versionInfo.channel,
      proUnlocked: licenseManager.isProUnlocked()
    };
  });
}

module.exports = {
  registerUpdateWorkspaceSystemIpcHandlers
};
