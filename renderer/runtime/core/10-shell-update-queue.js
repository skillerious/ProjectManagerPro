/* Runtime module: core/10-shell-update-queue.js */
function initializeTitlebar() {
    document.getElementById('titlebar-update-btn')?.addEventListener('click', async () => {
        await checkForUpdatesInteractive();
    });

    // Window controls
    document.getElementById('minimize-btn')?.addEventListener('click', () => {
        ipcRenderer.invoke('minimize-window');
    });

    document.getElementById('maximize-btn')?.addEventListener('click', () => {
        ipcRenderer.invoke('maximize-window');
    });

    document.getElementById('close-btn')?.addEventListener('click', async () => {
        await attemptAppClose();
    });
    
    // Menu items
    const menuItems = document.querySelectorAll('.menu-item');
    const dropdownMenus = document.querySelectorAll('.dropdown-menu');
    let isAnyMenuOpen = false;

    // Helper function to open a specific menu
    const openMenu = (item, menu) => {
        // Close all other menus
        dropdownMenus.forEach(m => {
            if (m !== menu) {
                m.classList.remove('show');
            }
        });

        // Remove active state from all menu items
        menuItems.forEach(i => {
            if (i !== item) {
                i.classList.remove('active');
            }
        });

        // Position menu directly under the clicked item
        const itemRect = item.getBoundingClientRect();
        menu.style.left = `${itemRect.left}px`;
        menu.style.top = `${itemRect.bottom}px`;

        // Open current menu
        menu.classList.add('show');
        item.classList.add('active');
        isAnyMenuOpen = true;
    };

    // Helper function to close all menus
    const closeAllMenus = () => {
        dropdownMenus.forEach(menu => menu.classList.remove('show'));
        menuItems.forEach(item => item.classList.remove('active'));
        isAnyMenuOpen = false;
    };

    menuItems.forEach(item => {
        // Click handler
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            const menuName = item.dataset.menu;
            const menu = document.getElementById(`${menuName}-menu`);

            if (menu) {
                // If this menu is already open, close it
                if (menu.classList.contains('show')) {
                    closeAllMenus();
                } else {
                    openMenu(item, menu);
                }
            }
        });

        // Hover handler - only activate if a menu is already open
        item.addEventListener('mouseenter', (e) => {
            if (isAnyMenuOpen) {
                const menuName = item.dataset.menu;
                const menu = document.getElementById(`${menuName}-menu`);

                if (menu) {
                    openMenu(item, menu);
                }
            }
        });
    });

    // Close menus when clicking outside
    document.addEventListener('click', () => {
        closeAllMenus();
    });
}

function buildRendererFaultFingerprint(payload = {}) {
    return [
        payload.eventType || '',
        payload.message || '',
        payload.sourceFile || '',
        payload.lineNumber ?? '',
        payload.columnNumber ?? ''
    ].join('|');
}

function trimRendererFaultCache() {
    while (rendererFaultRecentReports.size > RENDERER_FAULT_MAX_CACHE_ENTRIES) {
        const oldestKey = rendererFaultRecentReports.keys().next().value;
        if (!oldestKey) {
            break;
        }
        rendererFaultRecentReports.delete(oldestKey);
    }
}

function shouldReportRendererFault(payload = {}) {
    const fingerprint = buildRendererFaultFingerprint(payload);
    if (!fingerprint) {
        return true;
    }

    const now = Date.now();
    const previous = rendererFaultRecentReports.get(fingerprint);
    if (Number.isFinite(previous) && (now - previous) < RENDERER_FAULT_REPORT_COOLDOWN_MS) {
        return false;
    }

    rendererFaultRecentReports.set(fingerprint, now);
    trimRendererFaultCache();
    return true;
}

function buildRendererFaultReason(reason) {
    if (reason instanceof Error) {
        return {
            message: reason.message || String(reason),
            stack: reason.stack || '',
            reason: reason.message || String(reason)
        };
    }
    if (typeof reason === 'string') {
        return {
            message: reason,
            stack: '',
            reason
        };
    }

    try {
        return {
            message: 'Unhandled promise rejection',
            stack: '',
            reason: JSON.stringify(reason)
        };
    } catch {
        return {
            message: 'Unhandled promise rejection',
            stack: '',
            reason: '[unserializable-reason]'
        };
    }
}

async function reportRendererFault(payload = {}) {
    if (!shouldReportRendererFault(payload)) {
        return;
    }

    try {
        await ipcRenderer.invoke('report-renderer-fault', payload);
    } catch {
        // Never throw from global fault handlers.
    }
}

function initializeRendererFaultReporting() {
    if (rendererFaultReportingInitialized) {
        return;
    }

    window.addEventListener('error', (event) => {
        const payload = {
            eventType: 'error',
            severity: 'error',
            message: event?.message || 'Renderer error event',
            sourceFile: event?.filename || '',
            lineNumber: Number.isFinite(event?.lineno) ? event.lineno : null,
            columnNumber: Number.isFinite(event?.colno) ? event.colno : null,
            stack: event?.error?.stack || '',
            reason: event?.error?.message || ''
        };
        void reportRendererFault(payload);
    });

    window.addEventListener('unhandledrejection', (event) => {
        const normalized = buildRendererFaultReason(event?.reason);
        const payload = {
            eventType: 'unhandledrejection',
            severity: 'error',
            message: normalized.message,
            sourceFile: '',
            lineNumber: null,
            columnNumber: null,
            stack: normalized.stack,
            reason: normalized.reason
        };
        void reportRendererFault(payload);
    });

    rendererFaultReportingInitialized = true;
}

function initializeLogViewer() {
    if (typeof createLogViewerController !== 'function') {
        console.warn('Diagnostics log viewer module is unavailable');
        return;
    }

    logViewerController = createLogViewerController({
        ipcRenderer,
        showView: (viewName) => switchView(viewName),
        getCurrentView: () => currentView,
        navigateBack: () => navigateViewHistory('back'),
        openDocumentation: () => openDocumentationView(),
        showNotification: (message, type) => showNotification(message, type)
    });
    logViewerController.initialize();
}

