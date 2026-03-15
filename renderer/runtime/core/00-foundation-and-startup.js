/* Runtime module: core/00-foundation-and-startup.js */
function decodeLegacyInlineArg(value) {
    if (typeof value !== 'string') {
        return '';
    }
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function createLegacyInlineActionHandler(expression) {
    const rawExpression = typeof expression === 'string' ? expression.trim() : '';
    if (!rawExpression) {
        return null;
    }

    let match = rawExpression.match(/^hideModal\('([^']+)'\)$/);
    if (match) {
        const modalId = match[1];
        return () => hideModal(modalId);
    }

    if (/^initializeGit\(\)$/.test(rawExpression)) {
        return () => { void initializeGit(); };
    }

    if (/^showCreateBranchModal\(\)$/.test(rawExpression)) {
        return () => { void showCreateBranchModal(); };
    }

    if (/^performMerge\(\)$/.test(rawExpression)) {
        return () => { void performMerge(); };
    }

    if (/^addRemote\(\)$/.test(rawExpression)) {
        return () => { void addRemote(); };
    }

    if (/^stageAll\(\)$/.test(rawExpression)) {
        return () => { void stageAll(); };
    }

    if (/^stageSelected\(\)$/.test(rawExpression)) {
        return () => { void stageSelected(); };
    }

    if (/^unstageAll\(\)$/.test(rawExpression)) {
        return () => { void unstageAll(); };
    }

    if (/^unstageSelected\(\)$/.test(rawExpression)) {
        return () => { void unstageSelected(); };
    }

    match = rawExpression.match(/^toggleFolder\('([^']+)'\)$/);
    if (match) {
        const folderId = match[1];
        return () => { void toggleFolder(folderId); };
    }

    match = rawExpression.match(/^installMarketplaceTheme\('([^']+)'\)$/);
    if (match) {
        const themeId = match[1];
        return () => { void installMarketplaceTheme(themeId); };
    }

    match = rawExpression.match(/^deleteTag\(decodeURIComponent\('([^']+)'\)\)$/);
    if (match) {
        const tagName = decodeLegacyInlineArg(match[1]);
        return () => { void deleteTag(tagName); };
    }

    match = rawExpression.match(/^viewFileDiff\(decodeURIComponent\('([^']+)'\)\)$/);
    if (match) {
        const filename = decodeLegacyInlineArg(match[1]);
        return () => { void viewFileDiff(filename); };
    }

    match = rawExpression.match(/^openHunkStageModal\(decodeURIComponent\('([^']+)'\),\s*'([^']+)'\)$/);
    if (match) {
        const filename = decodeLegacyInlineArg(match[1]);
        const mode = match[2];
        return () => { void openHunkStageModal(filename, mode); };
    }

    match = rawExpression.match(/^stageFile\(decodeURIComponent\('([^']+)'\)\)$/);
    if (match) {
        const filename = decodeLegacyInlineArg(match[1]);
        return () => { void stageFile(filename); };
    }

    match = rawExpression.match(/^unstageFile\(decodeURIComponent\('([^']+)'\)\)$/);
    if (match) {
        const filename = decodeLegacyInlineArg(match[1]);
        return () => { void unstageFile(filename); };
    }

    match = rawExpression.match(/^discardFile\(decodeURIComponent\('([^']+)'\)\)$/);
    if (match) {
        const filename = decodeLegacyInlineArg(match[1]);
        return () => { void discardFile(filename); };
    }

    match = rawExpression.match(/^switchBranch\(decodeURIComponent\('([^']+)'\)\)$/);
    if (match) {
        const branchName = decodeLegacyInlineArg(match[1]);
        return () => { void switchBranch(branchName); };
    }

    match = rawExpression.match(/^deleteBranch\(decodeURIComponent\('([^']+)'\)\)$/);
    if (match) {
        const branchName = decodeLegacyInlineArg(match[1]);
        return () => { void deleteBranch(branchName); };
    }

    match = rawExpression.match(/^deleteRemote\(decodeURIComponent\('([^']+)'\)\)$/);
    if (match) {
        const remoteName = decodeLegacyInlineArg(match[1]);
        return () => { void deleteRemote(remoteName); };
    }

    return null;
}

function bindLegacyInlineAction(element) {
    if (!element || typeof element.getAttribute !== 'function' || element.dataset.inlineActionBound === 'true') {
        return;
    }

    const rawOnClick = element.getAttribute('onclick');
    if (!rawOnClick) {
        return;
    }

    const shouldStopPropagation = /event\.stopPropagation\(\)\s*;?/g.test(rawOnClick);
    const expression = rawOnClick.replace(/event\.stopPropagation\(\)\s*;?/g, '').trim();
    const handler = createLegacyInlineActionHandler(expression);

    if (!handler && expression) {
        return;
    }

    element.dataset.inlineActionBound = 'true';
    element.removeAttribute('onclick');
    element.addEventListener('click', (event) => {
        if (shouldStopPropagation) {
            event.stopPropagation();
        }
        if (handler) {
            handler(event);
        }
    });
}

function processLegacyInlineActionNode(node) {
    if (!(node instanceof Element)) {
        return;
    }

    if (node.hasAttribute('onclick')) {
        bindLegacyInlineAction(node);
    }

    node.querySelectorAll('[onclick]').forEach((target) => bindLegacyInlineAction(target));
}

let legacyInlineActionObserver = null;

function initializeLegacyInlineActionBridge() {
    if (legacyInlineActionBridgeInstalled) {
        return;
    }

    legacyInlineActionBridgeInstalled = true;
    processLegacyInlineActionNode(document.body);

    legacyInlineActionObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => processLegacyInlineActionNode(node));
        });
    });

    legacyInlineActionObserver.observe(document.body, { childList: true, subtree: true });

    window.addEventListener('beforeunload', () => {
        if (legacyInlineActionObserver) {
            legacyInlineActionObserver.disconnect();
            legacyInlineActionObserver = null;
        }
    }, { once: true });
}

let appInitializationPromise = null;

async function initializeAppIfNeeded() {
    if (appInitializationPromise) {
        return appInitializationPromise;
    }

    // Do NOT reset the promise on error — re-running initialization would
    // duplicate event listeners and IPC handlers. The catch inside
    // initializeApp() already handles partial failures gracefully.
    appInitializationPromise = (async () => {
        const runtimeBootPromise = window.__APP_MANAGER_RUNTIME_BOOT_PROMISE;
        if (runtimeBootPromise && typeof runtimeBootPromise.then === 'function') {
            await runtimeBootPromise;
        }

        await initializeApp();
    })();

    return appInitializationPromise;
}

// Initialize app
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        void initializeAppIfNeeded();
    }, { once: true });
} else {
    void initializeAppIfNeeded();
}

ipcRenderer.on('app-close-requested', () => {
    void attemptAppClose({ forceQuit: true });
});

ipcRenderer.on('update-status', (_event, state) => {
    updateUpdateState(state);
    syncUpdateSmartDialogWithState();

    if (updateState.error) {
        console.warn('Update status error:', updateState.error);
    }

    const updateDialogContext = getActiveUpdateSmartDialogContext();
    if (updateState.downloaded) {
        if (updateDialogContext !== 'download' && updateDialogContext !== 'downloaded' && updateDialogContext !== 'installing') {
            showNotification('Update ready. Use Help > Check for Updates to install.', 'success');
        }
    } else if (updateState.available && updateState.downloadProgress > 0 && updateState.downloadProgress < 100) {
        const now = Date.now();
        if (now - updateProgressNotificationAt > 5000) {
            updateProgressNotificationAt = now;
            const rounded = Math.round(updateState.downloadProgress);
            if (updateDialogContext !== 'download') {
                showNotification(`Downloading update... ${rounded}%`, 'info');
            }
        }
    }
});

ipcRenderer.on('clone-repository-progress', (_event, payload) => {
    handleCloneProgressEvent(payload);
});

ipcRenderer.on('operation-queue-updated', (_event, jobs) => {
    operationQueueJobs = Array.isArray(jobs) ? jobs : [];
    renderOperationQueue();
    notifyOperationQueueStateChanges();
});

async function initializeApp() {
    try {
        initializeLegacyInlineActionBridge();
        initializeRendererFaultReporting();
        initializeLogViewer();
        initializeTitlebar();
        initializeSidebar();
        initializeMouseViewNavigation();
        initializeModals();
        initializeQuickActions();
        initializeTemplates();
        initializeMenuItems();
        initializeDocumentationView();
        initializeSettings();
        initializeGitView();
        initializeExtensions();
        initializeCommandPalette();
        initializeKeyboardShortcuts();
        initializeAboutDialog();
        initializeReportDialog();
        initializeGitHubAvatarHoverPreview();
        initializeProjectsView();
        initializeRecentView();
        initializeProductRegistration();
        initializePremiumScrollEffects();
        initializeFirstRunWizard();

        // Initialize Git modals
        createMergeModal();
        createHunkModal();
        createConflictAssistantModal();

        await loadSettings();
        await showFirstRunWizardIfNeeded();
        initializeCustomDropdowns();
        await loadAppVersionInfo();
        await loadUpdateState();
        await loadOperationQueue();
        await loadLicenseStatus();
        await loadGitHubToken();
        initializeStatusBar();
        await loadWorkspacePath();
        loadFavoriteProjectsState();
        if (typeof loadProjectArtworkSelectionState === 'function') {
            loadProjectArtworkSelectionState();
        }
        await loadRecentProjects();
        await checkVSCodeInstallation();

        // Load all projects and update stats for initial display
        await loadAllProjects();
        startAllProjectsSmartSync();
        refreshStatusBar();
        void runStartupUpdateCheck();

        showNotification('AppManager Pro initialized', 'success');
    } catch (error) {
        console.error('Initialization error:', error);
        showNotification('Some features may not have loaded correctly', 'warning');
    }
}

function handleAllProjectsWindowFocusRefresh() {
    if (currentView !== 'projects' && currentView !== 'dashboard') {
        return;
    }

    void loadAllProjects({ force: false, showLoading: false });
}

function startAllProjectsSmartSync() {
    if (allProjectsRefreshTimer) {
        clearInterval(allProjectsRefreshTimer);
    }

    allProjectsRefreshTimer = setInterval(() => {
        if (document.hidden || !workspacePath || (currentView !== 'projects' && currentView !== 'dashboard')) {
            return;
        }

        void loadAllProjects({ force: false, showLoading: false });
    }, ALL_PROJECTS_SMART_REFRESH_MS);

    if (!allProjectsFocusRefreshBound) {
        window.addEventListener('focus', handleAllProjectsWindowFocusRefresh);
        window.addEventListener('beforeunload', stopAllProjectsSmartSync);
        allProjectsFocusRefreshBound = true;
    }
}

function stopAllProjectsSmartSync() {
    if (allProjectsRefreshTimer) {
        clearInterval(allProjectsRefreshTimer);
        allProjectsRefreshTimer = null;
    }

    if (allProjectsFocusRefreshBound) {
        window.removeEventListener('focus', handleAllProjectsWindowFocusRefresh);
        window.removeEventListener('beforeunload', stopAllProjectsSmartSync);
        allProjectsFocusRefreshBound = false;
    }
}

function initializeFirstRunWizard() {
    const browseBtn = document.getElementById('first-run-browse-path');
    const skipBtn = document.getElementById('first-run-skip');
    const saveBtn = document.getElementById('first-run-save');
    if (!browseBtn || !skipBtn || !saveBtn) {
        return;
    }

    if (browseBtn.dataset.bound === 'true') {
        return;
    }
    browseBtn.dataset.bound = 'true';

    browseBtn.addEventListener('click', async () => {
        const selectedPath = await ipcRenderer.invoke('select-folder');
        if (selectedPath) {
            const input = document.getElementById('first-run-project-path');
            if (input) {
                input.value = selectedPath;
            }
        }
    });

    skipBtn.addEventListener('click', async () => {
        const nextSettings = normalizeSettings({
            ...appSettings,
            firstRunCompleted: true
        });
        const saved = await ipcRenderer.invoke('save-settings', nextSettings);
        if (saved) {
            appSettings = nextSettings;
        }
        hideModal('first-run-modal');
    });

    saveBtn.addEventListener('click', async () => {
        const projectPath = document.getElementById('first-run-project-path')?.value?.trim() || appSettings.defaultProjectPath || workspacePath;
        const gitUsername = document.getElementById('first-run-git-username')?.value?.trim() || '';
        const gitEmail = document.getElementById('first-run-git-email')?.value?.trim() || '';
        const openInVSCode = Boolean(document.getElementById('first-run-open-vscode')?.checked);

        const candidate = normalizeSettings({
            ...appSettings,
            defaultProjectPath: projectPath,
            gitUsername,
            gitEmail,
            openInVSCode,
            firstRunCompleted: true
        });

        const validation = await validateSettingsPayload(candidate);
        if (validation.errors.length > 0) {
            showNotification(validation.errors[0].message, 'error');
            return;
        }

        const saved = await ipcRenderer.invoke('save-settings', candidate);
        if (!saved) {
            showNotification('Failed to save first-run setup', 'error');
            return;
        }

        appSettings = validation.normalized;
        await applySettingsToForm(appSettings, { resetDirtyState: true });
        hideModal('first-run-modal');
        showNotification('First-run setup saved', 'success');
    });
}

async function showFirstRunWizardIfNeeded() {
    const normalized = normalizeSettings(appSettings);
    if (normalized.firstRunCompleted) {
        return;
    }

    const pathInput = document.getElementById('first-run-project-path');
    const usernameInput = document.getElementById('first-run-git-username');
    const emailInput = document.getElementById('first-run-git-email');
    const openInVsCodeInput = document.getElementById('first-run-open-vscode');

    if (pathInput) {
        pathInput.value = normalized.defaultProjectPath || workspacePath || '';
    }
    if (usernameInput) {
        usernameInput.value = normalized.gitUsername || '';
    }
    if (emailInput) {
        emailInput.value = normalized.gitEmail || '';
    }
    if (openInVsCodeInput) {
        openInVsCodeInput.checked = Boolean(normalized.openInVSCode);
    }

    showModal('first-run-modal');
}

// Titlebar functionality