// Initialize all menu items functionality
function initializeMenuItems() {
    // File Menu
    document.getElementById('new-project-menu')?.addEventListener('click', () => {
        showModal('new-project-modal');
        showNotification('Create a new project', 'info');
    });

    document.getElementById('open-project-menu')?.addEventListener('click', async () => {
        const selectedPath = await ipcRenderer.invoke('select-folder');
        if (selectedPath) {
            const shouldOpenInVSCode = normalizeSettings(appSettings).openInVSCode;
            if (shouldOpenInVSCode) {
                showNotification('Opening project in VS Code...', 'info');
                ipcRenderer.invoke('open-in-vscode', selectedPath);
            } else {
                showNotification('Project selected (auto-open in VS Code is disabled)', 'info');
                ipcRenderer.invoke('open-in-explorer', selectedPath);
            }
        }
    });

    document.getElementById('import-project-menu')?.addEventListener('click', async () => {
        await importProject();
    });

    // Welcome screen import button
    document.getElementById('import-project-btn')?.addEventListener('click', async () => {
        await importProject();
    });

    document.getElementById('save-workspace-menu')?.addEventListener('click', async () => {
        showNotification('Saving workspace...', 'info');
        await saveWorkspace();
        showNotification('Workspace saved successfully', 'success');
    });

    document.getElementById('export-project-menu')?.addEventListener('click', async () => {
        if (currentProject) {
            await queueProjectExport(currentProject);
        } else {
            showNotification('Please select a project first', 'error');
        }
    });

    document.getElementById('settings-menu')?.addEventListener('click', () => {
        switchView('settings');
    });

    document.getElementById('exit-menu')?.addEventListener('click', async () => {
        await attemptAppClose();
    });
    
    // Edit Menu
    document.getElementById('cut-menu')?.addEventListener('click', async () => {
        const activeEl = document.activeElement;
        if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
            const start = activeEl.selectionStart;
            const end = activeEl.selectionEnd;
            const selectedText = activeEl.value.substring(start, end);
            if (selectedText) {
                await navigator.clipboard.writeText(selectedText);
                activeEl.value = activeEl.value.substring(0, start) + activeEl.value.substring(end);
                activeEl.selectionStart = activeEl.selectionEnd = start;
            }
        }
    });

    document.getElementById('copy-menu')?.addEventListener('click', async () => {
        const activeEl = document.activeElement;
        if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
            const selectedText = activeEl.value.substring(activeEl.selectionStart, activeEl.selectionEnd);
            if (selectedText) {
                await navigator.clipboard.writeText(selectedText);
                showNotification('Copied to clipboard', 'success');
            }
        }
    });

    document.getElementById('paste-menu')?.addEventListener('click', async () => {
        try {
            const clipboardText = await navigator.clipboard.readText();
            const activeEl = document.activeElement;
            if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
                const start = activeEl.selectionStart;
                const end = activeEl.selectionEnd;
                activeEl.value = activeEl.value.substring(0, start) + clipboardText + activeEl.value.substring(end);
                activeEl.selectionStart = activeEl.selectionEnd = start + clipboardText.length;
            }
        } catch (error) {
            // Fallback to IPC clipboard
            const clipboardText = await ipcRenderer.invoke('get-clipboard');
            if (document.activeElement) {
                document.activeElement.value += clipboardText;
            }
        }
    });
    
    document.getElementById('undo-menu')?.addEventListener('click', () => {
        const activeEl = document.activeElement;
        if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
            document.execCommand('undo');
        } else {
            showNotification('Nothing to undo', 'info');
        }
    });

    document.getElementById('redo-menu')?.addEventListener('click', () => {
        const activeEl = document.activeElement;
        if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
            document.execCommand('redo');
        } else {
            showNotification('Nothing to redo', 'info');
        }
    });

    document.getElementById('find-menu')?.addEventListener('click', () => {
        showModal('search-modal');
    });

    document.getElementById('replace-menu')?.addEventListener('click', () => {
        showModal('search-modal');
        showNotification('Find & Replace opened', 'info');
    });
    
    // View Menu
    document.getElementById('toggle-sidebar-menu')?.addEventListener('click', () => {
        toggleSidebar();
        showNotification('Sidebar toggled', 'info');
    });

    document.getElementById('toggle-statusbar-menu')?.addEventListener('click', () => {
        toggleStatusBar();
        showNotification('Status bar toggled', 'info');
    });

    document.getElementById('theme-menu')?.addEventListener('click', () => {
        switchView('settings');
        setTimeout(() => {
            document.querySelector('[data-category="appearance"]')?.click();
        }, 100);
        showNotification('Opening theme settings...', 'info');
    });

    document.getElementById('zoom-in-menu')?.addEventListener('click', () => {
        document.body.classList.remove('zoom-out');
        document.body.classList.add('zoom-in');
        showNotification('Zoomed in (110%)', 'info');
    });

    document.getElementById('zoom-out-menu')?.addEventListener('click', () => {
        document.body.classList.remove('zoom-in');
        document.body.classList.add('zoom-out');
        showNotification('Zoomed out (90%)', 'info');
    });

    document.getElementById('reset-zoom-menu')?.addEventListener('click', () => {
        document.body.classList.remove('zoom-in', 'zoom-out');
        showNotification('Zoom reset (100%)', 'info');
    });

    document.getElementById('fullscreen-menu')?.addEventListener('click', () => {
        if (document.fullscreenElement) {
            document.exitFullscreen();
            showNotification('Exited fullscreen', 'info');
        } else {
            document.documentElement.requestFullscreen();
            showNotification('Entered fullscreen', 'info');
        }
    });
    
    // Project Menu
    document.getElementById('build-project-menu')?.addEventListener('click', async () => {
        await buildProject();
    });
    
    document.getElementById('run-project-menu')?.addEventListener('click', async () => {
        await runProject();
    });
    
    document.getElementById('install-deps-menu')?.addEventListener('click', async () => {
        await installDependencies();
    });
    
    document.getElementById('project-settings-menu')?.addEventListener('click', () => {
        if (currentProject) {
            showProjectSettings();
        } else {
            showNotification('Please select a project first', 'error');
        }
    });
    
    document.getElementById('debug-project-menu')?.addEventListener('click', async () => {
        if (!currentProject) {
            showNotification('Please select a project first', 'error');
            return;
        }
        showNotification('Starting debugger...', 'info');
        // Open in VS Code with debug for best debugging experience
        try {
            const result = await ipcRenderer.invoke('open-in-vscode', currentProject.path);
            if (result.success) {
                showNotification('Project opened in VS Code for debugging', 'success');
            } else {
                showNotification('Debug: VS Code not found. Use your IDE to debug.', 'warning');
            }
        } catch (error) {
            showNotification('Debug not available for this project type', 'warning');
        }
    });

    document.getElementById('update-deps-menu')?.addEventListener('click', async () => {
        if (!currentProject) {
            showNotification('Please select a project first', 'error');
            return;
        }
        await updateDependencies();
    });

    document.getElementById('delete-project-menu')?.addEventListener('click', async () => {
        if (currentProject) {
            void showDeleteConfirmation(currentProject);
        } else {
            showNotification('Please select a project first', 'error');
        }
    });
    
    // Tools Menu
    document.getElementById('terminal-menu')?.addEventListener('click', async () => {
        const pathForTerminal = resolveTerminalLaunchPath(currentProject ? currentProject.path : workspacePath);
        await ipcRenderer.invoke('open-terminal', pathForTerminal);
    });
    
    document.getElementById('command-palette-menu')?.addEventListener('click', () => {
        showModal('command-palette-modal');
    });

    document.getElementById('clone-repository-menu')?.addEventListener('click', () => {
        if (!ensureProAccess('Git Management')) {
            return;
        }
        showModal('clone-modal');
    });
    
    document.getElementById('git-init-menu')?.addEventListener('click', async () => {
        if (!ensureProAccess('Git Management')) {
            return;
        }
        await initializeGit();
    });
    
    document.getElementById('git-commit-menu')?.addEventListener('click', () => {
        if (!ensureProAccess('Git Management')) {
            return;
        }
        if (typeof openSmartCommitModal === 'function') {
            void openSmartCommitModal();
            return;
        }
        showModal('git-commit-modal');
    });

    document.getElementById('git-push-menu')?.addEventListener('click', async () => {
        if (!ensureProAccess('Git Management')) {
            return;
        }
        if (!currentProject) {
            showNotification('Please select a project first', 'error');
            return;
        }
        document.getElementById('git-push-btn')?.click();
    });
    
    document.getElementById('npm-install-menu')?.addEventListener('click', async () => {
        if (currentProject) {
            const result = await ipcRenderer.invoke('run-command', 'npm install', currentProject.path);
            if (result.success) {
                showNotification('NPM packages installed successfully', 'success');
            } else {
                showNotification(`Error: ${result.error}`, 'error');
            }
        }
    });
    
    document.getElementById('pip-install-menu')?.addEventListener('click', async () => {
        if (currentProject) {
            const result = await ipcRenderer.invoke('run-command', 'pip install -r requirements.txt', currentProject.path);
            if (result.success) {
                showNotification('Python packages installed successfully', 'success');
            } else {
                showNotification(`Error: ${result.error}`, 'error');
            }
        }
    });
    
    document.getElementById('extensions-menu')?.addEventListener('click', () => {
        if (!ensureProAccess('Extensions')) {
            return;
        }
        switchView('extensions');
    });
    
    // Help Menu
    document.getElementById('documentation-menu')?.addEventListener('click', async () => {
        const switched = await openDocumentationView();
        if (switched) {
            showNotification('Documentation opened', 'info');
        }
    });

    document.getElementById('keyboard-shortcuts-menu')?.addEventListener('click', () => {
        showModal('shortcuts-modal');
    });

    document.getElementById('log-viewer-menu')?.addEventListener('click', () => {
        if (!logViewerController) {
            showNotification('Diagnostics viewer is unavailable', 'error');
            return;
        }
        void logViewerController.open();
    });

    document.getElementById('check-updates-menu')?.addEventListener('click', async () => {
        await checkForUpdatesInteractive();
    });

    document.getElementById('report-issue-menu')?.addEventListener('click', () => {
        openConfiguredExternalLink('issues', '', 'Opening issue tracker...');
    });

    document.getElementById('register-product-menu')?.addEventListener('click', () => {
        openRegisterProductModal();
    });

    document.getElementById('about-menu')?.addEventListener('click', () => {
        showAboutDialog();
    });

    syncTitlebarUpdateControl();
}

function updateUpdateState(nextState) {
    if (!nextState || typeof nextState !== 'object') {
        return;
    }

    updateState = {
        ...updateState,
        ...nextState
    };

    reconcileMutedUpdateReminderState();
    syncTitlebarUpdateControl();
}

function getResolvedReleasePageUrl() {
    const releasePageUrl = typeof updateState.releasePageUrl === 'string' ? updateState.releasePageUrl.trim() : '';
    return releasePageUrl || DEFAULT_RELEASES_URL;
}

function getUpdateTitlebarVersion() {
    const latestVersion = typeof updateState.latestVersion === 'string' ? updateState.latestVersion.trim() : '';
    if (latestVersion) {
        return latestVersion;
    }

    const displayVersion = typeof appVersionInfo.displayVersion === 'string' ? appVersionInfo.displayVersion.trim() : '';
    if (displayVersion) {
        return displayVersion;
    }

    const currentVersion = typeof updateState.currentVersion === 'string' ? updateState.currentVersion.trim() : '';
    return currentVersion || 'current build';
}

function getLatestUpdateVersionTag() {
    const latestVersion = typeof updateState.latestVersion === 'string' ? updateState.latestVersion.trim() : '';
    return latestVersion;
}

function reconcileMutedUpdateReminderState() {
    if (updateState.checking) {
        return;
    }

    const latestVersion = getLatestUpdateVersionTag();
    if (!updateState.available || !latestVersion) {
        mutedUpdateReminderVersion = '';
        return;
    }

    if (mutedUpdateReminderVersion && mutedUpdateReminderVersion !== latestVersion) {
        mutedUpdateReminderVersion = '';
    }
}

function isUpdateReminderMutedForCurrentVersion() {
    const latestVersion = getLatestUpdateVersionTag();
    return Boolean(latestVersion && mutedUpdateReminderVersion === latestVersion);
}

function muteUpdateReminderForCurrentVersion() {
    const latestVersion = getLatestUpdateVersionTag();
    if (!latestVersion) {
        return;
    }
    mutedUpdateReminderVersion = latestVersion;
    syncTitlebarUpdateControl();
}

function syncTitlebarUpdateControl() {
    const updateBtn = document.getElementById('titlebar-update-btn');
    if (!updateBtn) {
        return;
    }

    const iconEl = updateBtn.querySelector('i');
    const normalizedSettings = normalizeSettings(appSettings);
    const autoUpdateEnabled = normalizedSettings.autoUpdate !== false;
    const versionLabel = getUpdateTitlebarVersion();

    updateBtn.classList.remove('is-checking', 'is-available', 'is-available-muted', 'is-downloaded', 'is-error', 'is-disabled');

    let iconName = 'fa-arrows-rotate';
    let title = 'Check for updates';

    if (updateState.checking) {
        iconName = 'fa-arrows-rotate';
        title = 'Checking for updates...';
        updateBtn.classList.add('is-checking');
    } else if (updateState.downloaded) {
        iconName = 'fa-circle-check';
        title = `Update ${versionLabel} downloaded. Click to install.`;
        updateBtn.classList.add('is-downloaded');
    } else if (updateState.available) {
        iconName = 'fa-circle-arrow-up';
        if (isUpdateReminderMutedForCurrentVersion()) {
            title = `Update ${versionLabel} available. Reminder paused. Click to review.`;
            updateBtn.classList.add('is-available-muted');
        } else {
            title = `Update ${versionLabel} available. Click to review.`;
            updateBtn.classList.add('is-available');
        }
    } else if (updateState.error) {
        iconName = 'fa-triangle-exclamation';
        title = 'Update check failed. Click to retry.';
        updateBtn.classList.add('is-error');
    } else if (!autoUpdateEnabled) {
        iconName = 'fa-power-off';
        title = 'Auto-update checks are disabled. Click to check manually.';
        updateBtn.classList.add('is-disabled');
    }

    if (iconEl) {
        iconEl.className = `fas ${iconName}`;
    }

    updateBtn.title = title;
    updateBtn.setAttribute('aria-label', title);
}

async function loadUpdateState() {
    try {
        const state = await ipcRenderer.invoke('get-update-state');
        updateUpdateState(state);
    } catch (error) {
        console.warn('Unable to load update state:', error);
        syncTitlebarUpdateControl();
    }
}

async function showAvailableUpdatePrompt({ source = 'manual' } = {}) {
    const latestVersion = updateState.latestVersion || 'latest release';
    const releasePageUrl = getResolvedReleasePageUrl();
    const startupDetail = source === 'startup'
        ? 'A newer release tag was detected from GitHub. Review the release notes to continue.'
        : 'Review release notes and start the download when ready.';

    if (!updateState.supported) {
        const manualDecision = await showUpdateSmartDialog({
            mode: 'info',
            context: source === 'startup' ? 'available-manual-startup' : 'available-manual',
            title: `Update ${latestVersion} Available`,
            subtitle: source === 'startup'
                ? 'A new release was detected automatically.'
                : 'A new release is available for manual installation.',
            detail: 'This build cannot download updates automatically. Open the releases page to download the installer package.',
            version: latestVersion,
            channel: updateState.channel,
            checkedAt: updateState.lastCheckedAt || new Date().toISOString(),
            notes: updateState.releaseNotes,
            actions: [
                { label: 'Open Releases Page', value: 'open-release', variant: 'primary', icon: 'fa-up-right-from-square' },
                { label: 'Remind Me Later', value: 'remind-later', variant: 'secondary', icon: 'fa-bell-slash' }
            ]
        });

        if (manualDecision === 'open-release') {
            const openResult = await ipcRenderer.invoke('open-external', releasePageUrl);
            if (openResult?.success) {
                showNotification('Opened releases page in your browser.', 'success');
            } else {
                showNotification(toSafeErrorMessage(openResult?.error, 'Unable to open releases page.'), 'error');
            }
        } else if (manualDecision === 'remind-later') {
            muteUpdateReminderForCurrentVersion();
            showNotification(`Paused update reminder for ${latestVersion}`, 'info');
        } else {
            showNotification(`Update ${latestVersion} is available`, 'info');
        }
        return;
    }

    const downloadDecision = await showUpdateSmartDialog({
        mode: 'info',
        context: source === 'startup' ? 'available-startup' : 'available',
        title: `Update ${latestVersion} Available`,
        subtitle: source === 'startup'
            ? 'A new release was detected automatically.'
            : 'A new release is ready to download.',
        detail: startupDetail,
        version: latestVersion,
        channel: updateState.channel,
        checkedAt: updateState.lastCheckedAt || new Date().toISOString(),
        notes: updateState.releaseNotes,
        actions: [
            { label: 'Download Update', value: 'download', variant: 'primary', icon: 'fa-cloud-arrow-down' },
            { label: 'Remind Me Later', value: 'remind-later', variant: 'secondary', icon: 'fa-bell-slash' }
        ]
    });
    if (downloadDecision === 'download') {
        await downloadUpdateInteractive();
    } else if (downloadDecision === 'remind-later') {
        muteUpdateReminderForCurrentVersion();
        showNotification(`Paused update reminder for ${latestVersion}`, 'info');
    } else {
        showNotification(`Update ${latestVersion} is available`, 'info');
    }
}

async function checkForUpdatesInBackground(options = {}) {
    const { promptIfAvailable = false, promptSource = 'manual' } = options;
    const configuredChannel = normalizeSettings(appSettings).updateChannel || updateState.channel || 'stable';

    if (configuredChannel !== updateState.channel) {
        const channelResult = await ipcRenderer.invoke('set-update-channel', configuredChannel);
        updateUpdateState(channelResult?.state || {});
    }

    const result = await ipcRenderer.invoke('check-for-updates');
    updateUpdateState(result?.state || {});

    if (result?.success && updateState.available && promptIfAvailable) {
        if (!startupUpdatePromptShown) {
            startupUpdatePromptShown = true;
            if (isUpdateSmartDialogActive()) {
                showNotification(`Update ${updateState.latestVersion || 'latest release'} is available`, 'info');
            } else {
                await showAvailableUpdatePrompt({ source: promptSource });
            }
        }
    }

    return result;
}

async function runStartupUpdateCheck() {
    if (startupUpdateCheckTriggered) {
        return;
    }
    startupUpdateCheckTriggered = true;

    const normalizedSettings = normalizeSettings(appSettings);
    if (!normalizedSettings.autoUpdate) {
        syncTitlebarUpdateControl();
        return;
    }

    try {
        await checkForUpdatesInBackground({
            promptIfAvailable: true,
            promptSource: 'startup'
        });
    } catch (error) {
        console.warn('Startup update check failed:', error);
    }
}

function getUpdateDialogElements() {
    return {
        overlay: document.getElementById('update-smart-overlay'),
        shell: document.getElementById('update-smart-shell'),
        closeBtn: document.getElementById('update-smart-close'),
        iconEl: document.getElementById('update-smart-icon'),
        titleEl: document.getElementById('update-smart-title'),
        subtitleEl: document.getElementById('update-smart-subtitle'),
        detailEl: document.getElementById('update-smart-detail'),
        versionEl: document.getElementById('update-smart-version'),
        channelEl: document.getElementById('update-smart-channel'),
        checkedEl: document.getElementById('update-smart-checked'),
        progressWrapEl: document.getElementById('update-smart-progress-wrap'),
        progressBarEl: document.getElementById('update-smart-progress-bar'),
        progressLabelEl: document.getElementById('update-smart-progress-label'),
        notesWrapEl: document.getElementById('update-smart-notes-wrap'),
        notesEl: document.getElementById('update-smart-notes'),
        actionsEl: document.getElementById('update-smart-actions')
    };
}

function formatUpdateChannelLabel(channel) {
    const normalized = typeof channel === 'string' ? channel.trim().toLowerCase() : '';
    if (!normalized) {
        return 'Stable';
    }

    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function formatUpdateDialogCheckedAt(value) {
    if (!value) {
        return 'Now';
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        return 'Now';
    }

    return parsed.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function getUpdateDialogPrimaryVersion(fallback = 'Unknown') {
    const latest = typeof updateState.latestVersion === 'string' ? updateState.latestVersion.trim() : '';
    if (latest) {
        return latest;
    }

    const currentDisplay = typeof appVersionInfo.displayVersion === 'string' ? appVersionInfo.displayVersion.trim() : '';
    if (currentDisplay) {
        return currentDisplay;
    }

    const currentVersion = typeof updateState.currentVersion === 'string' ? updateState.currentVersion.trim() : '';
    return currentVersion || fallback;
}

function getUpdateDialogCancelValue(actions = []) {
    const cancelAction = actions.find((action) => action.value === 'cancel')
        || actions.find((action) => action.variant === 'secondary')
        || actions[actions.length - 1];
    return cancelAction ? cancelAction.value : 'cancel';
}

function getDefaultUpdateDialogIconHtml(mode = 'info') {
    switch (mode) {
        case 'success':
            return '<i class="fas fa-circle-check"></i>';
        case 'warning':
            return '<i class="fas fa-triangle-exclamation"></i>';
        case 'danger':
            return '<i class="fas fa-circle-xmark"></i>';
        case 'progress':
            return '<i class="fas fa-cloud-arrow-down"></i>';
        default:
            return '<i class="fas fa-arrows-rotate"></i>';
    }
}

function normalizeUpdateDialogNotes(rawNotes) {
    if (typeof rawNotes !== 'string') {
        return [];
    }

    return rawNotes
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.replace(/^[-*]\s+/, ''))
        .slice(0, 6);
}

function showUpdateSmartDialogFallback(options = {}) {
    const actions = Array.isArray(options.actions) && options.actions.length > 0
        ? options.actions
        : [{ label: 'OK', value: 'ok', variant: 'primary' }];
    const title = typeof options.title === 'string' ? options.title.trim() : '';
    const subtitle = typeof options.subtitle === 'string' ? options.subtitle.trim() : '';
    const detail = typeof options.detail === 'string' ? options.detail.trim() : '';
    const fallbackMessage = [title, subtitle, detail].filter(Boolean).join('\n\n') || 'Update action';

    if (actions.length <= 1) {
        alert(fallbackMessage);
        return Promise.resolve(actions[0].value);
    }

    const primaryAction = actions.find((action) => action.variant === 'primary') || actions[0];
    const cancelValue = getUpdateDialogCancelValue(actions);
    const cancelAction = actions.find((action) => action.value === cancelValue);
    const suffix = actions.length > 2
        ? `\n\nOK = ${primaryAction.label}\nCancel = ${cancelAction?.label || 'Cancel'}`
        : '';
    const accepted = confirm(`${fallbackMessage}${suffix}`);
    return Promise.resolve(accepted ? primaryAction.value : cancelValue);
}

function closeUpdateSmartDialog(result = 'cancel') {
    const { overlay } = getUpdateDialogElements();
    const resolve = updateDialogResolve;
    updateDialogResolve = null;

    if (!overlay) {
        if (typeof resolve === 'function') {
            resolve(result);
        }
        return;
    }

    if (!overlay.classList.contains('active') && typeof resolve !== 'function') {
        return;
    }

    if (updateDialogKeyHandler) {
        document.removeEventListener('keydown', updateDialogKeyHandler, true);
        updateDialogKeyHandler = null;
    }

    if (updateDialogMotionTimer) {
        clearTimeout(updateDialogMotionTimer);
        updateDialogMotionTimer = null;
    }

    overlay.onclick = null;
    overlay.classList.remove('update-smart-entering');
    overlay.classList.add('update-smart-closing');
    overlay.setAttribute('aria-hidden', 'true');

    updateDialogMotionTimer = setTimeout(() => {
        overlay.classList.remove(
            'active',
            'mode-info',
            'mode-success',
            'mode-warning',
            'mode-danger',
            'mode-progress',
            'update-smart-closing',
            'update-smart-entering'
        );
        overlay.dataset.context = '';
        overlay.dataset.mode = '';
        updateDialogMotionTimer = null;
    }, UPDATE_SMART_DIALOG_EXIT_MS);

    if (typeof resolve === 'function') {
        resolve(result);
    }
}

function isUpdateSmartDialogActive() {
    const { overlay } = getUpdateDialogElements();
    return Boolean(overlay && overlay.classList.contains('active') && overlay.getAttribute('aria-hidden') !== 'true');
}

function getActiveUpdateSmartDialogContext() {
    const { overlay } = getUpdateDialogElements();
    if (!overlay || !overlay.classList.contains('active')) {
        return '';
    }
    return overlay.dataset.context || '';
}

function setUpdateDialogProgressState(progress, progressLabel = '') {
    const { progressWrapEl, progressBarEl, progressLabelEl } = getUpdateDialogElements();
    if (!progressWrapEl || !progressBarEl || !progressLabelEl) {
        return;
    }

    const hasNumericProgress = Number.isFinite(progress);
    if (!hasNumericProgress) {
        progressWrapEl.classList.add('indeterminate');
        progressBarEl.style.width = '42%';
        progressLabelEl.textContent = progressLabel || 'Processing update request...';
        return;
    }

    const clampedProgress = Math.max(0, Math.min(100, Number(progress)));
    progressWrapEl.classList.remove('indeterminate');
    progressBarEl.style.width = `${clampedProgress}%`;
    progressLabelEl.textContent = progressLabel || `Downloaded ${Math.round(clampedProgress)}%`;
}

function syncUpdateSmartDialogWithState() {
    if (!isUpdateSmartDialogActive()) {
        return;
    }

    const context = getActiveUpdateSmartDialogContext();
    const {
        versionEl,
        channelEl,
        checkedEl,
        subtitleEl,
        detailEl,
        progressWrapEl
    } = getUpdateDialogElements();

    if (versionEl) {
        versionEl.textContent = getUpdateDialogPrimaryVersion();
    }
    if (channelEl) {
        channelEl.textContent = formatUpdateChannelLabel(updateState.channel);
    }
    if (checkedEl && updateState.lastCheckedAt) {
        checkedEl.textContent = formatUpdateDialogCheckedAt(updateState.lastCheckedAt);
    }

    if (context === 'download') {
        if (progressWrapEl) {
            progressWrapEl.hidden = false;
        }

        const percent = Number.isFinite(updateState.downloadProgress) ? updateState.downloadProgress : 0;
        const rounded = Math.round(Math.max(0, Math.min(100, percent)));
        const progressLabel = updateState.downloaded
            ? `Download complete (${rounded || 100}%)`
            : `Downloaded ${rounded}%`;
        setUpdateDialogProgressState(percent, progressLabel);

        if (subtitleEl) {
            subtitleEl.textContent = updateState.downloaded
                ? 'Download complete. Ready to install.'
                : 'Securing and verifying the update package.';
        }
        if (detailEl && updateState.error) {
            detailEl.textContent = toSafeErrorMessage(updateState.error, 'Update download encountered an error.');
        }
    }
}

function showUpdateSmartDialog(options = {}) {
    const elements = getUpdateDialogElements();
    const {
        overlay,
        shell,
        closeBtn,
        iconEl,
        titleEl,
        subtitleEl,
        detailEl,
        versionEl,
        channelEl,
        checkedEl,
        progressWrapEl,
        notesWrapEl,
        notesEl,
        actionsEl
    } = elements;

    const coreElementsAvailable = overlay && shell && closeBtn && iconEl && titleEl && subtitleEl && detailEl
        && versionEl && channelEl && checkedEl && progressWrapEl && notesWrapEl && notesEl && actionsEl;
    if (!coreElementsAvailable) {
        return showUpdateSmartDialogFallback(options);
    }

    if (typeof updateDialogResolve === 'function') {
        closeUpdateSmartDialog('cancel');
    }

    const mode = ['success', 'warning', 'danger', 'progress'].includes(options.mode) ? options.mode : 'info';
    const rawActions = Array.isArray(options.actions) ? options.actions : [];
    const allowEmptyActions = options.allowEmptyActions === true;
    const actions = rawActions.length > 0
        ? rawActions
        : (allowEmptyActions ? [] : [{ label: 'Done', value: 'done', variant: 'primary', icon: 'fa-check' }]);
    const dismissible = options.dismissible !== false;
    const allowEscape = dismissible && options.allowEscape !== false;
    const dismissOnBackdrop = dismissible && options.dismissOnBackdrop === true;
    const hasProgress = Object.prototype.hasOwnProperty.call(options, 'progress');
    const rawNotes = Object.prototype.hasOwnProperty.call(options, 'notes') ? options.notes : updateState.releaseNotes;
    const notes = Array.isArray(rawNotes) ? rawNotes.slice(0, 6) : normalizeUpdateDialogNotes(rawNotes);
    const versionText = options.version || getUpdateDialogPrimaryVersion();
    const checkedAtText = formatUpdateDialogCheckedAt(options.checkedAt || updateState.lastCheckedAt || new Date().toISOString());

    if (updateDialogMotionTimer) {
        clearTimeout(updateDialogMotionTimer);
        updateDialogMotionTimer = null;
    }

    overlay.classList.remove(
        'active',
        'mode-info',
        'mode-success',
        'mode-warning',
        'mode-danger',
        'mode-progress',
        'update-smart-entering',
        'update-smart-closing'
    );
    overlay.classList.add(`mode-${mode}`);
    overlay.dataset.context = typeof options.context === 'string' ? options.context : '';
    overlay.dataset.mode = mode;
    overlay.setAttribute('aria-hidden', 'false');

    iconEl.innerHTML = options.iconHtml || getDefaultUpdateDialogIconHtml(mode);
    titleEl.textContent = options.title || 'App Update';
    subtitleEl.textContent = options.subtitle || '';
    detailEl.textContent = options.detail || '';
    versionEl.textContent = versionText;
    channelEl.textContent = formatUpdateChannelLabel(options.channel || updateState.channel);
    checkedEl.textContent = checkedAtText;

    progressWrapEl.hidden = !hasProgress;
    if (hasProgress) {
        setUpdateDialogProgressState(options.progress, options.progressLabel || '');
    }

    notesWrapEl.hidden = notes.length === 0;
    if (notes.length > 0) {
        notesEl.innerHTML = notes.map((line) => `<li>${escapeHtml(line)}</li>`).join('');
    } else {
        notesEl.innerHTML = '';
    }

    actionsEl.innerHTML = '';
    actionsEl.hidden = actions.length === 0;
    actions.forEach((action) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `update-smart-btn ${action.variant || 'secondary'}`;
        button.style.setProperty('--update-smart-btn-index', String(actionsEl.children.length));
        button.innerHTML = action.icon
            ? `<i class="fas ${action.icon}"></i> ${escapeHtml(action.label)}`
            : escapeHtml(action.label);
        button.disabled = Boolean(action.disabled);
        button.addEventListener('click', () => closeUpdateSmartDialog(action.value));
        actionsEl.appendChild(button);
    });

    closeBtn.hidden = !dismissible;
    closeBtn.disabled = !dismissible;
    closeBtn.onclick = dismissible ? () => {
        const cancelValue = getUpdateDialogCancelValue(actions);
        closeUpdateSmartDialog(cancelValue);
    } : null;

    overlay.onclick = dismissOnBackdrop ? (event) => {
        if (event.target === overlay) {
            const cancelValue = getUpdateDialogCancelValue(actions);
            closeUpdateSmartDialog(cancelValue);
        }
    } : null;

    void overlay.offsetWidth;
    overlay.classList.add('active');
    requestAnimationFrame(() => {
        overlay.classList.add('update-smart-entering');
        const firstAction = actionsEl.querySelector('.update-smart-btn');
        if (firstAction) {
            firstAction.focus({ preventScroll: true });
        } else if (dismissible) {
            closeBtn.focus({ preventScroll: true });
        } else {
            shell.focus({ preventScroll: true });
        }
    });

    return new Promise((resolve) => {
        updateDialogResolve = resolve;
        updateDialogKeyHandler = (event) => {
            if (event.key !== 'Escape' || !allowEscape) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            const cancelValue = getUpdateDialogCancelValue(actions);
            closeUpdateSmartDialog(cancelValue);
        };
        document.addEventListener('keydown', updateDialogKeyHandler, true);
    });
}

function getCloneSmartDialogElements() {
    return {
        overlay: document.getElementById('clone-smart-overlay'),
        shell: document.getElementById('clone-smart-shell'),
        closeBtn: document.getElementById('clone-smart-close'),
        iconEl: document.getElementById('clone-smart-icon'),
        titleEl: document.getElementById('clone-smart-title'),
        subtitleEl: document.getElementById('clone-smart-subtitle'),
        detailEl: document.getElementById('clone-smart-detail'),
        repoEl: document.getElementById('clone-smart-repo'),
        targetEl: document.getElementById('clone-smart-target'),
        stageEl: document.getElementById('clone-smart-stage'),
        progressWrapEl: document.getElementById('clone-smart-progress-wrap'),
        progressBarEl: document.getElementById('clone-smart-progress-bar'),
        progressLabelEl: document.getElementById('clone-smart-progress-label'),
        stepsEl: document.getElementById('clone-smart-steps'),
        actionsEl: document.getElementById('clone-smart-actions')
    };
}

function mapCloneStageToPipelineStep(stage = '') {
    switch (String(stage || '').toLowerCase()) {
        case 'prepare':
        case 'initializing':
        case 'connecting':
            return 'prepare';
        case 'counting':
        case 'compressing':
            return 'counting';
        case 'receiving':
        case 'checkout':
            return 'receiving';
        case 'resolving':
            return 'resolving';
        case 'finalizing':
        case 'complete':
            return 'finalizing';
        default:
            return 'prepare';
    }
}

function setCloneSmartProgressState(progress, label = '') {
    const { progressWrapEl, progressBarEl, progressLabelEl } = getCloneSmartDialogElements();
    if (!progressWrapEl || !progressBarEl || !progressLabelEl) {
        return;
    }

    const hasNumericProgress = Number.isFinite(progress);
    if (!hasNumericProgress) {
        progressWrapEl.classList.add('indeterminate');
        progressBarEl.style.width = '42%';
        progressLabelEl.textContent = label || 'Cloning in progress...';
        return;
    }

    const clampedProgress = Math.max(0, Math.min(100, Number(progress)));
    progressWrapEl.classList.remove('indeterminate');
    progressBarEl.style.width = `${clampedProgress}%`;
    progressLabelEl.textContent = label || `Progress ${Math.round(clampedProgress)}%`;
}

function setCloneSmartPipelineStage(stage, state = 'running') {
    const { stepsEl } = getCloneSmartDialogElements();
    if (!stepsEl) {
        return;
    }

    const pipelineStep = mapCloneStageToPipelineStep(stage);
    const activeIndex = CLONE_PROGRESS_STAGE_ORDER.indexOf(pipelineStep);

    stepsEl.querySelectorAll('.clone-smart-step').forEach((stepEl) => {
        const stepName = stepEl.dataset.step || '';
        const stepIndex = CLONE_PROGRESS_STAGE_ORDER.indexOf(stepName);
        const stateEl = stepEl.querySelector('.clone-smart-step-state');
        stepEl.classList.remove('is-active', 'is-done', 'is-failed');

        if (state === 'success') {
            stepEl.classList.add('is-done');
            if (stateEl) {
                stateEl.textContent = 'Done';
            }
            return;
        }

        if (state === 'failed') {
            if (stepIndex < activeIndex) {
                stepEl.classList.add('is-done');
                if (stateEl) {
                    stateEl.textContent = 'Done';
                }
                return;
            }

            if (stepIndex === activeIndex) {
                stepEl.classList.add('is-failed');
                if (stateEl) {
                    stateEl.textContent = 'Failed';
                }
                return;
            }
        }

        if (stepIndex < activeIndex) {
            stepEl.classList.add('is-done');
            if (stateEl) {
                stateEl.textContent = 'Done';
            }
            return;
        }

        if (stepIndex === activeIndex) {
            stepEl.classList.add('is-active');
            if (stateEl) {
                stateEl.textContent = 'Running';
            }
            return;
        }

        if (stateEl) {
            stateEl.textContent = 'Pending';
        }
    });
}

function setCloneSmartActions(actions = []) {
    const { actionsEl } = getCloneSmartDialogElements();
    if (!actionsEl) {
        return;
    }

    actionsEl.innerHTML = '';
    actions.forEach((action, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `update-smart-btn ${action.variant || 'secondary'}`;
        button.style.setProperty('--update-smart-btn-index', String(index));
        button.innerHTML = action.icon
            ? `<i class="fas ${action.icon}"></i> ${escapeHtml(action.label)}`
            : escapeHtml(action.label);
        button.disabled = Boolean(action.disabled);
        button.addEventListener('click', () => {
            if (typeof action.onClick === 'function') {
                action.onClick();
            }
        });
        actionsEl.appendChild(button);
    });

    actionsEl.hidden = actions.length === 0;
}

function closeCloneSmartDialog() {
    const { overlay } = getCloneSmartDialogElements();
    if (!overlay || !overlay.classList.contains('active')) {
        return;
    }

    if (cloneSmartDialogClosingTimer) {
        clearTimeout(cloneSmartDialogClosingTimer);
        cloneSmartDialogClosingTimer = null;
    }

    overlay.classList.remove('update-smart-entering');
    overlay.classList.add('update-smart-closing');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.onclick = null;
    cloneSmartLastProgressPercent = 0;
    cloneSmartContext = null;

    cloneSmartDialogClosingTimer = setTimeout(() => {
        overlay.classList.remove('active', 'mode-info', 'mode-success', 'mode-warning', 'mode-danger', 'mode-progress', 'update-smart-closing');
        cloneSmartDialogClosingTimer = null;
    }, CLONE_SMART_DIALOG_EXIT_MS);
}

function openCloneSmartDialog(options = {}) {
    const {
        repoUrl = '',
        targetPath = '',
        title = 'Cloning Repository',
        subtitle = 'Preparing clone request.',
        detail = 'Validating repository URL and target path.',
        stage = 'initializing',
        progress = null,
        progressLabel = 'Preparing clone...',
        mode = 'progress',
        running = true
    } = options;

    const {
        overlay,
        shell,
        closeBtn,
        titleEl,
        subtitleEl,
        detailEl,
        repoEl,
        targetEl,
        stageEl
    } = getCloneSmartDialogElements();

    if (!overlay || !shell || !closeBtn || !titleEl || !subtitleEl || !detailEl || !repoEl || !targetEl || !stageEl) {
        return;
    }

    if (cloneSmartDialogClosingTimer) {
        clearTimeout(cloneSmartDialogClosingTimer);
        cloneSmartDialogClosingTimer = null;
    }

    overlay.classList.remove('mode-info', 'mode-success', 'mode-warning', 'mode-danger', 'mode-progress', 'update-smart-entering', 'update-smart-closing');
    overlay.classList.add(`mode-${mode === 'success' || mode === 'danger' || mode === 'warning' ? mode : 'progress'}`, 'active');
    overlay.setAttribute('aria-hidden', 'false');

    titleEl.textContent = title;
    subtitleEl.textContent = subtitle;
    detailEl.textContent = detail;
    repoEl.textContent = truncatePath(repoUrl, 44) || '--';
    targetEl.textContent = truncatePath(targetPath, 44) || '--';
    stageEl.textContent = CLONE_STAGE_LABELS[stage] || 'Cloning';

    cloneSmartLastProgressPercent = Number.isFinite(progress)
        ? Math.max(0, Math.min(100, Number(progress)))
        : 0;
    setCloneSmartProgressState(progress, progressLabel);
    setCloneSmartPipelineStage(stage, running ? 'running' : (mode === 'danger' ? 'failed' : 'success'));
    setCloneSmartActions([]);

    closeBtn.hidden = running;
    closeBtn.disabled = running;
    closeBtn.onclick = running ? null : () => closeCloneSmartDialog();
    overlay.onclick = running ? null : (event) => {
        if (event.target === overlay) {
            closeCloneSmartDialog();
        }
    };

    void overlay.offsetWidth;
    overlay.classList.add('update-smart-entering');
    requestAnimationFrame(() => {
        shell.focus({ preventScroll: true });
    });
}

function handleCloneProgressEvent(payload = {}) {
    const { overlay, subtitleEl, detailEl, stageEl } = getCloneSmartDialogElements();
    if (!overlay || !overlay.classList.contains('active')) {
        return;
    }

    const stage = typeof payload.stage === 'string' && payload.stage.trim()
        ? payload.stage.trim().toLowerCase()
        : 'initializing';
    const progress = Number.isFinite(payload.percent) ? Number(payload.percent) : null;
    if (Number.isFinite(progress)) {
        cloneSmartLastProgressPercent = Math.max(cloneSmartLastProgressPercent, Math.max(0, Math.min(100, progress)));
    }

    const stageLabel = CLONE_STAGE_LABELS[stage] || 'Cloning repository';
    if (stageEl) {
        stageEl.textContent = stageLabel;
    }
    if (subtitleEl) {
        subtitleEl.textContent = stageLabel;
    }
    if (detailEl && typeof payload.detail === 'string' && payload.detail.trim()) {
        detailEl.textContent = payload.detail.trim();
    }

    const progressLabel = typeof payload.progressLabel === 'string' && payload.progressLabel.trim()
        ? payload.progressLabel.trim()
        : (Number.isFinite(cloneSmartLastProgressPercent) ? `Progress ${Math.round(cloneSmartLastProgressPercent)}%` : 'Cloning in progress...');
    setCloneSmartProgressState(Number.isFinite(cloneSmartLastProgressPercent) ? cloneSmartLastProgressPercent : progress, progressLabel);
    setCloneSmartPipelineStage(stage, payload.phase === 'error' ? 'failed' : 'running');
}

function finalizeCloneSmartDialog(result) {
    const success = Boolean(result?.success);
    const { closeBtn, titleEl, subtitleEl, detailEl, stageEl } = getCloneSmartDialogElements();
    if (!titleEl || !subtitleEl || !detailEl || !closeBtn || !stageEl) {
        return;
    }

    const cloneContextSnapshot = cloneSmartContext ? { ...cloneSmartContext } : null;

    if (success) {
        cloneSmartLastProgressPercent = 100;
        setCloneSmartProgressState(100, 'Clone complete (100%)');
        setCloneSmartPipelineStage('complete', 'success');
        stageEl.textContent = CLONE_STAGE_LABELS.complete;
        titleEl.textContent = 'Clone Completed';
        subtitleEl.textContent = 'Repository cloned successfully.';
        detailEl.textContent = 'Your workspace index has been refreshed.';
    } else {
        const failureStage = typeof result?.stage === 'string' && result.stage.trim()
            ? result.stage.trim().toLowerCase()
            : (result?.errorCode === 'destination_exists_non_empty' ? 'prepare' : 'finalizing');
        setCloneSmartPipelineStage(failureStage, 'failed');

        if (result?.errorCode === 'destination_exists_non_empty') {
            const existingDirectoryName = result?.existingDirectoryName || cloneContextSnapshot?.repoName || 'repository';
            titleEl.textContent = 'Destination Already Exists';
            subtitleEl.textContent = `Folder "${existingDirectoryName}" is not empty.`;
            detailEl.textContent = 'Choose a smart recovery option below. No files were changed.';
            stageEl.textContent = 'Conflict detected';
            setCloneSmartProgressState(Number.isFinite(cloneSmartLastProgressPercent) ? cloneSmartLastProgressPercent : 6, 'Destination conflict');
        } else {
            titleEl.textContent = 'Clone Failed';
            subtitleEl.textContent = 'The repository could not be cloned.';
            detailEl.textContent = toSafeErrorMessage(result?.error, 'Review the repository URL and target folder, then try again.');
            stageEl.textContent = CLONE_STAGE_LABELS.failed;
        }
    }

    const openButtonAction = cloneContextSnapshot?.clonedProjectPath
        ? [{
            label: 'Open Project',
            value: 'open-project',
            variant: 'primary',
            icon: 'fa-code',
            onClick: () => {
                const pathToOpen = cloneContextSnapshot?.clonedProjectPath || '';
                if (pathToOpen) {
                    void openInVscode(pathToOpen);
                }
                closeCloneSmartDialog();
            }
        }]
        : [];

    if (success) {
        setCloneSmartActions([
            ...openButtonAction,
            {
                label: 'Done',
                value: 'done',
                variant: openButtonAction.length > 0 ? 'secondary' : 'primary',
                icon: 'fa-check',
                onClick: () => closeCloneSmartDialog()
            }
        ]);
    } else if (result?.errorCode === 'destination_exists_non_empty') {
        const retryDirectoryName = result?.suggestedDirectoryName || '';
        const existingPath = result?.destinationPath || (cloneContextSnapshot?.targetPath && result?.existingDirectoryName
            ? joinPath(cloneContextSnapshot.targetPath, result.existingDirectoryName)
            : '');

        const destinationActions = [];
        if (cloneContextSnapshot?.repoUrl && cloneContextSnapshot?.targetPath && retryDirectoryName) {
            destinationActions.push({
                label: `Clone as ${retryDirectoryName}`,
                value: 'clone-alternate',
                variant: 'primary',
                icon: 'fa-code-branch',
                onClick: () => {
                    closeCloneSmartDialog();
                    void executeCloneRepositoryFlow({
                        repoUrl: cloneContextSnapshot.repoUrl,
                        targetPath: cloneContextSnapshot.targetPath,
                        shouldOpenAfterClone: cloneContextSnapshot.shouldOpenAfterClone === true,
                        directoryName: retryDirectoryName,
                        reopenSourceModal: false
                    });
                }
            });
        }

        destinationActions.push({
            label: 'Open Existing Folder',
            value: 'open-existing',
            variant: 'secondary',
            icon: 'fa-folder-open',
            disabled: !existingPath,
            onClick: () => {
                if (existingPath) {
                    void openInExplorer(existingPath);
                }
                closeCloneSmartDialog();
            }
        });

        destinationActions.push({
            label: 'Choose Different Location',
            value: 'choose-location',
            variant: 'secondary',
            icon: 'fa-folder-tree',
            onClick: () => {
                closeCloneSmartDialog();
                if (cloneContextSnapshot?.targetPath) {
                    const cloneLocationInput = document.getElementById('clone-location');
                    if (cloneLocationInput) {
                        cloneLocationInput.value = cloneContextSnapshot.targetPath;
                    }
                }
                showModal('clone-modal');
            }
        });

        destinationActions.push({
            label: 'Close',
            value: 'close',
            variant: 'secondary',
            icon: 'fa-times',
            onClick: () => closeCloneSmartDialog()
        });

        setCloneSmartActions(destinationActions);
    } else {
        setCloneSmartActions([
            {
                label: 'Try Again',
                value: 'retry',
                variant: 'primary',
                icon: 'fa-rotate-right',
                onClick: () => {
                    closeCloneSmartDialog();
                    showModal('clone-modal');
                }
            },
            {
                label: 'Close',
                value: 'close',
                variant: 'secondary',
                icon: 'fa-times',
                onClick: () => closeCloneSmartDialog()
            }
        ]);
    }

    closeBtn.hidden = false;
    closeBtn.disabled = false;
    closeBtn.onclick = () => closeCloneSmartDialog();
    const { overlay } = getCloneSmartDialogElements();
    if (overlay) {
        overlay.onclick = (event) => {
            if (event.target === overlay) {
                closeCloneSmartDialog();
            }
        };
    }
}

async function executeCloneRepositoryFlow(options = {}) {
    const {
        repoUrl = '',
        targetPath = '',
        shouldOpenAfterClone = false,
        directoryName = '',
        cloneButton = null,
        reopenSourceModal = false
    } = options;

    if (cloneSmartDialogInProgress) {
        showNotification('A clone operation is already running', 'warning');
        return null;
    }

    const normalizedRepoUrl = String(repoUrl || '').trim();
    const normalizedTargetPath = String(targetPath || '').trim();
    const normalizedDirectoryName = String(directoryName || '').trim();
    if (!normalizedRepoUrl || !normalizedTargetPath) {
        return null;
    }

    const fallbackRepoName = deriveRepositoryNameFromUrl(normalizedRepoUrl);
    const resolvedDirectoryName = normalizedDirectoryName || fallbackRepoName;
    const clonedProjectPath = resolvedDirectoryName
        ? joinPath(normalizedTargetPath, resolvedDirectoryName)
        : '';

    cloneSmartDialogInProgress = true;
    if (cloneButton) {
        cloneButton.disabled = true;
    }

    cloneSmartContext = {
        repoUrl: normalizedRepoUrl,
        targetPath: normalizedTargetPath,
        repoName: resolvedDirectoryName || fallbackRepoName,
        clonedProjectPath,
        shouldOpenAfterClone: Boolean(shouldOpenAfterClone),
        directoryName: normalizedDirectoryName
    };

    if (reopenSourceModal) {
        hideModal('clone-modal');
    }

    openCloneSmartDialog({
        repoUrl: normalizedRepoUrl,
        targetPath: normalizedTargetPath,
        stage: 'initializing',
        progress: 2,
        progressLabel: 'Preparing clone...'
    });

    try {
        const result = await ipcRenderer.invoke('clone-repository', normalizedRepoUrl, normalizedTargetPath, {
            emitProgress: true,
            directoryName: normalizedDirectoryName
        });

        if (result?.success) {
            await loadAllProjects({ force: true, showLoading: false });

            const resolvedClonePath = result?.cloneDestinationPath || clonedProjectPath;
            if (resolvedClonePath) {
                const normalizedClonedPath = normalizeRecentProjectPath(resolvedClonePath);
                const clonedProject = workspaceProjectsSnapshot.find((project) => (
                    normalizeRecentProjectPath(project?.path || '') === normalizedClonedPath
                ));
                if (clonedProject) {
                    selectProjectFromCard(clonedProject, { showNotification: false, refreshGit: false });
                } else {
                    setSelectedProjectCardByPath(resolvedClonePath);
                }
            }

            if (shouldOpenAfterClone && (result?.cloneDestinationPath || clonedProjectPath)) {
                void openInVscode(result?.cloneDestinationPath || clonedProjectPath);
            }

            finalizeCloneSmartDialog({ success: true });
            showNotification('Repository cloned successfully', 'success');
            return result;
        }

        finalizeCloneSmartDialog({
            success: false,
            error: result?.error || 'Clone failed',
            errorCode: result?.errorCode || 'clone_failed',
            stage: result?.stage || '',
            destinationPath: result?.destinationPath || '',
            existingDirectoryName: result?.existingDirectoryName || '',
            suggestedDirectoryName: result?.suggestedDirectoryName || '',
            suggestedTargetPath: result?.suggestedTargetPath || ''
        });
        showNotification(`Clone failed: ${toSafeErrorMessage(result?.error, 'Clone failed')}`, 'error');
        return result;
    } catch (error) {
        finalizeCloneSmartDialog({
            success: false,
            error: error?.message || 'Clone request failed'
        });
        showNotification(`Clone error: ${error.message}`, 'error');
        return null;
    } finally {
        cloneSmartDialogInProgress = false;
        if (cloneButton) {
            cloneButton.disabled = false;
        }
    }
}

async function checkForUpdatesInteractive() {
    if (updateState.downloaded) {
        const installDecision = await showUpdateSmartDialog({
            mode: 'success',
            context: 'downloaded',
            title: 'Update Ready to Install',
            subtitle: `Version ${getUpdateDialogPrimaryVersion('latest release')} is downloaded.`,
            detail: 'Install now to restart AppManager and complete the update.',
            version: getUpdateDialogPrimaryVersion(),
            channel: updateState.channel,
            checkedAt: updateState.lastCheckedAt,
            notes: updateState.releaseNotes,
            actions: [
                { label: 'Install and Restart', value: 'install', variant: 'primary', icon: 'fa-rotate-right' },
                { label: 'Later', value: 'later', variant: 'secondary', icon: 'fa-clock' }
            ]
        });
        if (installDecision === 'install') {
            await installDownloadedUpdateInteractive({ skipConfirmation: true });
        }
        return;
    }

    const configuredChannel = normalizeSettings(appSettings).updateChannel || updateState.channel || 'stable';
    const checkingStartedAt = new Date().toISOString();
    void showUpdateSmartDialog({
        mode: 'info',
        context: 'checking',
        title: 'Checking for Updates',
        subtitle: 'Reviewing your configured update channel.',
        detail: 'You can keep working while this check runs in the background.',
        iconHtml: '<i class="fas fa-magnifying-glass"></i>',
        version: getUpdateDialogPrimaryVersion(appVersionInfo.displayVersion || 'Current build'),
        channel: configuredChannel,
        checkedAt: checkingStartedAt,
        progress: null,
        progressLabel: 'Contacting update service...',
        dismissible: true,
        dismissOnBackdrop: true,
        actions: [
            { label: 'Run in Background', value: 'background', variant: 'secondary', icon: 'fa-window-minimize' }
        ]
    });

    showNotification('Checking for updates...', 'info');

    try {
        const result = await checkForUpdatesInBackground();
        closeUpdateSmartDialog('checked');

        if (!result?.success) {
            const retryDecision = await showUpdateSmartDialog({
                mode: 'danger',
                context: 'check-error',
                title: 'Update Check Failed',
                subtitle: 'Unable to contact the update service.',
                detail: toSafeErrorMessage(result?.error || updateState.error, 'Try again in a moment.'),
                version: getUpdateDialogPrimaryVersion(),
                channel: updateState.channel,
                checkedAt: updateState.lastCheckedAt || new Date().toISOString(),
                actions: [
                    { label: 'Retry', value: 'retry', variant: 'primary', icon: 'fa-rotate' },
                    { label: 'Close', value: 'close', variant: 'secondary', icon: 'fa-times' }
                ]
            });
            if (retryDecision === 'retry') {
                await checkForUpdatesInteractive();
            }
            return;
        }

        if (updateState.available) {
            await showAvailableUpdatePrompt({ source: 'manual' });
            return;
        }

        await showUpdateSmartDialog({
            mode: 'success',
            context: 'up-to-date',
            title: 'You Are Up to Date',
            subtitle: `Current version ${appVersionInfo.displayVersion || getUpdateDialogPrimaryVersion()} is the latest available.`,
            detail: 'No new package is available for your selected channel right now.',
            version: appVersionInfo.displayVersion || getUpdateDialogPrimaryVersion(),
            channel: updateState.channel,
            checkedAt: updateState.lastCheckedAt || checkingStartedAt,
            actions: [
                { label: 'Done', value: 'done', variant: 'primary', icon: 'fa-check' }
            ]
        });
    } catch (error) {
        closeUpdateSmartDialog('error');
        await showUpdateSmartDialog({
            mode: 'danger',
            context: 'check-error',
            title: 'Update Check Failed',
            subtitle: 'An unexpected error interrupted the update check.',
            detail: toSafeErrorMessage(error?.message, 'Please try again.'),
            version: getUpdateDialogPrimaryVersion(),
            channel: updateState.channel,
            checkedAt: new Date().toISOString(),
            actions: [
                { label: 'Close', value: 'close', variant: 'secondary', icon: 'fa-times' }
            ]
        });
    }
}

async function rollbackToStableInteractive() {
    const decision = await showUpdateSmartDialog({
        mode: 'warning',
        context: 'rollback-request',
        title: 'Rollback to Stable Channel',
        subtitle: 'Switch update channel to stable and check for rollback package?',
        detail: 'Your update channel setting will be changed to stable for this action.',
        version: getUpdateDialogPrimaryVersion(),
        channel: 'stable',
        checkedAt: new Date().toISOString(),
        actions: [
            { label: 'Check Stable Channel', value: 'check', variant: 'primary', icon: 'fa-rotate-left' },
            { label: 'Cancel', value: 'cancel', variant: 'secondary', icon: 'fa-times' }
        ]
    });
    if (decision !== 'check') {
        return;
    }

    const rollbackStartedAt = new Date().toISOString();
    void showUpdateSmartDialog({
        mode: 'warning',
        context: 'rollback-checking',
        title: 'Checking Stable Channel',
        subtitle: 'Looking for a rollback package...',
        detail: 'You can keep working while this check runs in the background.',
        iconHtml: '<i class="fas fa-rotate-left"></i>',
        version: getUpdateDialogPrimaryVersion(),
        channel: 'stable',
        checkedAt: rollbackStartedAt,
        progress: null,
        progressLabel: 'Contacting stable release feed...',
        dismissible: true,
        dismissOnBackdrop: true,
        actions: [
            { label: 'Run in Background', value: 'background', variant: 'secondary', icon: 'fa-window-minimize' }
        ]
    });

    showNotification('Checking stable channel for rollback...', 'info');
    try {
        const result = await ipcRenderer.invoke('rollback-update');
        updateUpdateState(result?.state || {});
        closeUpdateSmartDialog('checked');
        if (!result?.success) {
            await showUpdateSmartDialog({
                mode: 'danger',
                context: 'rollback-error',
                title: 'Rollback Check Failed',
                subtitle: 'Unable to inspect stable channel updates.',
                detail: toSafeErrorMessage(result?.error, 'Please try again later.'),
                version: getUpdateDialogPrimaryVersion(),
                channel: 'stable',
                checkedAt: updateState.lastCheckedAt || rollbackStartedAt,
                actions: [
                    { label: 'Close', value: 'close', variant: 'secondary', icon: 'fa-times' }
                ]
            });
            return;
        }

        const normalized = normalizeSettings({
            ...appSettings,
            updateChannel: 'stable'
        });
        appSettings = normalized;
        await applySettingsToForm(appSettings, { resetDirtyState: true });

        if (updateState.available) {
            const latestVersion = updateState.latestVersion || 'stable release';
            const shouldDownload = await showUpdateSmartDialog({
                mode: 'warning',
                context: 'rollback-available',
                title: `Stable ${latestVersion} Available`,
                subtitle: 'A rollback package is available from the stable channel.',
                detail: 'Download now to stage this stable build for installation.',
                version: latestVersion,
                channel: 'stable',
                checkedAt: updateState.lastCheckedAt || new Date().toISOString(),
                notes: updateState.releaseNotes,
                actions: [
                    { label: 'Download Rollback', value: 'download', variant: 'primary', icon: 'fa-cloud-arrow-down' },
                    { label: 'Later', value: 'later', variant: 'secondary', icon: 'fa-clock' }
                ]
            });
            if (shouldDownload === 'download') {
                await downloadUpdateInteractive();
            }
            return;
        }

        await showUpdateSmartDialog({
            mode: 'info',
            context: 'rollback-none',
            title: 'No Rollback Package Found',
            subtitle: 'Stable channel does not currently offer a lower package.',
            detail: 'You are already on the newest stable-compatible release.',
            version: getUpdateDialogPrimaryVersion(),
            channel: 'stable',
            checkedAt: updateState.lastCheckedAt || rollbackStartedAt,
            actions: [
                { label: 'Done', value: 'done', variant: 'primary', icon: 'fa-check' }
            ]
        });
    } catch (error) {
        closeUpdateSmartDialog('error');
        await showUpdateSmartDialog({
            mode: 'danger',
            context: 'rollback-error',
            title: 'Rollback Check Failed',
            subtitle: 'An unexpected error interrupted rollback detection.',
            detail: toSafeErrorMessage(error?.message, 'Please try again.'),
            version: getUpdateDialogPrimaryVersion(),
            channel: 'stable',
            checkedAt: new Date().toISOString(),
            actions: [
                { label: 'Close', value: 'close', variant: 'secondary', icon: 'fa-times' }
            ]
        });
    }
}

async function downloadUpdateInteractive() {
    const targetVersion = updateState.latestVersion || 'latest release';
    showNotification('Downloading update...', 'info');

    void showUpdateSmartDialog({
        mode: 'progress',
        context: 'download',
        title: `Downloading ${targetVersion}`,
        subtitle: 'Securing and verifying the update package.',
        detail: 'You can keep working while the package downloads in the background.',
        version: targetVersion,
        channel: updateState.channel,
        checkedAt: updateState.lastCheckedAt || new Date().toISOString(),
        notes: updateState.releaseNotes,
        progress: Number.isFinite(updateState.downloadProgress) ? updateState.downloadProgress : 0,
        progressLabel: Number.isFinite(updateState.downloadProgress) && updateState.downloadProgress > 0
            ? `Downloaded ${Math.round(updateState.downloadProgress)}%`
            : 'Preparing download...',
        dismissible: true,
        dismissOnBackdrop: true,
        actions: [
            { label: 'Run in Background', value: 'background', variant: 'secondary', icon: 'fa-window-minimize' }
        ]
    });

    try {
        const result = await ipcRenderer.invoke('download-update');
        updateUpdateState(result?.state || {});
        closeUpdateSmartDialog('download-finished');
        if (!result?.success) {
            const retryDecision = await showUpdateSmartDialog({
                mode: 'danger',
                context: 'download-error',
                title: 'Download Failed',
                subtitle: 'The update package could not be downloaded.',
                detail: toSafeErrorMessage(result?.error || updateState.error, 'Check your connection and try again.'),
                version: targetVersion,
                channel: updateState.channel,
                checkedAt: updateState.lastCheckedAt || new Date().toISOString(),
                actions: [
                    { label: 'Retry Download', value: 'retry', variant: 'primary', icon: 'fa-rotate' },
                    { label: 'Close', value: 'close', variant: 'secondary', icon: 'fa-times' }
                ]
            });
            if (retryDecision === 'retry') {
                await downloadUpdateInteractive();
            }
            return;
        }

        const installDecision = await showUpdateSmartDialog({
            mode: 'success',
            context: 'downloaded',
            title: 'Update Downloaded',
            subtitle: 'The package is ready to install.',
            detail: 'Install now to restart AppManager and complete the update.',
            version: updateState.latestVersion || targetVersion,
            channel: updateState.channel,
            checkedAt: updateState.lastCheckedAt || new Date().toISOString(),
            notes: updateState.releaseNotes,
            actions: [
                { label: 'Install and Restart', value: 'install', variant: 'primary', icon: 'fa-rotate-right' },
                { label: 'Later', value: 'later', variant: 'secondary', icon: 'fa-clock' }
            ]
        });

        if (installDecision === 'install') {
            await installDownloadedUpdateInteractive({ skipConfirmation: true });
        } else {
            showNotification('Update downloaded. Install it from Help > Check for Updates when ready.', 'success');
        }
    } catch (error) {
        closeUpdateSmartDialog('download-error');
        await showUpdateSmartDialog({
            mode: 'danger',
            context: 'download-error',
            title: 'Download Failed',
            subtitle: 'An unexpected error interrupted the download.',
            detail: toSafeErrorMessage(error?.message, 'Please try again.'),
            version: targetVersion,
            channel: updateState.channel,
            checkedAt: new Date().toISOString(),
            actions: [
                { label: 'Close', value: 'close', variant: 'secondary', icon: 'fa-times' }
            ]
        });
    }
}

async function installDownloadedUpdateInteractive(options = {}) {
    const { skipConfirmation = false } = options;

    if (!skipConfirmation) {
        const confirmInstall = await showUpdateSmartDialog({
            mode: 'warning',
            context: 'install-request',
            title: 'Install Update Now?',
            subtitle: 'AppManager will restart to apply the update.',
            detail: 'Save any ongoing work before continuing.',
            version: getUpdateDialogPrimaryVersion(),
            channel: updateState.channel,
            checkedAt: updateState.lastCheckedAt || new Date().toISOString(),
            actions: [
                { label: 'Install and Restart', value: 'install', variant: 'primary', icon: 'fa-rotate-right' },
                { label: 'Cancel', value: 'cancel', variant: 'secondary', icon: 'fa-times' }
            ]
        });

        if (confirmInstall !== 'install') {
            return false;
        }
    }

    void showUpdateSmartDialog({
        mode: 'progress',
        context: 'installing',
        title: 'Installing Update',
        subtitle: 'Restarting AppManager to finish installation.',
        detail: 'The app will close and relaunch automatically.',
        iconHtml: '<i class="fas fa-rotate"></i>',
        version: getUpdateDialogPrimaryVersion(),
        channel: updateState.channel,
        checkedAt: updateState.lastCheckedAt || new Date().toISOString(),
        progress: 100,
        progressLabel: 'Preparing restart...',
        dismissible: false,
        allowEscape: false,
        allowEmptyActions: true,
        actions: []
    });

    try {
        const result = await ipcRenderer.invoke('install-update');
        if (!result?.success) {
            closeUpdateSmartDialog('install-failed');
            await showUpdateSmartDialog({
                mode: 'warning',
                context: 'install-error',
                title: 'Install Not Ready',
                subtitle: 'No downloaded package is currently ready to install.',
                detail: toSafeErrorMessage(result?.error, 'Please download an update first.'),
                version: getUpdateDialogPrimaryVersion(),
                channel: updateState.channel,
                checkedAt: updateState.lastCheckedAt || new Date().toISOString(),
                actions: [
                    { label: 'Close', value: 'close', variant: 'secondary', icon: 'fa-times' }
                ]
            });
            return false;
        }

        showNotification('Installing update and restarting...', 'info');
        return true;
    } catch (error) {
        closeUpdateSmartDialog('install-error');
        await showUpdateSmartDialog({
            mode: 'danger',
            context: 'install-error',
            title: 'Install Failed',
            subtitle: 'The app could not start the installation process.',
            detail: toSafeErrorMessage(error?.message, 'Please try again.'),
            version: getUpdateDialogPrimaryVersion(),
            channel: updateState.channel,
            checkedAt: new Date().toISOString(),
            actions: [
                { label: 'Close', value: 'close', variant: 'secondary', icon: 'fa-times' }
            ]
        });
        return false;
    }
}

function getConfiguredExternalLinks() {
    const normalized = normalizeSettings(appSettings);
    const defaults = getSettingsDefaults();
    return {
        repo: normalized.repoUrl || defaults.repoUrl,
        docs: normalized.docsUrl || defaults.docsUrl,
        issues: normalized.issuesUrl || defaults.issuesUrl,
        license: normalized.licenseUrl || defaults.licenseUrl
    };
}

function openConfiguredExternalLink(linkType, fallbackUrl = '', message = '') {
    const links = getConfiguredExternalLinks();
    const targetUrl = links[linkType] || fallbackUrl;
    if (!targetUrl) {
        showNotification('Link is not configured', 'warning');
        return;
    }

    ipcRenderer.invoke('open-external', targetUrl);
    if (message) {
        showNotification(message, 'info');
    }
}

function getOperationQueueLabel(type) {
    switch (String(type || '').trim()) {
        case 'clone-repository':
            return 'Clone repository';
        case 'export-project':
            return 'Export project';
        case 'github-upload-project':
            return 'Upload to GitHub';
        default:
            return String(type || 'Operation');
    }
}

function toSafeErrorMessage(value, fallback = 'Operation failed') {
    if (typeof value !== 'string') {
        return fallback;
    }
    const trimmed = value.trim();
    return trimmed || fallback;
}

async function loadOperationQueue() {
    try {
        const result = await ipcRenderer.invoke('get-operation-queue');
        if (result?.success && Array.isArray(result.jobs)) {
            operationQueueJobs = result.jobs;
            renderOperationQueue();
        }
    } catch (error) {
        console.warn('Unable to load operation queue:', error);
    }
}

function notifyOperationQueueStateChanges() {
    operationQueueJobs.forEach((job) => {
        if (!job || typeof job.id !== 'string') {
            return;
        }
        const previousStatus = operationQueueStatusMap.get(job.id);
        if (previousStatus === job.status) {
            return;
        }

        operationQueueStatusMap.set(job.id, job.status);
        const jobLabel = getOperationQueueLabel(job.type);
        if (job.status === 'completed') {
            showNotification(`${jobLabel} completed`, 'success');
        } else if (job.status === 'failed') {
            showNotification(`${jobLabel} failed: ${toSafeErrorMessage(job.error, 'Unknown error')}`, 'error');
        } else if (job.status === 'cancelled') {
            showNotification(`${jobLabel} cancelled`, 'warning');
        }

        const followup = operationQueueFollowups.get(job.id);
        if (!followup) {
            return;
        }

        if (job.status === 'completed' && followup.openInVSCodePath) {
            ipcRenderer.invoke('open-in-vscode', followup.openInVSCodePath);
        }

        if (followup.kind === 'github-upload') {
            const terminal = job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled';
            if (job.status === 'completed') {
                const result = job.result && typeof job.result === 'object' ? job.result : {};
                if (result.success) {
                    if (result.mode) {
                        const overlay = document.getElementById('gh-upload-progress');
                        if (overlay) {
                            overlay.dataset.uploadMode = result.mode === 'existing' ? 'existing' : 'new';
                        }
                    }
                    ghUploadProgressComplete(true, result.repo || null);
                    void refreshGitStatus();
                } else {
                    ghUploadProgressComplete(false, null, toSafeErrorMessage(result.error, 'GitHub upload failed'));
                }
            } else if (job.status === 'failed') {
                ghUploadProgressComplete(false, null, toSafeErrorMessage(job.error, 'GitHub upload failed'));
            } else if (job.status === 'cancelled') {
                ghUploadProgressComplete(false, null, 'GitHub upload cancelled');
            }

            if (terminal) {
                githubUploadInProgress = false;
                updateGitHubUploadSubmitState();
            }
        }

        if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
            operationQueueFollowups.delete(job.id);
        }
    });
}

function renderOperationQueue() {
    const list = document.getElementById('operation-queue-list');
    if (!list) {
        return;
    }

    if (!Array.isArray(operationQueueJobs) || operationQueueJobs.length === 0) {
        list.innerHTML = '<div class="settings-ext-empty"><p>No queued operations</p></div>';
        return;
    }

    const fragment = document.createDocumentFragment();
    operationQueueJobs.forEach((job) => {
        const row = document.createElement('div');
        row.className = 'queue-job-item';

        const main = document.createElement('div');
        main.className = 'queue-job-main';

        const title = document.createElement('div');
        title.className = 'queue-job-title';
        title.textContent = getOperationQueueLabel(job.type);

        const meta = document.createElement('div');
        meta.className = 'queue-job-meta';
        meta.textContent = `${String(job.status || 'unknown')} - attempt ${Number(job.attempts || 0)}`;

        main.appendChild(title);
        main.appendChild(meta);

        if (job.error) {
            const errorEl = document.createElement('div');
            errorEl.className = 'queue-job-error';
            errorEl.textContent = toSafeErrorMessage(job.error, '');
            main.appendChild(errorEl);
        }

        const actions = document.createElement('div');
        actions.className = 'queue-job-actions';
        if (job.status === 'queued' || job.status === 'running') {
            const cancelButton = document.createElement('button');
            cancelButton.className = 'btn-secondary';
            cancelButton.textContent = 'Cancel';
            cancelButton.addEventListener('click', async () => {
                await ipcRenderer.invoke('cancel-operation', job.id);
                await loadOperationQueue();
            });
            actions.appendChild(cancelButton);
        }

        if (job.status === 'failed' || job.status === 'cancelled') {
            const retryButton = document.createElement('button');
            retryButton.className = 'btn-secondary';
            retryButton.textContent = 'Retry';
            retryButton.addEventListener('click', async () => {
                if (job.type === 'github-upload-project') {
                    operationQueueFollowups.set(job.id, { kind: 'github-upload' });
                    githubUploadInProgress = true;
                    updateGitHubUploadSubmitState();
                    ghUploadProgressShow();
                }
                await ipcRenderer.invoke('retry-operation', job.id);
                await loadOperationQueue();
            });
            actions.appendChild(retryButton);
        }

        row.appendChild(main);
        row.appendChild(actions);
        fragment.appendChild(row);
    });

    list.innerHTML = '';
    list.appendChild(fragment);
}

async function enqueueOperation(type, payload, followup = null) {
    const result = await ipcRenderer.invoke('enqueue-operation', type, payload);
    if (!result?.success) {
        throw new Error(result?.error || 'Failed to enqueue operation');
    }
    if (followup && result.job?.id) {
        operationQueueFollowups.set(result.job.id, followup);
    }
    await loadOperationQueue();
    return result.job;
}

function deriveRepositoryNameFromUrl(repoUrl) {
    if (typeof repoUrl !== 'string') {
        return '';
    }
    const trimmed = repoUrl.trim();
    if (!trimmed) {
        return '';
    }

    const normalized = trimmed.replace(/\\/g, '/');
    const lastSegment = normalized.split('/').pop() || '';
    const cleaned = lastSegment.replace(/\.git$/i, '').trim();
    if (!cleaned) {
        return '';
    }
    return cleaned.replace(/[<>:\"|?*]/g, '_');
}

function deriveProjectAlphaKey(rawValue = '') {
    const value = String(rawValue || '').trim();
    if (!value) {
        return '#';
    }

    const firstChar = value.charAt(0).toUpperCase();
    return /^[A-Z]$/.test(firstChar) ? firstChar : '#';
}

async function queueProjectExport(project) {
    if (!project?.path) {
        showNotification('Select a project first', 'warning');
        return null;
    }

    const defaultExportDir = workspacePath || dirnamePath(project.path);
    const defaultPath = joinPath(defaultExportDir, `${project.name || 'project'}.zip`);
    const outputPath = await ipcRenderer.invoke('save-dialog', {
        title: 'Export Project As',
        defaultPath,
        filters: [{ name: 'ZIP Archive', extensions: ['zip'] }]
    });

    if (!outputPath) {
        return null;
    }

    const job = await enqueueOperation('export-project', {
        projectPath: project.path,
        outputPath
    });

    showNotification('Project export queued', 'success');
    return job;
}

function markIndexedSearchStale(nextWorkspacePath = '') {
    const normalizedWorkspace = typeof nextWorkspacePath === 'string' ? nextWorkspacePath : '';
    indexedSearchWorkspace = normalizedWorkspace;
    indexedSearchReady = false;
    indexedSearchBuildInFlight = null;
    clearProjectSearchResultsCache();
}

async function ensureIndexedSearchReady() {
    const normalizedWorkspace = workspacePath || '';
    if (indexedSearchReady && indexedSearchWorkspace === normalizedWorkspace) {
        return true;
    }

    if (indexedSearchBuildInFlight) {
        await indexedSearchBuildInFlight;
        return indexedSearchReady && indexedSearchWorkspace === normalizedWorkspace;
    }

    indexedSearchWorkspace = normalizedWorkspace;
    indexedSearchBuildInFlight = (async () => {
        const result = await ipcRenderer.invoke('build-search-index', normalizedWorkspace);
        if (!result?.success) {
            throw new Error(result?.error || 'Failed to build search index');
        }
        indexedSearchReady = true;
    })();

    try {
        await indexedSearchBuildInFlight;
        return true;
    } finally {
        indexedSearchBuildInFlight = null;
    }
}

async function openGlobalSearchResult(item) {
    if (!item || !item.projectPath) {
        return;
    }

    const resultType = String(item.type || 'project');
    if (resultType === 'file' && item.filePath) {
        await ipcRenderer.invoke('open-in-vscode', item.filePath);
        hideModal('search-modal');
        return;
    }

    if (resultType === 'commit') {
        currentProject = {
            ...(currentProject || {}),
            name: basenamePath(item.projectPath),
            path: item.projectPath,
            type: currentProject?.type || 'unknown'
        };
        await switchView('git');
        await refreshGitStatus();
        if (item.hash) {
            showNotification(`Opened repository for commit ${item.hash}`, 'info');
        }
        hideModal('search-modal');
        return;
    }

    if (normalizeSettings(appSettings).openInVSCode) {
        await ipcRenderer.invoke('open-in-vscode', item.projectPath);
    } else {
        await ipcRenderer.invoke('open-in-explorer', item.projectPath);
    }
    hideModal('search-modal');
}

async function openDocumentationView(tabName = 'overview') {
    const previousView = currentView !== 'documentation'
        ? currentView
        : documentationLastView;

    const switched = await switchView('documentation');
    if (!switched) {
        return false;
    }

    if (previousView && previousView !== 'documentation') {
        documentationLastView = previousView;
    }

    const docsSearch = document.getElementById('docs-search');
    if (docsSearch && docsSearch.value) {
        docsSearch.value = '';
        filterDocumentationSections('');
    }

    switchDocumentationTab(tabName);
    updateDocumentationSearchMeta({ query: '', matchCount: 0 });
    return true;
}

function updateDocumentationSearchMeta({ query = '', matchCount = 0 } = {}) {
    const meta = document.getElementById('docs-search-meta');
    if (!meta) {
        return;
    }

    const normalizedQuery = String(query || '').trim();
    const totalSections = documentationSearchIndex.length || document.querySelectorAll('#docs-nav .docs-nav-item').length || 0;
    if (!normalizedQuery) {
        meta.textContent = `${totalSections} sections`;
        return;
    }

    meta.textContent = `${matchCount} match${matchCount === 1 ? '' : 'es'}`;
}

function rebuildDocumentationSearchIndex() {
    const docsNav = document.getElementById('docs-nav');
    const docsContent = document.getElementById('docs-content');
    if (!docsNav || !docsContent) {
        documentationSearchIndex = [];
        return;
    }

    const navItems = Array.from(docsNav.querySelectorAll('.docs-nav-item'));
    documentationSearchIndex = navItems.map((item) => {
        const tab = item.dataset.tab || '';
        const pane = docsContent.querySelector(`.docs-pane[data-pane="${tab}"]`);
        const navText = String(item.textContent || '').toLowerCase();
        const navKeywords = String(item.dataset.keywords || '').toLowerCase();
        const paneText = String(pane?.textContent || '').toLowerCase();
        const paneKeywords = String(pane?.dataset.keywords || '').toLowerCase();
        return {
            tab,
            text: `${navText} ${navKeywords} ${paneKeywords} ${paneText}`.trim()
        };
    }).filter((entry) => Boolean(entry.tab));
}
