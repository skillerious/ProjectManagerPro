const bridge = window.AppBridge;
if (!bridge || !bridge.ipc || !bridge.path || !bridge.fs || !bridge.url || !bridge.process) {
    throw new Error('Secure preload bridge is unavailable. Renderer startup aborted.');
}

const ipcRenderer = bridge.ipc;
const path = bridge.path;
const fs = bridge.fs;
const process = bridge.process;
const pathToFileURL = bridge.url.pathToFileURL;

// State management
let currentView = 'dashboard';
let viewBackHistory = [];
let viewForwardHistory = [];
let suppressViewHistoryRecording = false;
let workspacePath = '';
let recentProjects = [];
let currentProject = null;
let appSettings = {};
let searchResults = [];
let indexedSearchReady = false;
let indexedSearchWorkspace = '';
let indexedSearchBuildInFlight = null;
let gitStatus = null;
let appVersionInfo = {
    version: '1.0.0',
    displayVersion: 'v1.0.0'
};
let updateState = {
    supported: false,
    checking: false,
    available: false,
    downloaded: false,
    downloadProgress: 0,
    channel: 'stable',
    availableChannels: ['stable', 'beta', 'alpha'],
    rollbackSupported: false,
    latestVersion: '',
    error: ''
};
let updateProgressNotificationAt = 0;
let licenseStatus = {
    isProUnlocked: false,
    maskedKey: '',
    registeredAt: null,
    tier: null,
    tierCode: null,
    isLegacy: false,
    fingerprintMatch: null,
    graceExpiresAt: null
};
let registrationCooldownTimer = null;
let statusMessageTimeout = null;
const PRO_LOCKED_VIEWS = new Set(['git', 'extensions', 'recent']);
const FAVORITE_PROJECTS_STORAGE_KEY = 'appmanager.favoriteProjects.v1';
let favoriteProjects = {};
let settingsDirty = false;
let settingsIsApplyingFromModel = false;
let settingsBaselineSnapshot = '';
let settingsDialogResolve = null;
let settingsDialogKeyHandler = null;
let settingsDialogMotionTimer = null;
let isHandlingAppCloseRequest = false;
let documentationLastView = 'dashboard';
let githubUploadCandidates = [];
let githubUploadNodeMap = new Map();
let githubUploadRootNodes = [];
let githubUploadExpandedPaths = new Set();
let githubUploadSearchQuery = '';
let githubUploadSortField = 'name';
let githubUploadSortDirection = 'asc';
let githubUploadActiveProjectPath = '';
let githubUploadUiInitialized = false;
let githubUploadLoadingCandidates = false;
let githubUploadInProgress = false;
let githubUploadLastResultSuccessful = null;
let settingsExtensionsUiInitialized = false;
let settingsExtensionsSearchQuery = '';
let settingsExtensionsFilter = 'all';
let settingsExtensionsSort = 'name-asc';
let operationQueueJobs = [];
const operationQueueStatusMap = new Map();
const operationQueueFollowups = new Map();

const SETTINGS_EXTENSION_UPDATE_INTERVALS = new Set(['hourly', 'daily', 'weekly', 'never']);
const SETTINGS_TERMINAL_APPS = new Set(['cmd', 'powershell', 'wt', 'bash']);
const SETTINGS_UPDATE_CHANNELS = new Set(['stable', 'beta', 'alpha']);
const SETTINGS_FORM_INPUT_SELECTOR = '#settings-view .setting-item input, #settings-view .setting-item select, #settings-view .setting-item textarea';
const SETTINGS_SMART_DIALOG_EXIT_MS = 180;
const VIEW_HISTORY_LIMIT = 60;
const GITHUB_REPO_NAME_MAX_LENGTH = 100;
const GITHUB_REPO_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const GITHUB_UPLOAD_DEFAULT_EXCLUDED_DIRS = new Set([
    '.git',
    '.next',
    '.nuxt',
    '.cache',
    'node_modules',
    'dist',
    'build',
    'out',
    'coverage'
]);
const GITHUB_UPLOAD_AUTO_DESELECT_FILE_SIZE_BYTES = 95 * 1024 * 1024;

// Initialize app
document.addEventListener('DOMContentLoaded', async () => {
    await initializeApp();
});

ipcRenderer.on('app-close-requested', () => {
    void attemptAppClose({ forceQuit: true });
});

ipcRenderer.on('update-status', (_event, state) => {
    updateUpdateState(state);

    if (updateState.error) {
        console.warn('Update status error:', updateState.error);
    }

    if (updateState.downloaded) {
        showNotification('Update ready. Use Help > Check for Updates to install.', 'success');
    } else if (updateState.available && updateState.downloadProgress > 0 && updateState.downloadProgress < 100) {
        const now = Date.now();
        if (now - updateProgressNotificationAt > 5000) {
            updateProgressNotificationAt = now;
            const rounded = Math.round(updateState.downloadProgress);
            showNotification(`Downloading update... ${rounded}%`, 'info');
        }
    }
});

ipcRenderer.on('operation-queue-updated', (_event, jobs) => {
    operationQueueJobs = Array.isArray(jobs) ? jobs : [];
    renderOperationQueue();
    notifyOperationQueueStateChanges();
});

async function initializeApp() {
    try {
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
        initializeProjectsView();
        initializeRecentView();
        initializePremiumDeleteDialog();
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
        await loadRecentProjects();
        await checkVSCodeInstallation();

        // Load all projects and update stats for initial display
        await loadAllProjects();
        refreshStatusBar();

        showNotification('AppManager Pro initialized', 'success');
    } catch (error) {
        console.error('Initialization error:', error);
        showNotification('Some features may not have loaded correctly', 'warning');
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

        const validation = validateSettingsPayload(candidate);
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
function initializeTitlebar() {
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
            showDeleteConfirmation(currentProject);
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
        showModal('git-commit-modal');
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
}

function updateUpdateState(nextState) {
    if (!nextState || typeof nextState !== 'object') {
        return;
    }

    updateState = {
        ...updateState,
        ...nextState
    };
}

async function loadUpdateState() {
    try {
        const state = await ipcRenderer.invoke('get-update-state');
        updateUpdateState(state);
    } catch (error) {
        console.warn('Unable to load update state:', error);
    }
}

async function checkForUpdatesInteractive() {
    if (updateState.downloaded) {
        const shouldInstall = confirm('An update is ready to install. Install and restart now?');
        if (shouldInstall) {
            await installDownloadedUpdateInteractive();
        }
        return;
    }

    showNotification('Checking for updates...', 'info');

    try {
        const configuredChannel = normalizeSettings(appSettings).updateChannel || 'stable';
        if (configuredChannel !== updateState.channel) {
            const channelResult = await ipcRenderer.invoke('set-update-channel', configuredChannel);
            updateUpdateState(channelResult?.state || {});
        }

        const result = await ipcRenderer.invoke('check-for-updates');
        if (!result?.success && result?.error) {
            showNotification(result.error, 'warning');
            updateUpdateState(result.state || {});
            return;
        }

        updateUpdateState(result?.state || {});
        if (updateState.available) {
            const latestVersion = updateState.latestVersion || 'latest release';
            const shouldDownload = confirm(`Update ${latestVersion} is available. Download now?`);
            if (shouldDownload) {
                await downloadUpdateInteractive();
            } else {
                showNotification(`Update ${latestVersion} is available`, 'info');
            }
            return;
        }

        showNotification(`You are using the latest version (${appVersionInfo.displayVersion})`, 'success');
    } catch (error) {
        showNotification(`Update check failed: ${error.message}`, 'error');
    }
}

async function rollbackToStableInteractive() {
    const confirmed = confirm('Switch to stable channel and check for rollback update now?');
    if (!confirmed) {
        return;
    }

    showNotification('Checking stable channel for rollback...', 'info');
    try {
        const result = await ipcRenderer.invoke('rollback-update');
        updateUpdateState(result?.state || {});
        if (!result?.success) {
            showNotification(result?.error || 'Rollback check failed', 'error');
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
            const shouldDownload = confirm(`Stable version ${latestVersion} is available. Download rollback package now?`);
            if (shouldDownload) {
                await downloadUpdateInteractive();
            }
            return;
        }

        showNotification('No rollback update found on stable channel', 'info');
    } catch (error) {
        showNotification(`Rollback check failed: ${error.message}`, 'error');
    }
}

async function downloadUpdateInteractive() {
    showNotification('Downloading update...', 'info');
    try {
        const result = await ipcRenderer.invoke('download-update');
        updateUpdateState(result?.state || {});
        if (!result?.success) {
            showNotification(result?.error || 'Failed to download update', 'error');
            return;
        }
        showNotification('Update downloaded. Restart to install.', 'success');
    } catch (error) {
        showNotification(`Failed to download update: ${error.message}`, 'error');
    }
}

async function installDownloadedUpdateInteractive() {
    try {
        const result = await ipcRenderer.invoke('install-update');
        if (!result?.success) {
            showNotification(result?.error || 'No downloaded update is ready to install', 'warning');
            return;
        }
        showNotification('Installing update and restarting...', 'info');
    } catch (error) {
        showNotification(`Failed to install update: ${error.message}`, 'error');
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

async function queueProjectExport(project) {
    if (!project?.path) {
        showNotification('Select a project first', 'warning');
        return null;
    }

    const defaultExportDir = workspacePath || path.dirname(project.path);
    const defaultPath = path.join(defaultExportDir, `${project.name || 'project'}.zip`);
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
            name: path.basename(item.projectPath),
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
    return true;
}

function initializeDocumentationView() {
    const docsNav = document.getElementById('docs-nav');
    const docsSearch = document.getElementById('docs-search');
    const docsBackBtn = document.getElementById('docs-back-btn');

    docsNav?.setAttribute('role', 'tablist');
    docsNav?.querySelectorAll('.docs-nav-item').forEach((item) => {
        item.setAttribute('role', 'tab');
        item.setAttribute('aria-selected', item.classList.contains('active') ? 'true' : 'false');
        item.setAttribute('tabindex', item.classList.contains('active') ? '0' : '-1');
    });

    document.querySelectorAll('#docs-content .docs-pane').forEach((pane) => {
        pane.setAttribute('role', 'tabpanel');
        pane.setAttribute('aria-hidden', pane.classList.contains('active') ? 'false' : 'true');
    });

    docsBackBtn?.addEventListener('click', async () => {
        const targetView = documentationLastView && documentationLastView !== 'documentation'
            ? documentationLastView
            : 'dashboard';
        await switchView(targetView);
    });

    docsNav?.addEventListener('click', (event) => {
        const navItem = event.target.closest('.docs-nav-item');
        if (!navItem?.dataset.tab || navItem.classList.contains('docs-nav-item-hidden')) {
            return;
        }
        switchDocumentationTab(navItem.dataset.tab, { focusNav: false });
    });

    docsNav?.addEventListener('keydown', (event) => {
        const navItems = Array.from(docsNav.querySelectorAll('.docs-nav-item:not(.docs-nav-item-hidden)'));
        if (navItems.length === 0) {
            return;
        }

        const focusedIndex = navItems.findIndex((item) => item === document.activeElement);
        let nextIndex = -1;

        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
            event.preventDefault();
            nextIndex = focusedIndex >= 0 ? (focusedIndex + 1) % navItems.length : 0;
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
            event.preventDefault();
            nextIndex = focusedIndex >= 0 ? (focusedIndex - 1 + navItems.length) % navItems.length : 0;
        } else if (event.key === 'Home') {
            event.preventDefault();
            nextIndex = 0;
        } else if (event.key === 'End') {
            event.preventDefault();
            nextIndex = navItems.length - 1;
        } else if (event.key === 'Enter' || event.key === ' ') {
            const activeNavItem = event.target.closest('.docs-nav-item');
            if (activeNavItem?.dataset.tab) {
                event.preventDefault();
                switchDocumentationTab(activeNavItem.dataset.tab, { focusNav: false });
            }
        }

        if (nextIndex >= 0) {
            const nextItem = navItems[nextIndex];
            nextItem.focus();
            if (nextItem.dataset.tab) {
                switchDocumentationTab(nextItem.dataset.tab, { focusNav: false });
            }
        }
    });

    docsSearch?.addEventListener('input', (event) => {
        filterDocumentationSections(event.target.value || '');
    });

    docsSearch?.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            docsSearch.value = '';
            filterDocumentationSections('');
        }
    });

    document.querySelectorAll('.docs-jump-card[data-doc-view]').forEach((button) => {
        button.addEventListener('click', async () => {
            const targetView = button.dataset.docView;
            if (!targetView) {
                return;
            }
            await switchView(targetView);
        });
    });

    document.getElementById('docs-open-shortcuts-modal')?.addEventListener('click', () => {
        showModal('shortcuts-modal');
    });

    document.getElementById('docs-open-report-issue')?.addEventListener('click', () => {
        openConfiguredExternalLink('issues', '', 'Opening issue tracker...');
    });

    switchDocumentationTab('overview');
}

function switchDocumentationTab(tabName, options = {}) {
    const { focusNav = false } = options;
    const docsNav = document.getElementById('docs-nav');
    const docsContent = document.getElementById('docs-content');
    if (!docsNav || !docsContent) {
        return;
    }

    const navItems = Array.from(docsNav.querySelectorAll('.docs-nav-item'));
    const panes = Array.from(docsContent.querySelectorAll('.docs-pane'));
    const targetTab = navItems.some((item) => item.dataset.tab === tabName) ? tabName : 'overview';

    navItems.forEach((item) => {
        const isActive = item.dataset.tab === targetTab;
        item.classList.toggle('active', isActive);
        item.setAttribute('aria-selected', isActive ? 'true' : 'false');
        item.setAttribute('tabindex', isActive ? '0' : '-1');
        if (isActive && focusNav) {
            item.focus();
        }
    });

    panes.forEach((pane) => {
        const isActive = pane.dataset.pane === targetTab;
        pane.classList.toggle('active', isActive);
        pane.setAttribute('aria-hidden', isActive ? 'false' : 'true');
    });

    docsContent.classList.remove('docs-content-empty');
    document.getElementById('docs-search-empty')?.classList.remove('show');

    const activeNavItem = docsNav.querySelector(`.docs-nav-item[data-tab="${targetTab}"]`);
    activeNavItem?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
}

function filterDocumentationSections(rawQuery) {
    const docsNav = document.getElementById('docs-nav');
    const docsContent = document.getElementById('docs-content');
    const emptyState = document.getElementById('docs-search-empty');
    if (!docsNav || !docsContent || !emptyState) {
        return;
    }

    const query = String(rawQuery || '').trim().toLowerCase();
    const navItems = Array.from(docsNav.querySelectorAll('.docs-nav-item'));
    const panes = Array.from(docsContent.querySelectorAll('.docs-pane'));

    if (!query) {
        navItems.forEach((item) => item.classList.remove('docs-nav-item-hidden'));
        docsContent.classList.remove('docs-content-empty');
        emptyState.classList.remove('show');
        if (!docsNav.querySelector('.docs-nav-item.active')) {
            switchDocumentationTab('overview', { focusNav: false });
        }
        return;
    }

    const matches = [];

    navItems.forEach((item) => {
        const tab = item.dataset.tab || '';
        const pane = docsContent.querySelector(`.docs-pane[data-pane="${tab}"]`);
        const tabText = item.textContent?.toLowerCase() || '';
        const paneText = pane?.textContent?.toLowerCase() || '';
        const isMatch = tabText.includes(query) || paneText.includes(query);

        item.classList.toggle('docs-nav-item-hidden', !isMatch);
        if (isMatch) {
            matches.push(tab);
        }
    });

    docsContent.classList.toggle('docs-content-empty', matches.length === 0);
    emptyState.classList.toggle('show', matches.length === 0);

    if (matches.length === 0) {
        panes.forEach((pane) => {
            pane.classList.remove('active');
            pane.setAttribute('aria-hidden', 'true');
        });
        navItems.forEach((item) => {
            item.classList.remove('active');
            item.setAttribute('aria-selected', 'false');
            item.setAttribute('tabindex', '-1');
        });
        return;
    }

    const currentActiveTab = docsNav.querySelector('.docs-nav-item.active')?.dataset.tab || '';
    if (!matches.includes(currentActiveTab)) {
        switchDocumentationTab(matches[0], { focusNav: false });
    }
}

function formatRegisteredDateValue(rawDate) {
    if (!rawDate) {
        return '';
    }

    const parsedDate = new Date(rawDate);
    if (Number.isNaN(parsedDate.getTime())) {
        return '';
    }

    return parsedDate.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
}

function updateAboutRegistrationState() {
    const aboutLicensePill = document.getElementById('about-license-pill');
    const aboutLicenseText = document.getElementById('about-license-text');
    const aboutLicenseDetail = document.getElementById('about-license-detail');

    if (!aboutLicensePill || !aboutLicenseText || !aboutLicenseDetail) {
        return;
    }

    const registered = isProUnlocked();
    const aboutLicenseIcon = aboutLicensePill.querySelector('i');

    aboutLicensePill.classList.toggle('registered', registered);
    aboutLicensePill.classList.toggle('unregistered', !registered);

    if (aboutLicenseIcon) {
        aboutLicenseIcon.className = registered ? 'fas fa-check-circle' : 'fas fa-lock';
    }

    if (registered) {
        const tierLabel = licenseStatus.tier
            ? licenseStatus.tier.charAt(0).toUpperCase() + licenseStatus.tier.slice(1)
            : 'Pro';
        aboutLicenseText.textContent = `Registered (${tierLabel})`;
        const details = [];

        if (licenseStatus.maskedKey) {
            details.push(`Key ${licenseStatus.maskedKey}`);
        }

        const registeredDate = formatRegisteredDateValue(licenseStatus.registeredAt);
        if (registeredDate) {
            details.push(`Activated ${registeredDate}`);
        }

        // Grace period warning
        if (licenseStatus.fingerprintMatch === 'grace' && licenseStatus.graceExpiresAt) {
            const expiresDate = new Date(licenseStatus.graceExpiresAt);
            const daysLeft = Math.max(0, Math.ceil((expiresDate - new Date()) / 86400000));
            aboutLicenseDetail.textContent = `Hardware change detected. Grace period: ${daysLeft} day${daysLeft !== 1 ? 's' : ''} remaining. Re-register to continue using Pro.`;
        } else {
            aboutLicenseDetail.textContent = details.length > 0
                ? details.join(' | ')
                : 'Product key stored securely for this device';
        }
    } else {
        aboutLicenseText.textContent = 'Unregistered';
        aboutLicenseDetail.textContent = 'No product key activated. Register to unlock Pro features.';
    }
}

// Show About Dialog
async function showAboutDialog() {
    showModal('about-modal');

    await loadAppVersionInfo();
    updateAboutRegistrationState();

    // Populate version information
    if (process && process.versions) {
        document.getElementById('electron-version').textContent = process.versions.electron || 'N/A';
        document.getElementById('node-version').textContent = process.versions.node || 'N/A';
    }

    // Platform information
    const platform = process.platform || 'unknown';
    const arch = process.arch || 'unknown';
    document.getElementById('platform-info').textContent = `${platform} (${arch})`;

    // Fetch additional system information from main process
    try {
        const systemInfo = await ipcRenderer.invoke('get-system-info');
        if (systemInfo?.platform) {
            document.getElementById('platform-info').textContent = `${systemInfo.platform} (${systemInfo.arch || 'unknown'})`;
        }
    } catch (e) {
        // Non-critical info only
    }
}

// Initialize About dialog buttons
function initializeAboutDialog() {
    document.getElementById('open-github')?.addEventListener('click', () => {
        openConfiguredExternalLink('repo', '', 'Opening repository...');
    });

    document.getElementById('open-docs')?.addEventListener('click', () => {
        openConfiguredExternalLink('docs', '', 'Opening documentation...');
    });

    document.getElementById('open-license')?.addEventListener('click', () => {
        openConfiguredExternalLink('license', '', 'Opening license...');
    });

    document.getElementById('check-updates')?.addEventListener('click', async () => {
        hideModal('about-modal');
        await checkForUpdatesInteractive();
    });

    document.getElementById('rollback-update')?.addEventListener('click', async () => {
        hideModal('about-modal');
        await rollbackToStableInteractive();
    });
}

// Sidebar navigation
function getSidebarItemAriaLabel(item) {
    if (!item) {
        return 'Sidebar action';
    }

    const tooltipTitle = item.querySelector('.tooltip-title')?.textContent?.trim() || item.dataset.view || 'Sidebar action';
    const tooltipDesc = item.querySelector('.tooltip-desc')?.textContent?.trim() || '';
    const tooltipShortcut = item.querySelector('.tooltip-key')?.textContent?.trim() || '';
    const labelParts = [tooltipTitle];

    if (tooltipDesc) {
        labelParts.push(tooltipDesc);
    }

    if (tooltipShortcut) {
        labelParts.push(`Shortcut ${tooltipShortcut}`);
    }

    return labelParts.join('. ');
}

function updateSidebarItemAccessibility(item) {
    if (!item) {
        return;
    }

    item.setAttribute('role', 'button');
    item.setAttribute('tabindex', '0');
    item.setAttribute('aria-label', getSidebarItemAriaLabel(item));
}

function refreshSidebarAccessibilityLabels() {
    document.querySelectorAll('.sidebar-item').forEach((item) => {
        updateSidebarItemAccessibility(item);
    });
}

function initializeSidebar() {
    const sidebarItems = Array.from(document.querySelectorAll('.sidebar-item'));
    
    sidebarItems.forEach((item, index) => {
        updateSidebarItemAccessibility(item);

        item.addEventListener('click', () => {
            const view = item.dataset.view;
            if (view) {
                switchView(view);
            }
        });

        item.addEventListener('keydown', (event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const direction = event.key === 'ArrowDown' ? 1 : -1;
                const nextIndex = (index + direction + sidebarItems.length) % sidebarItems.length;
                sidebarItems[nextIndex]?.focus();
                return;
            }

            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                item.click();
            }
        });
    });

    refreshSidebarAccessibilityLabels();
}

function trimViewHistoryStacks() {
    if (viewBackHistory.length > VIEW_HISTORY_LIMIT) {
        viewBackHistory = viewBackHistory.slice(viewBackHistory.length - VIEW_HISTORY_LIMIT);
    }
    if (viewForwardHistory.length > VIEW_HISTORY_LIMIT) {
        viewForwardHistory = viewForwardHistory.slice(viewForwardHistory.length - VIEW_HISTORY_LIMIT);
    }
}

function recordViewHistoryTransition(fromView, toView) {
    if (suppressViewHistoryRecording) {
        return;
    }
    if (!fromView || !toView || fromView === toView) {
        return;
    }

    if (viewBackHistory[viewBackHistory.length - 1] !== fromView) {
        viewBackHistory.push(fromView);
    }
    viewForwardHistory = [];
    trimViewHistoryStacks();
}

async function navigateViewHistory(direction) {
    const sourceStack = direction === 'back' ? viewBackHistory : viewForwardHistory;
    const destinationStack = direction === 'back' ? viewForwardHistory : viewBackHistory;
    if (!Array.isArray(sourceStack) || sourceStack.length === 0) {
        return false;
    }

    const fromView = currentView;
    const targetView = sourceStack.pop();
    if (!targetView || targetView === fromView) {
        return false;
    }

    suppressViewHistoryRecording = true;
    try {
        const switched = await switchView(targetView);
        if (!switched) {
            sourceStack.push(targetView);
            return false;
        }
    } finally {
        suppressViewHistoryRecording = false;
    }

    if (fromView && destinationStack[destinationStack.length - 1] !== fromView) {
        destinationStack.push(fromView);
    }
    trimViewHistoryStacks();
    return true;
}

function initializeMouseViewNavigation() {
    window.addEventListener('mousedown', (event) => {
        if (event.button !== 3 && event.button !== 4) {
            return;
        }

        event.preventDefault();
        if (event.button === 3) {
            void navigateViewHistory('back');
        } else {
            void navigateViewHistory('forward');
        }
    });
}

// View switching
async function switchView(viewName) {
    if (PRO_LOCKED_VIEWS.has(viewName) && !isProUnlocked()) {
        ensureProAccess(getLockedFeatureLabel(viewName));
        return false;
    }

    if (viewName === currentView) {
        return true;
    }

    if (currentView === 'settings' && viewName !== 'settings') {
        const canLeaveSettings = await handlePendingSettingsBeforeLeave('leave');
        if (!canLeaveSettings) {
            return false;
        }
    }

    if (viewName === 'documentation' && currentView && currentView !== 'documentation') {
        documentationLastView = currentView;
    }

    // Update sidebar
    document.querySelectorAll('.sidebar-item').forEach(item => {
        item.classList.remove('active');
        if (item.dataset.view === viewName) {
            item.classList.add('active');
        }
    });

    // Update content
    document.querySelectorAll('.view').forEach(view => {
        view.classList.remove('active');
    });

    const targetView = document.getElementById(`${viewName}-view`);
    if (!targetView) {
        return false;
    }

    const previousView = currentView;
    targetView.classList.add('active');
    currentView = viewName;
    recordViewHistoryTransition(previousView, viewName);

    // Update status bar with current view name
    updateStatusMessage(getViewLabel(viewName));
    setStatusCurrentView(getViewLabel(viewName));

    // Load view-specific data
    if (viewName === 'projects') {
        loadAllProjects();
    } else if (viewName === 'git') {
        refreshGitStatus();
    } else if (viewName === 'extensions') {
        loadInstalledExtensions();
    } else if (viewName === 'dashboard') {
        loadAllProjects();
    }

    return true;
}

function getViewLabel(viewName) {
    const viewLabels = {
        dashboard: 'Dashboard',
        projects: 'All Projects',
        recent: 'Recent Projects',
        git: 'Git Repository Management',
        settings: 'Settings',
        extensions: 'Extensions',
        templates: 'Templates',
        documentation: 'Documentation'
    };
    return viewLabels[viewName] || viewName;
}

function getLockedFeatureLabel(viewName) {
    const labels = {
        git: 'Git Management',
        extensions: 'Extensions',
        recent: 'History'
    };
    return labels[viewName] || 'This feature';
}

function isProUnlocked() {
    return Boolean(licenseStatus && licenseStatus.isProUnlocked);
}

function applyLicenseStateToUi() {
    const proBadge = document.getElementById('titlebar-pro-badge');
    if (proBadge) {
        proBadge.classList.toggle('hidden', !isProUnlocked());
    }

    const registerProductMenu = document.getElementById('register-product-menu');
    if (registerProductMenu) {
        registerProductMenu.style.display = isProUnlocked() ? 'none' : 'flex';
    }

    const lockedViewSelectors = [
        '.sidebar-item[data-view="git"]',
        '.sidebar-item[data-view="extensions"]',
        '.sidebar-item[data-view="recent"]'
    ];

    lockedViewSelectors.forEach((selector) => {
        const item = document.querySelector(selector);
        if (!item) {
            return;
        }

        item.classList.toggle('locked-feature', !isProUnlocked());

        const tooltipTitle = item.querySelector('.tooltip-title');
        const tooltipDesc = item.querySelector('.tooltip-desc');

        if (tooltipTitle) {
            const baseTitle = tooltipTitle.dataset.baseTitle || tooltipTitle.textContent || '';
            tooltipTitle.dataset.baseTitle = baseTitle;
            tooltipTitle.textContent = isProUnlocked() ? baseTitle : `${baseTitle} Pro`;
        }

        if (tooltipDesc) {
            const baseDescription = tooltipDesc.dataset.baseDescription || tooltipDesc.textContent || '';
            tooltipDesc.dataset.baseDescription = baseDescription;
            tooltipDesc.textContent = isProUnlocked()
                ? baseDescription
                : 'Requires product activation';
        }

        updateSidebarItemAccessibility(item);
    });

    updateRegisterProductModalUi();
    updateAboutRegistrationState();
}

async function loadLicenseStatus() {
    try {
        const status = await ipcRenderer.invoke('get-license-status');
        if (status && typeof status === 'object') {
            licenseStatus = {
                isProUnlocked: Boolean(status.isProUnlocked),
                maskedKey: typeof status.maskedKey === 'string' ? status.maskedKey : '',
                registeredAt: typeof status.registeredAt === 'string' ? status.registeredAt : null,
                tier: typeof status.tier === 'string' ? status.tier : null,
                tierCode: typeof status.tierCode === 'string' ? status.tierCode : null,
                isLegacy: Boolean(status.isLegacy),
                fingerprintMatch: status.fingerprintMatch != null ? status.fingerprintMatch : null,
                graceExpiresAt: typeof status.graceExpiresAt === 'string' ? status.graceExpiresAt : null
            };
        }
    } catch (error) {
        console.warn('Unable to load license status:', error);
    }

    applyLicenseStateToUi();
    return licenseStatus;
}

function clearProductKeyError() {
    const errorEl = document.getElementById('product-key-error');
    if (errorEl) {
        errorEl.textContent = '';
    }
}

function setProductKeyError(message) {
    const errorEl = document.getElementById('product-key-error');
    if (errorEl) {
        errorEl.textContent = message || '';
    }
}

function startRegistrationCooldownTimer(durationMs) {
    const submitBtn = document.getElementById('register-product-submit');
    const input = document.getElementById('product-key-input');
    if (!submitBtn) return;

    submitBtn.disabled = true;
    if (input) input.disabled = true;

    let remaining = Math.ceil(durationMs / 1000);

    function tick() {
        if (remaining <= 0) {
            submitBtn.disabled = false;
            if (input) input.disabled = false;
            submitBtn.innerHTML = '<i class="fas fa-unlock-alt"></i> Activate Pro';
            registrationCooldownTimer = null;
            return;
        }
        submitBtn.innerHTML = `<i class="fas fa-clock"></i> Wait ${remaining}s`;
        remaining--;
        registrationCooldownTimer = setTimeout(tick, 1000);
    }

    if (registrationCooldownTimer) clearTimeout(registrationCooldownTimer);
    tick();
}

function showProUnlockedCelebration() {
    const existing = document.getElementById('pro-celebration');
    if (existing) existing.remove();

    const tierLabel = licenseStatus.tier
        ? licenseStatus.tier.charAt(0).toUpperCase() + licenseStatus.tier.slice(1)
        : 'Pro';

    const overlay = document.createElement('div');
    overlay.id = 'pro-celebration';
    overlay.className = 'pro-celebration';

    // Particle burst
    const particleContainer = document.createElement('div');
    particleContainer.className = 'pro-cel-particles';
    for (let i = 0; i < 40; i++) {
        const p = document.createElement('span');
        p.className = 'pro-cel-particle';
        const angle = (i / 40) * 360;
        const dist = 80 + Math.random() * 160;
        const dx = Math.cos(angle * Math.PI / 180) * dist;
        const dy = Math.sin(angle * Math.PI / 180) * dist;
        const size = 3 + Math.random() * 5;
        const delay = Math.random() * 0.3;
        const hue = 200 + Math.random() * 60;
        p.style.cssText = `--dx:${dx}px;--dy:${dy}px;--size:${size}px;--delay:${delay}s;--hue:${hue};`;
        particleContainer.appendChild(p);
    }

    // Ring burst
    const ring = document.createElement('div');
    ring.className = 'pro-cel-ring';

    // Icon
    const icon = document.createElement('div');
    icon.className = 'pro-cel-icon';
    icon.innerHTML = '<i class="fas fa-shield-alt"></i>';

    // Checkmark
    const check = document.createElement('div');
    check.className = 'pro-cel-check';
    check.innerHTML = '<i class="fas fa-check"></i>';

    // Text
    const text = document.createElement('div');
    text.className = 'pro-cel-text';
    text.innerHTML = `<span class="pro-cel-title">${tierLabel} Unlocked</span><span class="pro-cel-sub">All features are now available</span>`;

    overlay.append(particleContainer, ring, icon, check, text);
    document.body.appendChild(overlay);

    // Trigger animation
    requestAnimationFrame(() => {
        overlay.classList.add('active');
    });

    // Auto-dismiss
    setTimeout(() => {
        overlay.classList.add('leaving');
        setTimeout(() => {
            overlay.remove();
        }, 600);
    }, 2800);

    // Click to dismiss early
    overlay.addEventListener('click', () => {
        overlay.classList.add('leaving');
        setTimeout(() => {
            overlay.remove();
        }, 400);
    });
}

function formatProductKeyFieldValue(value) {
    const digitsOnly = String(value || '').replace(/\D/g, '').slice(0, 16);
    const groups = digitsOnly.match(/.{1,4}/g) || [];
    return groups.join('-');
}

function updateRegisterProductModalUi() {
    const input = document.getElementById('product-key-input');
    const submitBtn = document.getElementById('register-product-submit');
    const statusChip = document.getElementById('license-status-chip');
    const statusChipText = document.getElementById('license-status-chip-text');

    if (statusChip && statusChipText) {
        if (isProUnlocked()) {
            statusChip.style.display = 'inline-flex';
            const tierLabel = licenseStatus.tier
                ? licenseStatus.tier.charAt(0).toUpperCase() + licenseStatus.tier.slice(1)
                : 'Pro';
            statusChipText.textContent = `${tierLabel} – Activated (${licenseStatus.maskedKey || 'Pro'})`;
        } else {
            statusChip.style.display = 'none';
            statusChipText.textContent = '';
        }
    }

    if (input) {
        input.disabled = isProUnlocked();
        input.readOnly = isProUnlocked();
        if (isProUnlocked()) {
            input.value = licenseStatus.maskedKey || '';
        }
    }

    if (submitBtn) {
        submitBtn.disabled = isProUnlocked();
        submitBtn.innerHTML = isProUnlocked()
            ? '<i class="fas fa-check"></i> Activated'
            : '<i class="fas fa-unlock-alt"></i> Activate Pro';
    }
}

function openRegisterProductModal(featureName = '') {
    const description = document.querySelector('#register-product-modal .license-modal-description');
    if (description) {
        description.textContent = featureName
            ? `${featureName} is locked. Enter a valid product key to unlock Pro features.`
            : 'Unlock Pro features including Git management, Extensions, and History views.';
    }

    if (!isProUnlocked()) {
        const input = document.getElementById('product-key-input');
        if (input) {
            input.disabled = false;
            input.readOnly = false;
            input.value = '';
        }
        clearProductKeyError();
    }

    updateRegisterProductModalUi();
    showModal('register-product-modal');
}

function ensureProAccess(featureName = 'This feature') {
    if (isProUnlocked()) {
        return true;
    }

    updateStatusMessage(`${featureName} requires Pro`);
    showNotification(`${featureName} is locked. Register your product key to continue.`, 'warning');
    openRegisterProductModal(featureName);
    return false;
}

async function submitProductRegistration() {
    if (isProUnlocked()) {
        hideModal('register-product-modal');
        return;
    }

    const input = document.getElementById('product-key-input');
    const submitBtn = document.getElementById('register-product-submit');
    const enteredValue = input ? input.value : '';

    if (!enteredValue || !enteredValue.trim()) {
        setProductKeyError('Enter your 16-digit product key.');
        return;
    }

    clearProductKeyError();

    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Validating...';
    }

    try {
        const result = await ipcRenderer.invoke('register-product-key', enteredValue);

        if (!result || !result.success) {
            const errorMsg = result?.error || 'Product key is invalid.';
            setProductKeyError(errorMsg);
            showNotification(errorMsg, 'error');

            if (result?.retryAfterMs && result.retryAfterMs > 0) {
                startRegistrationCooldownTimer(result.retryAfterMs);
            }
            return;
        }

        if (result.status && typeof result.status === 'object') {
            licenseStatus = {
                isProUnlocked: Boolean(result.status.isProUnlocked),
                maskedKey: typeof result.status.maskedKey === 'string' ? result.status.maskedKey : '',
                registeredAt: typeof result.status.registeredAt === 'string' ? result.status.registeredAt : null,
                tier: typeof result.status.tier === 'string' ? result.status.tier : null,
                tierCode: typeof result.status.tierCode === 'string' ? result.status.tierCode : null,
                isLegacy: Boolean(result.status.isLegacy),
                fingerprintMatch: result.status.fingerprintMatch != null ? result.status.fingerprintMatch : null,
                graceExpiresAt: typeof result.status.graceExpiresAt === 'string' ? result.status.graceExpiresAt : null
            };
        } else {
            await loadLicenseStatus();
        }

        applyLicenseStateToUi();
        hideModal('register-product-modal');
        showProUnlockedCelebration();
        updateStatusMessage('Pro mode enabled');
    } catch (error) {
        setProductKeyError(error.message || 'Failed to register product key.');
        showNotification('Unable to register product key', 'error');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
        }
        updateRegisterProductModalUi();
    }
}

function initializeProductRegistration() {
    const input = document.getElementById('product-key-input');
    const submitBtn = document.getElementById('register-product-submit');

    input?.addEventListener('input', (event) => {
        const formatted = formatProductKeyFieldValue(event.target.value);
        event.target.value = formatted;
        clearProductKeyError();
    });

    input?.addEventListener('keydown', async (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            await submitProductRegistration();
        }
    });

    submitBtn?.addEventListener('click', async () => {
        await submitProductRegistration();
    });
}

async function loadAppVersionInfo() {
    try {
        const versionInfo = await ipcRenderer.invoke('get-app-version-info');
        if (versionInfo && typeof versionInfo.version === 'string' && versionInfo.version.trim()) {
            const version = versionInfo.version.trim();
            const displayVersion = typeof versionInfo.displayVersion === 'string' && versionInfo.displayVersion.trim()
                ? versionInfo.displayVersion.trim()
                : `v${version}`;

            appVersionInfo = {
                version,
                displayVersion
            };
        }
    } catch (error) {
        console.warn('Unable to load app version info:', error);
    }

    applyAppVersionDisplays();
}

function applyAppVersionDisplays() {
    const aboutVersionEl = document.getElementById('app-version');
    if (aboutVersionEl) {
        aboutVersionEl.textContent = `Version ${appVersionInfo.displayVersion}`;
    }

    const statusVersionEl = document.getElementById('status-app-version');
    if (statusVersionEl) {
        statusVersionEl.textContent = appVersionInfo.displayVersion;
    }
}

function setStatusCurrentView(viewLabel) {
    const viewEl = document.getElementById('status-current-view');
    if (viewEl) {
        viewEl.textContent = viewLabel || 'Dashboard';
    }
}

function setStatusProjectName(projectName) {
    const projectNameEl = document.getElementById('status-project-name');
    if (projectNameEl) {
        projectNameEl.textContent = projectName || 'No project selected';
    }
}

function setStatusGitBranch(branchName) {
    const branchEl = document.getElementById('status-git-branch');
    if (branchEl) {
        branchEl.textContent = branchName || '--';
    }
}

function setStatusConnectionState(isConnected) {
    const connectionEl = document.getElementById('status-connection');
    const connectionDotEl = document.getElementById('status-connection-dot');

    if (connectionEl) {
        connectionEl.textContent = isConnected ? 'Connected' : 'Disconnected';
    }

    if (connectionDotEl) {
        connectionDotEl.classList.toggle('status-online', isConnected);
        connectionDotEl.classList.toggle('status-offline', !isConnected);
    }
}

function updateStatusProjectCounts(totalProjects, recentCount = recentProjects.length) {
    const totalProjectsEl = document.getElementById('status-project-count');
    const recentCountEl = document.getElementById('status-recent-count');
    const heroRecentEl = document.getElementById('hero-recent');

    if (totalProjectsEl) {
        totalProjectsEl.textContent = String(totalProjects || 0);
    }

    if (recentCountEl) {
        recentCountEl.textContent = String(recentCount || 0);
    }

    if (heroRecentEl) {
        heroRecentEl.textContent = String(recentCount || 0);
    }
}

function initializeStatusBar() {
    setStatusCurrentView(getViewLabel(currentView));
    setStatusProjectName(currentProject ? currentProject.name : null);
    setStatusGitBranch(currentProject ? 'main' : '--');
    setStatusConnectionState(Boolean(githubUserData));
    updateStatusProjectCounts(document.querySelectorAll('#all-projects-list .project-card-modern').length, recentProjects.length);
    applyAppVersionDisplays();
}

function refreshStatusBar() {
    setStatusCurrentView(getViewLabel(currentView));
    setStatusProjectName(currentProject ? currentProject.name : null);
    setStatusConnectionState(Boolean(githubUserData));
    updateStatusProjectCounts(document.querySelectorAll('#all-projects-list .project-card-modern').length, recentProjects.length);
    void refreshStatusBranch();
}

// Settings functionality
/* ────────────────────────────────────────
   Custom Dropdown — replaces native <select>
   ──────────────────────────────────────── */
function clampSettingsNumber(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, parsed));
}

function normalizeThemeSetting(themeValue, fallback = 'dark') {
    if (typeof themeValue !== 'string') {
        return fallback;
    }

    const trimmed = themeValue.trim();
    if (!trimmed) {
        return fallback;
    }

    if (trimmed === 'dark' || trimmed === 'light' || trimmed === 'high-contrast') {
        return trimmed;
    }

    if (
        trimmed.startsWith('ext:') &&
        trimmed.length <= 160 &&
        /^ext:[A-Za-z0-9._-]+$/.test(trimmed)
    ) {
        return trimmed;
    }

    return fallback;
}

function getSettingsDefaults() {
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
        defaultProjectPath: workspacePath || '',
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

function normalizeSettings(settingsInput = {}) {
    const defaults = getSettingsDefaults();
    const source = settingsInput && typeof settingsInput === 'object' && !Array.isArray(settingsInput)
        ? settingsInput
        : {};
    const sourceExtensions = source.extensions && typeof source.extensions === 'object' && !Array.isArray(source.extensions)
        ? source.extensions
        : {};

    const extensionUpdateIntervalCandidate =
        typeof source.extensionUpdateCheck === 'string' && SETTINGS_EXTENSION_UPDATE_INTERVALS.has(source.extensionUpdateCheck)
            ? source.extensionUpdateCheck
            : (typeof sourceExtensions.updateCheckInterval === 'string' && SETTINGS_EXTENSION_UPDATE_INTERVALS.has(sourceExtensions.updateCheckInterval)
                ? sourceExtensions.updateCheckInterval
                : defaults.extensionUpdateCheck);

    const extensionAutoUpdateCandidate =
        typeof source.autoUpdateExtensions === 'boolean'
            ? source.autoUpdateExtensions
            : (typeof sourceExtensions.autoUpdate === 'boolean'
                ? sourceExtensions.autoUpdate
                : defaults.autoUpdateExtensions);

    const normalized = {
        ...defaults,
        theme: normalizeThemeSetting(source.theme, defaults.theme),
        autoSave: typeof source.autoSave === 'boolean' ? source.autoSave : defaults.autoSave,
        openInVSCode: typeof source.openInVSCode === 'boolean' ? source.openInVSCode : defaults.openInVSCode,
        repoUrl: typeof source.repoUrl === 'string' && source.repoUrl.trim() ? source.repoUrl.trim() : defaults.repoUrl,
        docsUrl: typeof source.docsUrl === 'string' && source.docsUrl.trim() ? source.docsUrl.trim() : defaults.docsUrl,
        issuesUrl: typeof source.issuesUrl === 'string' && source.issuesUrl.trim() ? source.issuesUrl.trim() : defaults.issuesUrl,
        licenseUrl: typeof source.licenseUrl === 'string' && source.licenseUrl.trim() ? source.licenseUrl.trim() : defaults.licenseUrl,
        gitIntegration: typeof source.gitIntegration === 'boolean' ? source.gitIntegration : defaults.gitIntegration,
        firstRunCompleted: typeof source.firstRunCompleted === 'boolean' ? source.firstRunCompleted : defaults.firstRunCompleted,
        defaultProjectPath: typeof source.defaultProjectPath === 'string'
            ? source.defaultProjectPath.trim()
            : defaults.defaultProjectPath,
        fontSize: clampSettingsNumber(source.fontSize, 10, 20, defaults.fontSize),
        autoUpdate: typeof source.autoUpdate === 'boolean' ? source.autoUpdate : defaults.autoUpdate,
        updateChannel: typeof source.updateChannel === 'string' && SETTINGS_UPDATE_CHANNELS.has(source.updateChannel.trim().toLowerCase())
            ? source.updateChannel.trim().toLowerCase()
            : defaults.updateChannel,
        terminalApp: typeof source.terminalApp === 'string' && SETTINGS_TERMINAL_APPS.has(source.terminalApp)
            ? source.terminalApp
            : defaults.terminalApp,
        showWelcome: typeof source.showWelcome === 'boolean' ? source.showWelcome : defaults.showWelcome,
        closeToTray: typeof source.closeToTray === 'boolean' ? source.closeToTray : defaults.closeToTray,
        autoRefreshInterval: clampSettingsNumber(source.autoRefreshInterval, 500, 60000, defaults.autoRefreshInterval),
        enableFileWatcher: typeof source.enableFileWatcher === 'boolean' ? source.enableFileWatcher : defaults.enableFileWatcher,
        recentProjectsLimit: clampSettingsNumber(source.recentProjectsLimit, 5, 50, defaults.recentProjectsLimit),
        confirmDelete: typeof source.confirmDelete === 'boolean' ? source.confirmDelete : defaults.confirmDelete,
        accentColor: typeof source.accentColor === 'string' && /^#[0-9A-Fa-f]{6}$/.test(source.accentColor)
            ? source.accentColor
            : defaults.accentColor,
        fontFamily: typeof source.fontFamily === 'string' && source.fontFamily.trim()
            ? source.fontFamily.trim()
            : defaults.fontFamily,
        uiScale: clampSettingsNumber(source.uiScale, 80, 150, defaults.uiScale),
        smoothScrolling: typeof source.smoothScrolling === 'boolean' ? source.smoothScrolling : defaults.smoothScrolling,
        animationsEnabled: typeof source.animationsEnabled === 'boolean' ? source.animationsEnabled : defaults.animationsEnabled,
        editorPath: typeof source.editorPath === 'string' ? source.editorPath.trim() : defaults.editorPath,
        editorArgs: typeof source.editorArgs === 'string' ? source.editorArgs.trim() : defaults.editorArgs,
        openReadme: typeof source.openReadme === 'boolean' ? source.openReadme : defaults.openReadme,
        createGitignore: typeof source.createGitignore === 'boolean' ? source.createGitignore : defaults.createGitignore,
        terminalPath: typeof source.terminalPath === 'string' ? source.terminalPath.trim() : defaults.terminalPath,
        terminalCwd: typeof source.terminalCwd === 'boolean' ? source.terminalCwd : defaults.terminalCwd,
        terminalAdmin: typeof source.terminalAdmin === 'boolean' ? source.terminalAdmin : defaults.terminalAdmin,
        gitPath: typeof source.gitPath === 'string' ? source.gitPath.trim() : defaults.gitPath,
        gitUsername: typeof source.gitUsername === 'string' ? source.gitUsername.trim() : defaults.gitUsername,
        gitEmail: typeof source.gitEmail === 'string' ? source.gitEmail.trim() : defaults.gitEmail,
        gitAutoInit: typeof source.gitAutoInit === 'boolean' ? source.gitAutoInit : defaults.gitAutoInit,
        gitAutoFetch: typeof source.gitAutoFetch === 'boolean' ? source.gitAutoFetch : defaults.gitAutoFetch,
        defaultBranch: typeof source.defaultBranch === 'string' && source.defaultBranch.trim()
            ? source.defaultBranch.trim()
            : defaults.defaultBranch,
        autoUpdateExtensions: extensionAutoUpdateCandidate,
        extensionRecommendations: typeof source.extensionRecommendations === 'boolean'
            ? source.extensionRecommendations
            : defaults.extensionRecommendations,
        extensionUpdateCheck: extensionUpdateIntervalCandidate,
        maxWorkers: clampSettingsNumber(source.maxWorkers, 1, 16, defaults.maxWorkers),
        hardwareAcceleration: typeof source.hardwareAcceleration === 'boolean'
            ? source.hardwareAcceleration
            : defaults.hardwareAcceleration,
        cacheSize: clampSettingsNumber(source.cacheSize, 50, 1000, defaults.cacheSize),
        devTools: typeof source.devTools === 'boolean' ? source.devTools : defaults.devTools,
        verboseLogging: typeof source.verboseLogging === 'boolean' ? source.verboseLogging : defaults.verboseLogging
    };

    normalized.extensions = {
        enabled: Array.isArray(sourceExtensions.enabled)
            ? sourceExtensions.enabled.filter((id) => typeof id === 'string')
            : defaults.extensions.enabled,
        disabled: Array.isArray(sourceExtensions.disabled)
            ? sourceExtensions.disabled.filter((id) => typeof id === 'string')
            : defaults.extensions.disabled,
        autoUpdate: extensionAutoUpdateCandidate,
        updateCheckInterval: extensionUpdateIntervalCandidate,
        settings: sourceExtensions.settings && typeof sourceExtensions.settings === 'object' && !Array.isArray(sourceExtensions.settings)
            ? sourceExtensions.settings
            : defaults.extensions.settings
    };

    return normalized;
}

function getSettingInputValue(id) {
    const input = document.getElementById(id);
    if (!input) {
        return null;
    }

    if (input.type === 'checkbox') {
        return Boolean(input.checked);
    }

    return input.value;
}

function collectSettingsFromUi() {
    const base = normalizeSettings(appSettings);
    const settings = normalizeSettings({
        ...base,
        defaultProjectPath: getSettingInputValue('default-project-path'),
        recentProjectsLimit: getSettingInputValue('recent-projects-limit'),
        autoSave: getSettingInputValue('auto-save'),
        openInVSCode: getSettingInputValue('open-in-vscode'),
        repoUrl: getSettingInputValue('repo-url'),
        docsUrl: getSettingInputValue('docs-url'),
        issuesUrl: getSettingInputValue('issues-url'),
        licenseUrl: getSettingInputValue('license-url'),
        showWelcome: getSettingInputValue('show-welcome'),
        closeToTray: getSettingInputValue('close-to-tray'),
        confirmDelete: getSettingInputValue('confirm-delete'),
        theme: getSettingInputValue('theme-select'),
        accentColor: getSettingInputValue('accent-color'),
        fontFamily: getSettingInputValue('font-family'),
        fontSize: getSettingInputValue('font-size'),
        autoUpdate: getSettingInputValue('auto-update'),
        updateChannel: getSettingInputValue('update-channel'),
        uiScale: getSettingInputValue('ui-scale'),
        smoothScrolling: getSettingInputValue('smooth-scrolling'),
        animationsEnabled: getSettingInputValue('animations-enabled'),
        editorPath: getSettingInputValue('editor-path'),
        editorArgs: getSettingInputValue('editor-args'),
        openReadme: getSettingInputValue('open-readme'),
        createGitignore: getSettingInputValue('create-gitignore'),
        terminalApp: getSettingInputValue('terminal-app'),
        terminalPath: getSettingInputValue('terminal-path'),
        terminalCwd: getSettingInputValue('terminal-cwd'),
        terminalAdmin: getSettingInputValue('terminal-admin'),
        gitPath: getSettingInputValue('git-path'),
        gitUsername: getSettingInputValue('git-username'),
        gitEmail: getSettingInputValue('git-email'),
        gitAutoInit: getSettingInputValue('git-auto-init'),
        gitAutoFetch: getSettingInputValue('git-auto-fetch'),
        defaultBranch: getSettingInputValue('default-branch'),
        autoUpdateExtensions: getSettingInputValue('auto-update-extensions'),
        extensionRecommendations: getSettingInputValue('extension-recommendations'),
        extensionUpdateCheck: getSettingInputValue('extension-update-check'),
        maxWorkers: getSettingInputValue('max-workers'),
        hardwareAcceleration: getSettingInputValue('hardware-acceleration'),
        cacheSize: getSettingInputValue('cache-size'),
        devTools: getSettingInputValue('dev-tools'),
        verboseLogging: getSettingInputValue('verbose-logging'),
        extensions: {
            ...(base.extensions || {}),
            autoUpdate: Boolean(getSettingInputValue('auto-update-extensions')),
            updateCheckInterval: String(getSettingInputValue('extension-update-check') || base.extensionUpdateCheck || 'daily')
        }
    });

    return settings;
}

function createSettingsSnapshot(settings) {
    return JSON.stringify(normalizeSettings(settings));
}

function updateSaveSettingsButtonState() {
    const saveBtn = document.getElementById('save-settings-btn');
    if (!saveBtn) {
        return;
    }

    const isSaving = saveBtn.classList.contains('saving');
    saveBtn.classList.toggle('has-unsaved', settingsDirty);
    saveBtn.disabled = isSaving || !settingsDirty;
}

function setSettingsDirtyState(nextDirtyState) {
    settingsDirty = Boolean(nextDirtyState);
    const settingsView = document.getElementById('settings-view');
    if (settingsView) {
        settingsView.classList.toggle('has-unsaved-settings', settingsDirty);
    }
    updateSaveSettingsButtonState();
}

function setSettingsBaseline(settings) {
    settingsBaselineSnapshot = createSettingsSnapshot(settings);
    setSettingsDirtyState(false);
}

function refreshSettingsDirtyState() {
    if (settingsIsApplyingFromModel) {
        return;
    }
    const currentSnapshot = createSettingsSnapshot(collectSettingsFromUi());
    setSettingsDirtyState(currentSnapshot !== settingsBaselineSnapshot);
}

function applyScrollBehaviorSetting(enabled) {
    document.documentElement.style.scrollBehavior = enabled ? 'smooth' : 'auto';
}

function applyAnimationSetting(enabled) {
    document.body.classList.toggle('no-animations', !enabled);
}

function applyAccentColorSetting(value) {
    const fallback = getSettingsDefaults().accentColor;
    const safeValue = /^#[0-9A-Fa-f]{6}$/.test(value) ? value : fallback;
    document.documentElement.style.setProperty('--accent-primary', safeValue);
}

function applyFontFamilySetting(value) {
    if (!value || value === 'system') {
        document.body.style.fontFamily = '';
        return;
    }
    document.body.style.fontFamily = value;
}

function applyFontSizeSetting(value) {
    const safeFontSize = clampSettingsNumber(value, 10, 20, getSettingsDefaults().fontSize);
    const fontSizeInput = document.getElementById('font-size');
    const fontSizeValue = document.getElementById('font-size-value');
    if (fontSizeInput) {
        fontSizeInput.value = String(safeFontSize);
    }
    if (fontSizeValue) {
        fontSizeValue.textContent = `${safeFontSize}px`;
    }
    document.documentElement.style.setProperty('font-size', `${safeFontSize}px`);
}

function applyUiScaleSetting(value) {
    const safeUiScale = clampSettingsNumber(value, 80, 150, getSettingsDefaults().uiScale);
    const uiScaleInput = document.getElementById('ui-scale');
    const uiScaleValue = document.getElementById('ui-scale-value');
    if (uiScaleInput) {
        uiScaleInput.value = String(safeUiScale);
    }
    if (uiScaleValue) {
        uiScaleValue.textContent = `${safeUiScale}%`;
    }
    document.body.style.zoom = `${safeUiScale}%`;
}

async function applySettingsToRuntime(settings) {
    const normalized = normalizeSettings(settings);
    await applyTheme(normalized.theme);
    applyAccentColorSetting(normalized.accentColor);
    applyFontFamilySetting(normalized.fontFamily);
    applyFontSizeSetting(normalized.fontSize);
    applyUiScaleSetting(normalized.uiScale);
    applyScrollBehaviorSetting(normalized.smoothScrolling);
    applyAnimationSetting(normalized.animationsEnabled);
}

async function applySettingsToForm(settings, options = {}) {
    const { resetDirtyState = false } = options;
    let normalized = normalizeSettings(settings);
    settingsIsApplyingFromModel = true;

    try {
        const setValue = (id, value) => {
            const input = document.getElementById(id);
            if (!input) return;
            input.value = value;
        };

        const setChecked = (id, checked) => {
            const input = document.getElementById(id);
            if (input) {
                input.checked = Boolean(checked);
            }
        };

        setValue('default-project-path', normalized.defaultProjectPath || '');
        setValue('recent-projects-limit', String(normalized.recentProjectsLimit));
        setChecked('auto-save', normalized.autoSave);
        setChecked('open-in-vscode', normalized.openInVSCode);
        setValue('repo-url', normalized.repoUrl);
        setValue('docs-url', normalized.docsUrl);
        setValue('issues-url', normalized.issuesUrl);
        setValue('license-url', normalized.licenseUrl);
        setChecked('show-welcome', normalized.showWelcome);
        setChecked('close-to-tray', normalized.closeToTray);
        setChecked('confirm-delete', normalized.confirmDelete);

        setValue('theme-select', normalized.theme);
        const themeSelect = document.getElementById('theme-select');
        if (themeSelect && themeSelect.value !== normalized.theme) {
            themeSelect.value = getSettingsDefaults().theme;
            normalized = {
                ...normalized,
                theme: themeSelect.value || getSettingsDefaults().theme
            };
        }
        setValue('accent-color', normalized.accentColor);
        setValue('font-family', normalized.fontFamily);
        setValue('font-size', String(normalized.fontSize));
        setChecked('auto-update', normalized.autoUpdate);
        setValue('update-channel', normalized.updateChannel);
        setValue('ui-scale', String(normalized.uiScale));
        setChecked('smooth-scrolling', normalized.smoothScrolling);
        setChecked('animations-enabled', normalized.animationsEnabled);

        setValue('editor-path', normalized.editorPath);
        setValue('editor-args', normalized.editorArgs);
        setChecked('open-readme', normalized.openReadme);
        setChecked('create-gitignore', normalized.createGitignore);

        setValue('terminal-app', normalized.terminalApp);
        setValue('terminal-path', normalized.terminalPath);
        setChecked('terminal-cwd', normalized.terminalCwd);
        setChecked('terminal-admin', normalized.terminalAdmin);

        setValue('git-path', normalized.gitPath);
        setValue('git-username', normalized.gitUsername);
        setValue('git-email', normalized.gitEmail);
        setChecked('git-auto-init', normalized.gitAutoInit);
        setChecked('git-auto-fetch', normalized.gitAutoFetch);
        setValue('default-branch', normalized.defaultBranch);

        setChecked('auto-update-extensions', normalized.autoUpdateExtensions);
        setChecked('extension-recommendations', normalized.extensionRecommendations);
        setValue('extension-update-check', normalized.extensionUpdateCheck);

        setValue('max-workers', String(normalized.maxWorkers));
        setChecked('hardware-acceleration', normalized.hardwareAcceleration);
        setValue('cache-size', String(normalized.cacheSize));
        setChecked('dev-tools', normalized.devTools);
        setChecked('verbose-logging', normalized.verboseLogging);

        ['recent-projects-limit', 'max-workers', 'cache-size'].forEach((id) => {
            document.getElementById(id)?.dispatchEvent(new Event('input', { bubbles: true }));
        });

        await applySettingsToRuntime(normalized);
        refreshCustomDropdowns();
    } finally {
        settingsIsApplyingFromModel = false;
    }

    if (resetDirtyState) {
        setSettingsBaseline(normalized);
    } else {
        refreshSettingsDirtyState();
    }
}

function clearSettingsValidationErrors() {
    document.querySelectorAll('.setting-item').forEach((item) => {
        item.classList.remove('has-error', 'has-success');
        const errorMsg = item.querySelector('.setting-error-message');
        if (errorMsg) {
            errorMsg.remove();
        }
    });
}

function addSettingValidationError(inputId, message) {
    const input = document.getElementById(inputId);
    const settingItem = input?.closest('.setting-item');
    if (!settingItem) {
        return;
    }

    settingItem.classList.add('has-error');
    const errorMsg = document.createElement('div');
    errorMsg.className = 'setting-error-message';
    errorMsg.innerHTML = `<i class="fas fa-exclamation-circle"></i> ${escapeHtml(message)}`;
    settingItem.appendChild(errorMsg);
}

function isAbsolutePathOrEmpty(value) {
    if (!value) {
        return true;
    }
    return path.isAbsolute(value);
}

function validateSettingsPayload(settings) {
    const normalized = normalizeSettings(settings);
    const errors = [];
    const warnings = [];

    if (!normalized.defaultProjectPath) {
        errors.push({ inputId: 'default-project-path', message: 'Project location is required' });
    } else if (!isAbsolutePathOrEmpty(normalized.defaultProjectPath)) {
        errors.push({ inputId: 'default-project-path', message: 'Use an absolute path' });
    } else if (!fs.existsSync(normalized.defaultProjectPath)) {
        warnings.push('Default project folder does not exist yet and will be created when needed.');
    }

    if (normalized.gitEmail) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(normalized.gitEmail)) {
            errors.push({ inputId: 'git-email', message: 'Invalid email format' });
        }
    }

    if (!/^[A-Za-z0-9._/-]+$/.test(normalized.defaultBranch) || normalized.defaultBranch.includes('..')) {
        errors.push({ inputId: 'default-branch', message: 'Use a valid Git branch name' });
    }

    if (!SETTINGS_TERMINAL_APPS.has(normalized.terminalApp)) {
        errors.push({ inputId: 'terminal-app', message: 'Unsupported terminal option' });
    }

    if (!SETTINGS_EXTENSION_UPDATE_INTERVALS.has(normalized.extensionUpdateCheck)) {
        errors.push({ inputId: 'extension-update-check', message: 'Unsupported update interval' });
    }

    if (!SETTINGS_UPDATE_CHANNELS.has(normalized.updateChannel)) {
        errors.push({ inputId: 'update-channel', message: 'Unsupported update channel' });
    }

    [
        { key: 'repoUrl', label: 'Repository URL' },
        { key: 'docsUrl', label: 'Documentation URL' },
        { key: 'issuesUrl', label: 'Issue tracker URL' },
        { key: 'licenseUrl', label: 'License URL' }
    ].forEach(({ key, label }) => {
        const value = normalized[key];
        if (!value) {
            return;
        }
        try {
            const parsed = new URL(value);
            if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
                warnings.push(`${label} is not a valid web URL.`);
            }
        } catch {
            warnings.push(`${label} is not a valid web URL.`);
        }
    });

    [
        { id: 'editor-path', label: 'Editor path', value: normalized.editorPath },
        { id: 'terminal-path', label: 'Terminal path', value: normalized.terminalPath },
        { id: 'git-path', label: 'Git path', value: normalized.gitPath }
    ].forEach(({ id, label, value }) => {
        if (!value) return;
        if (!path.isAbsolute(value)) {
            errors.push({ inputId: id, message: `${label} must be an absolute path` });
            return;
        }
        if (!fs.existsSync(value)) {
            warnings.push(`${label} does not exist on this machine.`);
        }
    });

    return { normalized, errors, warnings };
}

function countChangedSettings(previous, next) {
    const tracked = [
        'defaultProjectPath',
        'recentProjectsLimit',
        'autoSave',
        'openInVSCode',
        'repoUrl',
        'docsUrl',
        'issuesUrl',
        'licenseUrl',
        'firstRunCompleted',
        'showWelcome',
        'closeToTray',
        'confirmDelete',
        'theme',
        'accentColor',
        'fontFamily',
        'fontSize',
        'autoUpdate',
        'updateChannel',
        'uiScale',
        'smoothScrolling',
        'animationsEnabled',
        'editorPath',
        'editorArgs',
        'openReadme',
        'createGitignore',
        'terminalApp',
        'terminalPath',
        'terminalCwd',
        'terminalAdmin',
        'gitPath',
        'gitUsername',
        'gitEmail',
        'gitAutoInit',
        'gitAutoFetch',
        'defaultBranch',
        'autoUpdateExtensions',
        'extensionRecommendations',
        'extensionUpdateCheck',
        'maxWorkers',
        'hardwareAcceleration',
        'cacheSize',
        'devTools',
        'verboseLogging'
    ];

    const left = normalizeSettings(previous);
    const right = normalizeSettings(next);
    let count = 0;
    tracked.forEach((key) => {
        if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) {
            count += 1;
        }
    });
    return count;
}

function getRecentProjectsLimitSetting() {
    const normalized = normalizeSettings(appSettings);
    return clampSettingsNumber(normalized.recentProjectsLimit, 5, 50, 10);
}

async function enforceRecentProjectsLimit() {
    const limit = getRecentProjectsLimitSetting();
    if (!Array.isArray(recentProjects) || recentProjects.length <= limit) {
        return;
    }

    recentProjects = recentProjects.slice(0, limit);
    await ipcRenderer.invoke('save-recent-projects', recentProjects);
    displayRecentProjects();
    updateStatusProjectCounts(document.querySelectorAll('#all-projects-list .project-card-modern').length, recentProjects.length);
}

function resolveTerminalLaunchPath(preferredPath = '') {
    const normalized = normalizeSettings(appSettings);
    if (normalized.terminalCwd && preferredPath) {
        return preferredPath;
    }
    if (workspacePath) {
        return workspacePath;
    }
    return preferredPath || normalized.defaultProjectPath || '';
}

function registerSettingsDirtyTracking() {
    document.querySelectorAll(SETTINGS_FORM_INPUT_SELECTOR).forEach((input) => {
        if (input.dataset.settingsTracked === 'true') {
            return;
        }

        input.dataset.settingsTracked = 'true';
        const handler = async () => {
            if (settingsIsApplyingFromModel) {
                return;
            }

            if (input.id === 'theme-select') {
                await applyTheme(input.value);
                renderSettingsExtensionsList();
            } else if (input.id === 'accent-color') {
                applyAccentColorSetting(input.value);
            } else if (input.id === 'font-family') {
                applyFontFamilySetting(input.value);
            } else if (input.id === 'font-size') {
                applyFontSizeSetting(input.value);
            } else if (input.id === 'ui-scale') {
                applyUiScaleSetting(input.value);
            } else if (input.id === 'smooth-scrolling') {
                applyScrollBehaviorSetting(Boolean(input.checked));
            } else if (input.id === 'animations-enabled') {
                applyAnimationSetting(Boolean(input.checked));
            }

            refreshSettingsDirtyState();
        };

        input.addEventListener('input', () => {
            void handler();
        });
        input.addEventListener('change', () => {
            void handler();
        });
    });
}

function closeSettingsSmartDialog(result) {
    const overlay = document.getElementById('settings-smart-overlay');
    if (!overlay || typeof settingsDialogResolve !== 'function') {
        return;
    }

    const resolve = settingsDialogResolve;
    settingsDialogResolve = null;

    if (settingsDialogKeyHandler) {
        document.removeEventListener('keydown', settingsDialogKeyHandler, true);
        settingsDialogKeyHandler = null;
    }

    if (settingsDialogMotionTimer) {
        clearTimeout(settingsDialogMotionTimer);
        settingsDialogMotionTimer = null;
    }

    overlay.classList.remove('settings-smart-entering');
    overlay.classList.add('settings-smart-closing');
    overlay.setAttribute('aria-hidden', 'true');

    settingsDialogMotionTimer = setTimeout(() => {
        overlay.classList.remove('active', 'mode-success', 'mode-warning', 'settings-smart-closing', 'settings-smart-entering');
        settingsDialogMotionTimer = null;
    }, SETTINGS_SMART_DIALOG_EXIT_MS);

    resolve(result);
}

function showSettingsSmartDialog(options) {
    const overlay = document.getElementById('settings-smart-overlay');
    const titleEl = document.getElementById('settings-smart-title');
    const subtitleEl = document.getElementById('settings-smart-subtitle');
    const detailEl = document.getElementById('settings-smart-detail');
    const iconEl = document.getElementById('settings-smart-icon');
    const actionsEl = document.getElementById('settings-smart-actions');

    if (!overlay || !titleEl || !subtitleEl || !detailEl || !iconEl || !actionsEl) {
        return Promise.resolve('cancel');
    }

    if (typeof settingsDialogResolve === 'function') {
        closeSettingsSmartDialog('cancel');
    }

    const mode = options.mode === 'warning' ? 'mode-warning' : 'mode-success';
    if (settingsDialogMotionTimer) {
        clearTimeout(settingsDialogMotionTimer);
        settingsDialogMotionTimer = null;
    }

    overlay.classList.remove('active', 'mode-success', 'mode-warning', 'settings-smart-closing', 'settings-smart-entering');
    overlay.classList.add(mode);
    overlay.setAttribute('aria-hidden', 'false');

    titleEl.textContent = options.title || '';
    subtitleEl.textContent = options.subtitle || '';
    detailEl.textContent = options.detail || '';
    iconEl.innerHTML = options.iconHtml || '<i class="fas fa-check"></i>';
    actionsEl.innerHTML = '';

    (options.actions || []).forEach((action) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `settings-smart-btn ${action.variant || 'secondary'}`;
        button.style.setProperty('--settings-smart-btn-index', String(actionsEl.children.length));
        button.innerHTML = action.icon
            ? `<i class="fas ${action.icon}"></i> ${escapeHtml(action.label)}`
            : escapeHtml(action.label);
        button.addEventListener('click', () => closeSettingsSmartDialog(action.value));
        actionsEl.appendChild(button);
    });

    // Force a reflow so staged motion reliably replays every time the dialog opens.
    void overlay.offsetWidth;
    overlay.classList.add('active');
    requestAnimationFrame(() => {
        overlay.classList.add('settings-smart-entering');
        const firstAction = actionsEl.querySelector('.settings-smart-btn');
        firstAction?.focus({ preventScroll: true });
    });

    return new Promise((resolve) => {
        settingsDialogResolve = resolve;
        settingsDialogKeyHandler = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                const cancelAction = (options.actions || []).find((action) => action.value === 'cancel')
                    || (options.actions || [])[0];
                closeSettingsSmartDialog(cancelAction ? cancelAction.value : 'cancel');
            }
        };
        document.addEventListener('keydown', settingsDialogKeyHandler, true);
    });
}

async function showSettingsSavedDialog(changedCount, warnings = []) {
    const detail = warnings.length > 0
        ? `${changedCount} ${changedCount === 1 ? 'setting' : 'settings'} saved. ${warnings[0]}`
        : `${changedCount} ${changedCount === 1 ? 'setting' : 'settings'} saved and now persistent.`;

    await showSettingsSmartDialog({
        mode: 'success',
        title: 'Settings Saved',
        subtitle: 'All changes have been committed successfully.',
        detail,
        iconHtml: '<i class="fas fa-check"></i>',
        actions: [
            { label: 'Done', value: 'done', variant: 'primary', icon: 'fa-check' }
        ]
    });
}

async function requestUnsavedSettingsDecision(context = 'leave') {
    if (!settingsDirty) {
        return 'discard';
    }

    const subtitle = context === 'close'
        ? 'You have unsaved changes. Save before closing AppManager?'
        : 'You have unsaved changes. Save before leaving Settings?';

    return showSettingsSmartDialog({
        mode: 'warning',
        title: 'Unsaved Settings',
        subtitle,
        detail: 'Choose Save to persist now, or Discard to continue without saving.',
        iconHtml: '<i class="fas fa-exclamation"></i>',
        actions: [
            { label: 'Save Changes', value: 'save', variant: 'primary', icon: 'fa-save' },
            { label: 'Discard', value: 'discard', variant: 'danger', icon: 'fa-trash' },
            { label: 'Cancel', value: 'cancel', variant: 'secondary', icon: 'fa-times' }
        ]
    });
}

async function requestGitHubDisconnectDecision() {
    const accountLabel = githubUserData?.login
        ? `@${githubUserData.login}`
        : 'this GitHub account';

    const decision = await showSettingsSmartDialog({
        mode: 'warning',
        title: 'Disconnect GitHub',
        subtitle: `Disconnect ${accountLabel} from Project Manager?`,
        detail: 'You can reconnect at any time by adding a token again.',
        iconHtml: '<i class="fas fa-unlink"></i>',
        actions: [
            { label: 'Disconnect', value: 'disconnect', variant: 'danger', icon: 'fa-unlink' },
            { label: 'Cancel', value: 'cancel', variant: 'secondary', icon: 'fa-times' }
        ]
    });

    return decision === 'disconnect';
}

async function resetSettingsFormToSavedState() {
    await applySettingsToForm(appSettings, { resetDirtyState: true });
    refreshCustomDropdowns();
    renderSettingsExtensionsList();
}

async function handlePendingSettingsBeforeLeave(context = 'leave') {
    if (!settingsDirty) {
        return true;
    }

    const decision = await requestUnsavedSettingsDecision(context);
    if (decision === 'save') {
        return saveSettings({ showSuccessDialog: false });
    }

    if (decision === 'discard') {
        await resetSettingsFormToSavedState();
        return true;
    }

    return false;
}

async function attemptAppClose(options = {}) {
    const { forceQuit = false } = options;
    if (isHandlingAppCloseRequest) {
        return;
    }

    isHandlingAppCloseRequest = true;
    try {
        const normalized = normalizeSettings(appSettings);
        if (normalized.closeToTray && !forceQuit) {
            await ipcRenderer.invoke('close-window');
            return;
        }

        const canClose = await handlePendingSettingsBeforeLeave('close');
        if (!canClose) {
            await ipcRenderer.invoke('cancel-app-close');
            return;
        }
        await ipcRenderer.invoke('confirm-app-close');
    } finally {
        isHandlingAppCloseRequest = false;
    }
}

function initializeCustomDropdowns() {
    // Color map for accent-color swatch dots
    const swatchSelects = new Set(['accent-color']);

    document.querySelectorAll('.setting-item select').forEach(select => {
        if (select.classList.contains('custom-select-hidden')) return;

        const wrapper = document.createElement('div');
        wrapper.className = 'custom-dropdown';
        wrapper.setAttribute('role', 'listbox');
        wrapper.setAttribute('tabindex', '0');

        const hasSwatch = swatchSelects.has(select.id);

        // Build current label
        const selectedOpt = select.options[select.selectedIndex];
        const selectedText = selectedOpt ? selectedOpt.textContent : '';

        // Trigger button
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'custom-dropdown-trigger';
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.innerHTML = `
            ${hasSwatch ? `<span class="option-swatch" style="background:${select.value}"></span>` : ''}
            <span class="custom-dropdown-label">${selectedText}</span>
            <span class="custom-dropdown-chevron">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </span>
        `;

        // Options panel
        const optionsPanel = document.createElement('div');
        optionsPanel.className = 'custom-dropdown-options';

        Array.from(select.options).forEach((opt, idx) => {
            const item = document.createElement('div');
            item.className = 'custom-dropdown-option' + (idx === select.selectedIndex ? ' selected' : '');
            item.setAttribute('role', 'option');
            item.dataset.value = opt.value;

            const swatchHTML = hasSwatch
                ? `<span class="option-swatch" style="background:${opt.value}"></span>`
                : '';

            item.innerHTML = `
                ${swatchHTML}
                <span>${opt.textContent}</span>
                <span class="option-check">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                </span>
            `;

            item.addEventListener('click', (e) => {
                e.stopPropagation();
                selectOption(wrapper, select, item);
            });

            optionsPanel.appendChild(item);
        });

        // Insert into DOM
        select.classList.add('custom-select-hidden');
        select.parentNode.insertBefore(wrapper, select);
        wrapper.appendChild(trigger);
        wrapper.appendChild(optionsPanel);

        // Open / close toggle
        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleDropdown(wrapper);
        });

        // Keyboard navigation
        wrapper.addEventListener('keydown', (e) => {
            handleDropdownKeyboard(e, wrapper, select);
        });
    });

    // Close any open dropdown when clicking outside
    document.addEventListener('click', () => {
        closeAllDropdowns();
    });

    function toggleDropdown(dropdown) {
        const isOpen = dropdown.classList.contains('open');
        closeAllDropdowns();
        if (!isOpen) {
            // Decide direction: drop up if too close to viewport bottom
            const rect = dropdown.getBoundingClientRect();
            const spaceBelow = window.innerHeight - rect.bottom;
            dropdown.classList.toggle('drop-up', spaceBelow < 280);

            dropdown.classList.add('open');
            dropdown.querySelector('.custom-dropdown-trigger').setAttribute('aria-expanded', 'true');

            // Scroll selected option into view
            const selected = dropdown.querySelector('.custom-dropdown-option.selected');
            if (selected) {
                selected.scrollIntoView({ block: 'nearest' });
            }
        }
    }

    function closeAllDropdowns() {
        document.querySelectorAll('.custom-dropdown.open').forEach(dd => {
            dd.classList.remove('open');
            dd.querySelector('.custom-dropdown-trigger').setAttribute('aria-expanded', 'false');
        });
    }

    function selectOption(dropdown, nativeSelect, optionEl) {
        const value = optionEl.dataset.value;
        const label = optionEl.querySelector('span:not(.option-check):not(.option-swatch)').textContent;

        // Update native select
        nativeSelect.value = value;
        nativeSelect.dispatchEvent(new Event('change', { bubbles: true }));

        // Update trigger label
        const triggerLabel = dropdown.querySelector('.custom-dropdown-label');
        triggerLabel.textContent = label;

        // Update trigger swatch if present
        const triggerSwatch = dropdown.querySelector('.custom-dropdown-trigger .option-swatch');
        if (triggerSwatch) {
            triggerSwatch.style.background = value;
        }

        // Update selected state
        dropdown.querySelectorAll('.custom-dropdown-option').forEach(o => o.classList.remove('selected'));
        optionEl.classList.add('selected');

        // Close
        dropdown.classList.remove('open');
        dropdown.querySelector('.custom-dropdown-trigger').setAttribute('aria-expanded', 'false');
        dropdown.querySelector('.custom-dropdown-trigger').focus();
    }

    function handleDropdownKeyboard(e, dropdown, nativeSelect) {
        const isOpen = dropdown.classList.contains('open');
        const options = Array.from(dropdown.querySelectorAll('.custom-dropdown-option'));
        const focusedIdx = options.findIndex(o => o.classList.contains('focused'));

        switch (e.key) {
            case 'Enter':
            case ' ':
                e.preventDefault();
                if (isOpen && focusedIdx >= 0) {
                    selectOption(dropdown, nativeSelect, options[focusedIdx]);
                } else {
                    toggleDropdown(dropdown);
                }
                break;
            case 'Escape':
                if (isOpen) {
                    e.preventDefault();
                    e.stopPropagation();
                    dropdown.classList.remove('open');
                    dropdown.querySelector('.custom-dropdown-trigger').setAttribute('aria-expanded', 'false');
                    dropdown.querySelector('.custom-dropdown-trigger').focus();
                }
                break;
            case 'ArrowDown':
                e.preventDefault();
                if (!isOpen) {
                    toggleDropdown(dropdown);
                } else {
                    const nextIdx = Math.min(focusedIdx + 1, options.length - 1);
                    options.forEach(o => o.classList.remove('focused'));
                    options[nextIdx].classList.add('focused');
                    options[nextIdx].scrollIntoView({ block: 'nearest' });
                }
                break;
            case 'ArrowUp':
                e.preventDefault();
                if (isOpen) {
                    const prevIdx = Math.max(focusedIdx - 1, 0);
                    options.forEach(o => o.classList.remove('focused'));
                    options[prevIdx].classList.add('focused');
                    options[prevIdx].scrollIntoView({ block: 'nearest' });
                }
                break;
            case 'Home':
                if (isOpen) {
                    e.preventDefault();
                    options.forEach(o => o.classList.remove('focused'));
                    options[0].classList.add('focused');
                    options[0].scrollIntoView({ block: 'nearest' });
                }
                break;
            case 'End':
                if (isOpen) {
                    e.preventDefault();
                    options.forEach(o => o.classList.remove('focused'));
                    options[options.length - 1].classList.add('focused');
                    options[options.length - 1].scrollIntoView({ block: 'nearest' });
                }
                break;
            case 'Tab':
                if (isOpen) {
                    dropdown.classList.remove('open');
                    dropdown.querySelector('.custom-dropdown-trigger').setAttribute('aria-expanded', 'false');
                }
                break;
        }
    }
}

/** Sync custom dropdowns to match their native <select> values */
function refreshCustomDropdowns() {
    document.querySelectorAll('.custom-dropdown').forEach(dropdown => {
        const nativeSelect = dropdown.parentElement.querySelector('select.custom-select-hidden');
        if (!nativeSelect) return;

        const value = nativeSelect.value;
        const options = dropdown.querySelectorAll('.custom-dropdown-option');

        options.forEach(opt => {
            const isSelected = opt.dataset.value === value;
            opt.classList.toggle('selected', isSelected);
            if (isSelected) {
                const label = opt.querySelector('span:not(.option-check):not(.option-swatch)');
                if (label) {
                    dropdown.querySelector('.custom-dropdown-label').textContent = label.textContent;
                }
                const triggerSwatch = dropdown.querySelector('.custom-dropdown-trigger .option-swatch');
                if (triggerSwatch) {
                    triggerSwatch.style.background = value;
                }
            }
        });

        // Rebuild options if the native select has new <option> elements (e.g. theme extensions)
        if (options.length !== nativeSelect.options.length) {
            // Remove old custom dropdown and re-init
            nativeSelect.classList.remove('custom-select-hidden');
            dropdown.remove();
            initializeCustomDropdowns();
        }
    });
}

function initializeSettings() {
    // Auto-size number inputs based on value length
    function autoSizeNumberInput(input) {
        const len = Math.max(String(input.value).length, 1);
        input.style.width = (len + 1) + 'ch';
    }

    function triggerSettingFieldChange(inputId) {
        const input = document.getElementById(inputId);
        if (!input) return;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Custom number stepper buttons
    document.querySelectorAll('.st-number-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const wrap = btn.closest('.st-number');
            const input = wrap.querySelector('input[type="number"]');
            if (!input) return;
            const step = parseFloat(input.step) || 1;
            const min = parseFloat(input.min);
            const max = parseFloat(input.max);
            let val = parseFloat(input.value) || 0;
            if (btn.dataset.dir === 'up') {
                val = Math.min(isNaN(max) ? Infinity : max, val + step);
            } else {
                val = Math.max(isNaN(min) ? -Infinity : min, val - step);
            }
            input.value = val;
            autoSizeNumberInput(input);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });
    });

    // Initialize sizing and listen for manual edits
    document.querySelectorAll('.st-number input[type="number"]').forEach(input => {
        autoSizeNumberInput(input);
        input.addEventListener('input', () => autoSizeNumberInput(input));
    });

    // Settings categories
    document.querySelectorAll('.settings-category').forEach(category => {
        category.addEventListener('click', () => {
            switchSettingsCategory(category.dataset.category);
        });
    });

    // Settings search functionality
    const settingsSearch = document.getElementById('settings-search');
    const clearSearchBtn = document.getElementById('clear-settings-search');

    if (settingsSearch) {
        settingsSearch.addEventListener('input', (e) => {
            const query = e.target.value.toLowerCase();
            filterSettings(query);

            // Show/hide clear button
            if (clearSearchBtn) {
                clearSearchBtn.style.display = query ? 'block' : 'none';
            }
        });

        settingsSearch.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                settingsSearch.value = '';
                filterSettings('');
                if (clearSearchBtn) clearSearchBtn.style.display = 'none';
            }
        });
    }

    if (clearSearchBtn) {
        clearSearchBtn.addEventListener('click', () => {
            if (settingsSearch) {
                settingsSearch.value = '';
                settingsSearch.focus();
                filterSettings('');
                clearSearchBtn.style.display = 'none';
            }
        });
    }

    // Save settings button
    document.getElementById('save-settings-btn')?.addEventListener('click', async () => {
        await saveSettings();
    });

    document.getElementById('update-channel')?.addEventListener('change', async (event) => {
        if (settingsIsApplyingFromModel) {
            return;
        }

        const channel = typeof event.target?.value === 'string' ? event.target.value : 'stable';
        const result = await ipcRenderer.invoke('set-update-channel', channel);
        updateUpdateState(result?.state || {});
        if (!result?.success && result?.error) {
            showNotification(result.error, 'warning');
            return;
        }

        showNotification(`Update channel set to ${channel}`, 'info');
    });

    // Browse buttons
    document.getElementById('browse-default-path')?.addEventListener('click', async () => {
        const selectedPath = await ipcRenderer.invoke('select-folder');
        if (selectedPath) {
            document.getElementById('default-project-path').value = selectedPath;
            triggerSettingFieldChange('default-project-path');
        }
    });

    document.getElementById('open-appdata-folder')?.addEventListener('click', async () => {
        try {
            const result = await ipcRenderer.invoke('open-user-data-folder');
            if (result?.success) {
                showNotification('Opened AppData folder', 'success');
            } else {
                showNotification(result?.error || 'Failed to open AppData folder', 'error');
            }
        } catch (error) {
            showNotification(error.message || 'Failed to open AppData folder', 'error');
        }
    });

    const appDataPathDisplay = document.getElementById('appdata-path-display');
    if (appDataPathDisplay) {
        ipcRenderer.invoke('get-user-data-path')
            .then((userDataPath) => {
                if (typeof userDataPath === 'string' && userDataPath.trim()) {
                    appDataPathDisplay.textContent = userDataPath;
                    appDataPathDisplay.title = userDataPath;
                } else {
                    appDataPathDisplay.textContent = 'Unable to resolve AppData path';
                }
            })
            .catch(() => {
                appDataPathDisplay.textContent = 'Unable to resolve AppData path';
            });
    }

    document.getElementById('browse-editor-path')?.addEventListener('click', async () => {
        const selectedPath = await ipcRenderer.invoke('select-file', {
            filters: [{ name: 'Executables', extensions: ['exe'] }]
        });
        if (selectedPath) {
            document.getElementById('editor-path').value = selectedPath;
            triggerSettingFieldChange('editor-path');
        }
    });

    document.getElementById('browse-terminal-path')?.addEventListener('click', async () => {
        const selectedPath = await ipcRenderer.invoke('select-file', {
            filters: [{ name: 'Executables', extensions: ['exe'] }]
        });
        if (selectedPath) {
            document.getElementById('terminal-path').value = selectedPath;
            triggerSettingFieldChange('terminal-path');
        }
    });

    document.getElementById('browse-git-path')?.addEventListener('click', async () => {
        const selectedPath = await ipcRenderer.invoke('select-file', {
            filters: [{ name: 'Executables', extensions: ['exe'] }]
        });
        if (selectedPath) {
            document.getElementById('git-path').value = selectedPath;
            triggerSettingFieldChange('git-path');
        }
    });

    // Theme selection — apply immediately and auto-save
    // Field previews and dirty-state tracking are handled centrally by registerSettingsDirtyTracking().

    // Clear cache button
    document.getElementById('clear-cache-btn')?.addEventListener('click', () => {
        if (confirm('Are you sure you want to clear all cache? This cannot be undone.')) {
            showNotification('Cache cleared successfully', 'success');
        }
    });

    // Reset settings button
    document.getElementById('reset-settings-btn')?.addEventListener('click', async () => {
        const confirmed = confirm('Reset all settings to default?\n\nThis will:\n- Clear all your custom settings\n- Restore factory defaults\n\nThis action cannot be undone.');

        if (confirmed) {
            try {
                const defaultSettings = normalizeSettings({
                    ...getSettingsDefaults(),
                    defaultProjectPath: workspacePath || getSettingsDefaults().defaultProjectPath
                });
                const success = await ipcRenderer.invoke('save-settings', defaultSettings);
                if (!success) {
                    throw new Error('Failed to persist default settings');
                }

                appSettings = defaultSettings;
                await applySettingsToForm(appSettings, { resetDirtyState: true });
                await loadSettings();
                showNotification('Settings reset to defaults', 'success');
            } catch (error) {
                console.error('Failed to reset settings:', error);
                showNotification('Failed to reset settings', 'error');
            }
        }
    });

    // Import settings button
    document.getElementById('import-settings-btn')?.addEventListener('click', async () => {
        await importSettings();
    });

    // Export settings button
    document.getElementById('export-settings-btn')?.addEventListener('click', async () => {
        await exportSettings();
    });

    // Keyboard shortcuts for settings
    document.addEventListener('keydown', (e) => {
        const settingsView = document.getElementById('settings-view');
        if (!settingsView || !settingsView.classList.contains('active')) return;

        // Ctrl/Cmd + F to focus search
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
            e.preventDefault();
            document.getElementById('settings-search')?.focus();
        }

        // Arrow keys for category navigation
        const activeCategory = document.querySelector('.settings-category.active');
        if (activeCategory && !e.target.matches('input, select, textarea')) {
            let nextCategory = null;

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                nextCategory = activeCategory.nextElementSibling;
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                nextCategory = activeCategory.previousElementSibling;
            }

            if (nextCategory && nextCategory.classList.contains('settings-category')) {
                switchSettingsCategory(nextCategory.dataset.category);
            }
        }
    });

    initializeSettingsExtensionsControls();
    registerSettingsDirtyTracking();
    updateSaveSettingsButtonState();

    // Add ARIA labels and roles for accessibility
    addAccessibilityAttributes();
}

// Add accessibility attributes
function addAccessibilityAttributes() {
    // Settings categories
    document.querySelectorAll('.settings-category').forEach((category) => {
        category.setAttribute('role', 'tab');
        category.setAttribute('tabindex', category.classList.contains('active') ? '0' : '-1');
        category.setAttribute('aria-selected', category.classList.contains('active') ? 'true' : 'false');
        category.setAttribute('aria-label', `${category.textContent.trim()} settings`);
    });

    // Settings panels
    document.querySelectorAll('.settings-panel').forEach((panel) => {
        panel.setAttribute('role', 'tabpanel');
        panel.setAttribute('aria-hidden', panel.classList.contains('active') ? 'false' : 'true');
    });

    // Form inputs
    document.querySelectorAll('.setting-item input, .setting-item select').forEach(input => {
        const label = input.closest('.setting-item')?.querySelector('label');
        if (label && !input.id) {
            const id = 'setting-' + Math.random().toString(36).substring(2, 11);
            input.id = id;
            label.setAttribute('for', id);
        }
    });
}

// Switch settings category with animation
function switchSettingsCategory(categoryName) {
    document.querySelectorAll('.settings-category').forEach(c => {
        c.classList.remove('active');
        c.setAttribute('aria-selected', 'false');
        c.setAttribute('tabindex', '-1');
    });
    document.querySelectorAll('.settings-panel').forEach(p => {
        p.classList.remove('active');
        p.setAttribute('aria-hidden', 'true');
    });

    const category = document.querySelector(`.settings-category[data-category="${categoryName}"]`);
    const panel = document.getElementById(`${categoryName}-settings`);

    if (category) {
        category.classList.add('active');
        category.setAttribute('aria-selected', 'true');
        category.setAttribute('tabindex', '0');
        category.focus();
    }
    if (panel) {
        panel.classList.add('active');
        panel.setAttribute('aria-hidden', 'false');
    }

    // Update breadcrumb
    updateSettingsBreadcrumb(categoryName);
}

// Update settings breadcrumb
function updateSettingsBreadcrumb(categoryName) {
    const breadcrumb = document.getElementById('settings-breadcrumb');
    if (!breadcrumb) return;

    const categoryNames = {
        'general': 'General',
        'appearance': 'Appearance',
        'editor': 'Editor',
        'terminal': 'Terminal',
        'git': 'Git',
        'extensions': 'Extensions',
        'advanced': 'Advanced'
    };

    breadcrumb.innerHTML = `<span class="breadcrumb-item active">${categoryNames[categoryName] || 'Settings'}</span>`;
}

// Filter settings based on search query
function filterSettings(query) {
    if (!query) {
        // Show all settings
        document.querySelectorAll('.setting-item').forEach(item => {
            item.style.display = '';
            item.classList.remove('highlight-search');
        });
        document.querySelectorAll('.setting-group').forEach(group => {
            group.style.display = '';
        });
        document.querySelectorAll('.settings-category').forEach(cat => {
            cat.style.display = '';
        });
        return;
    }

    let hasResults = false;
    const categories = new Set();

    // Search through all setting items
    document.querySelectorAll('.setting-item').forEach(item => {
        const text = item.textContent.toLowerCase();
        const matches = text.includes(query);

        if (matches) {
            item.style.display = '';
            item.classList.add('highlight-search');
            hasResults = true;

            // Track which category this belongs to
            const panel = item.closest('.settings-panel');
            if (panel) {
                const categoryName = panel.id.replace('-settings', '');
                categories.add(categoryName);
            }
        } else {
            item.style.display = 'none';
            item.classList.remove('highlight-search');
        }
    });

    // Hide/show groups based on whether they have visible items
    document.querySelectorAll('.setting-group').forEach(group => {
        const visibleItems = Array.from(group.querySelectorAll('.setting-item')).some(
            item => item.style.display !== 'none'
        );
        group.style.display = visibleItems ? '' : 'none';
    });

    // Show only matching categories in sidebar
    document.querySelectorAll('.settings-category').forEach(cat => {
        if (categories.has(cat.dataset.category)) {
            cat.style.display = '';
        } else {
            cat.style.display = 'none';
        }
    });

    // If we have results, show all panels to display filtered results
    if (hasResults) {
        document.querySelectorAll('.settings-panel').forEach(panel => {
            const categoryName = panel.id.replace('-settings', '');
            if (categories.has(categoryName)) {
                panel.classList.add('active');
            } else {
                panel.classList.remove('active');
            }
        });
    }
}

// Import settings from file
async function importSettings() {
    try {
        const filePath = await ipcRenderer.invoke('select-file', {
            filters: [{ name: 'JSON Files', extensions: ['json'] }],
            properties: ['openFile']
        });

        if (filePath) {
            const importedSettings = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

            // Validate and merge settings
            appSettings = { ...appSettings, ...importedSettings };

            // Save to storage
            await ipcRenderer.invoke('save-settings', appSettings);

            // Reload UI
            await loadSettings();

            showNotification('Settings imported successfully', 'success');
        }
    } catch (error) {
        console.error('Failed to import settings:', error);
        showNotification('Failed to import settings', 'error');
    }
}

// Export settings to file
async function exportSettings() {
    try {
        const filePath = await ipcRenderer.invoke('save-dialog', {
            defaultPath: 'appmanager-settings.json',
            filters: [{ name: 'JSON Files', extensions: ['json'] }]
        });

        if (filePath) {
            fs.writeFileSync(filePath, JSON.stringify(appSettings, null, 2));
            showNotification('Settings exported successfully', 'success');
        }
    } catch (error) {
        console.error('Failed to export settings:', error);
        showNotification('Failed to export settings', 'error');
    }
}

// Git functionality
function initializeGitView() {
    // Initialize Git Tabs
    initializeGitTabs();

    document.getElementById('clone-repo')?.addEventListener('click', () => {
        showModal('clone-modal');
    });

    document.getElementById('git-refresh')?.addEventListener('click', async () => {
        await refreshGitStatus();
    });

    document.getElementById('git-stage-all')?.addEventListener('click', async () => {
        await stageAll();
    });

    document.getElementById('git-discard-all')?.addEventListener('click', async () => {
        if (confirm('Are you sure you want to discard all changes? This cannot be undone.')) {
            await discardAll();
        }
    });

    document.getElementById('git-select-repo')?.addEventListener('click', async () => {
        const selectedPath = await ipcRenderer.invoke('select-folder');
        if (selectedPath) {
            // Check if it's a valid project
            const projectName = path.basename(selectedPath);
            currentProject = {
                name: projectName,
                path: selectedPath,
                type: 'unknown'
            };
            await refreshGitStatus();
            showNotification(`Selected repository: ${projectName}`, 'success');
        }
    });

    document.getElementById('git-init-btn')?.addEventListener('click', async () => {
        await initializeGit();
    });

    document.getElementById('git-commit-btn')?.addEventListener('click', () => {
        showModal('git-commit-modal');
    });
    
    document.getElementById('confirm-commit-btn')?.addEventListener('click', async () => {
        const messageInput = document.getElementById('commit-message');
        const message = messageInput?.value;
        if (!message || !message.trim()) {
            showNotification('Please enter a commit message', 'error');
            return;
        }

        if (!currentProject) {
            showNotification('Please select a project first', 'error');
            return;
        }

        await withGitLock(async () => {
            try {
                const result = await ipcRenderer.invoke('git-commit', currentProject.path, message);
                if (result.success) {
                    showNotification('Changes committed successfully', 'success');
                    hideModal('git-commit-modal');
                    if (messageInput) messageInput.value = '';
                    await refreshGitStatus();
                } else {
                    showNotification(`Commit failed: ${result.error}`, 'error');
                }
            } catch (error) {
                showNotification(`Commit error: ${error.message}`, 'error');
            }
        });
    });
    
    // Clone repository
    document.getElementById('clone-btn')?.addEventListener('click', async () => {
        const repoUrl = document.getElementById('clone-repo-url').value.trim();
        const cloneLocation = document.getElementById('clone-location').value;

        if (!repoUrl) {
            showNotification('Please enter repository URL', 'error');
            return;
        }

        // Validate Git URL format
        const gitUrlPattern = /^(https?:\/\/.+\.git|git@.+:.+\.git|https?:\/\/(github|gitlab|bitbucket)\..+\/.+\/.+)$/i;
        const sshPattern = /^git@[\w.-]+:[\w./-]+$/;
        if (!gitUrlPattern.test(repoUrl) && !sshPattern.test(repoUrl) && !repoUrl.startsWith('https://') && !repoUrl.startsWith('http://')) {
            showNotification('Please enter a valid Git repository URL', 'error');
            return;
        }

        const targetPath = cloneLocation || workspacePath || normalizeSettings(appSettings).defaultProjectPath;
        if (!targetPath) {
            showNotification('Please choose a clone location', 'error');
            return;
        }

        showNotification('Queueing repository clone...', 'info');
        try {
            let followup = null;
            const shouldOpenAfterClone = Boolean(document.getElementById('open-after-clone')?.checked);
            if (shouldOpenAfterClone) {
                const repoName = deriveRepositoryNameFromUrl(repoUrl);
                if (repoName) {
                    followup = {
                        openInVSCodePath: path.join(targetPath, repoName)
                    };
                }
            }

            await enqueueOperation('clone-repository', {
                repoUrl,
                targetPath
            }, followup);
            hideModal('clone-modal');
            showNotification('Clone queued. Open Operation Queue to track progress.', 'success');
        } catch (error) {
            showNotification(`Clone error: ${error.message}`, 'error');
        }
    });
    
    document.getElementById('browse-clone-location')?.addEventListener('click', async () => {
        const selectedPath = await ipcRenderer.invoke('select-folder');
        if (selectedPath) {
            document.getElementById('clone-location').value = selectedPath;
        }
    });

    // Pull/Push/Fetch/Sync operations
    document.getElementById('git-pull-btn')?.addEventListener('click', async () => {
        if (!currentProject) {
            showNotification('Please select a project first', 'error');
            return;
        }
        await withGitLock(async () => {
            try {
                showNotification('Pulling changes...', 'info');
                const result = await ipcRenderer.invoke('git-pull', currentProject.path);
                if (result.success) {
                    showNotification('Pull completed successfully', 'success');
                    await refreshGitStatus();
                    await checkForMergeConflictsAndPrompt('pull');
                } else {
                    showNotification(`Pull failed: ${result.error}`, 'error');
                    await checkForMergeConflictsAndPrompt('pull');
                }
            } catch (error) {
                showNotification(`Pull error: ${error.message}`, 'error');
            }
        });
    });

    document.getElementById('git-push-btn')?.addEventListener('click', async () => {
        if (!currentProject) {
            showNotification('Please select a project first', 'error');
            return;
        }
        await withGitLock(async () => {
            try {
                showNotification('Pushing changes...', 'info');
                const result = await ipcRenderer.invoke('git-push', currentProject.path);
                if (result.success) {
                    showNotification('Push completed successfully', 'success');
                    await refreshGitStatus();
                } else {
                    showNotification(`Push failed: ${result.error}`, 'error');
                }
            } catch (error) {
                showNotification(`Push error: ${error.message}`, 'error');
            }
        });
    });

    document.getElementById('git-fetch-btn')?.addEventListener('click', async () => {
        if (!currentProject) {
            showNotification('Please select a project first', 'error');
            return;
        }
        await withGitLock(async () => {
            try {
                showNotification('Fetching from remote...', 'info');
                const result = await ipcRenderer.invoke('git-fetch', currentProject.path);
                if (result.success) {
                    showNotification('Fetch completed successfully', 'success');
                    await refreshGitStatus();
                } else {
                    showNotification(`Fetch failed: ${result.error}`, 'error');
                }
            } catch (error) {
                showNotification(`Fetch error: ${error.message}`, 'error');
            }
        });
    });

    document.getElementById('git-sync-btn')?.addEventListener('click', async () => {
        if (!currentProject) {
            showNotification('Please select a project first', 'error');
            return;
        }
        await withGitLock(async () => {
            try {
                showNotification('Syncing repository...', 'info');
                const result = await ipcRenderer.invoke('git-sync', currentProject.path);
                if (result.success) {
                    showNotification('Sync completed successfully', 'success');
                    await refreshGitStatus();
                } else {
                    showNotification(`Sync failed: ${result.error}`, 'error');
                }
            } catch (error) {
                showNotification(`Sync error: ${error.message}`, 'error');
            }
        });
    });

    // Stash operations
    document.getElementById('git-stash-btn')?.addEventListener('click', async () => {
        if (!currentProject) {
            showNotification('Please select a project first', 'error');
            return;
        }
        const message = prompt('Enter stash message (optional):');
        if (message === null) return; // User cancelled prompt
        await withGitLock(async () => {
            try {
                const result = await ipcRenderer.invoke('git-stash', currentProject.path, message || '');
                if (result.success) {
                    showNotification('Changes stashed successfully', 'success');
                    await refreshGitStatus();
                } else {
                    showNotification(`Stash failed: ${result.error}`, 'error');
                }
            } catch (error) {
                showNotification(`Stash error: ${error.message}`, 'error');
            }
        });
    });

    // Merge operations
    document.getElementById('git-merge-btn')?.addEventListener('click', async () => {
        if (!currentProject) {
            showNotification('Please select a project first', 'error');
            return;
        }
        showModal('git-merge-modal');
        await loadBranchesForMerge();
    });

    // Commit and push combined
    document.getElementById('git-commit-push-btn')?.addEventListener('click', async () => {
        const messageInput = document.getElementById('git-commit-message-input');
        const message = messageInput?.value;
        if (!message || !message.trim()) {
            showNotification('Please enter a commit message', 'error');
            return;
        }

        if (!currentProject) {
            showNotification('Please select a project first', 'error');
            return;
        }

        await withGitLock(async () => {
            try {
                showNotification('Committing changes...', 'info');
                const commitResult = await ipcRenderer.invoke('git-commit', currentProject.path, message);
                if (commitResult.success) {
                    showNotification('Pushing to remote...', 'info');
                    const pushResult = await ipcRenderer.invoke('git-push', currentProject.path);
                    if (pushResult.success) {
                        showNotification('Committed and pushed successfully', 'success');
                        if (messageInput) messageInput.value = '';
                        await refreshGitStatus();
                    } else {
                        showNotification(`Commit succeeded but push failed: ${pushResult.error}`, 'error');
                        await refreshGitStatus();
                    }
                } else {
                    showNotification(`Commit failed: ${commitResult.error}`, 'error');
                }
            } catch (error) {
                showNotification(`Commit & push error: ${error.message}`, 'error');
            }
        });
    });

    // Project dropdown
    document.getElementById('git-project-dropdown-btn')?.addEventListener('click', () => {
        const menu = document.getElementById('git-projects-menu');
        const btn = document.getElementById('git-project-dropdown-btn');
        menu.classList.toggle('show');
        btn.classList.toggle('active');
        if (menu.classList.contains('show')) {
            loadProjectsIntoDropdown();
        }
    });

    document.getElementById('git-projects-search')?.addEventListener('input', (e) => {
        filterProjectsInDropdown(e.target.value);
    });

    document.getElementById('git-open-folder-btn')?.addEventListener('click', async () => {
        const selectedPath = await ipcRenderer.invoke('select-folder');
        if (selectedPath) {
            const projectName = selectedPath.split('\\').pop();
            currentProject = { name: projectName, path: selectedPath };
            updateSelectedProject();
            await refreshGitStatus();
            document.getElementById('git-projects-menu').classList.remove('show');
            document.getElementById('git-project-dropdown-btn').classList.remove('active');
        }
    });

    document.getElementById('git-new-project-btn')?.addEventListener('click', () => {
        document.getElementById('git-projects-menu').classList.remove('show');
        document.getElementById('git-project-dropdown-btn').classList.remove('active');
        showModal('new-project-modal');
    });

    // GitHub Integration
    initializeGitHubUploadPickerUi();

    document.getElementById('github-upload-btn')?.addEventListener('click', () => {
        void openGitHubUploadModal();
    });

    const githubRepoNameInput = document.getElementById('github-repo-name');
    githubRepoNameInput?.addEventListener('input', () => {
        updateGitHubUploadSubmitState();
    });
    githubRepoNameInput?.addEventListener('blur', () => {
        const validation = validateGitHubRepoNameInput(githubRepoNameInput.value);
        if (validation.valid && githubRepoNameInput.value !== validation.normalized) {
            githubRepoNameInput.value = validation.normalized;
        }
        updateGitHubUploadSubmitState();
    });

    // GitHub visibility toggle styling
    document.querySelectorAll('.gh-visibility-option').forEach(option => {
        option.addEventListener('click', () => {
            document.querySelectorAll('.gh-visibility-option').forEach(o => o.classList.remove('selected'));
            option.classList.add('selected');
        });
    });

    document.getElementById('github-connect-card-btn')?.addEventListener('click', () => {
        openGitHubLoginModal();
    });

    document.getElementById('confirm-github-auth-btn')?.addEventListener('click', async () => {
        const token = document.getElementById('github-token').value;
        if (!token) {
            showNotification('Please enter a GitHub token', 'error');
            return;
        }

        try {
            const result = await ipcRenderer.invoke('github-save-token', token);
            if (result.success) {
                if (result.user) {
                    githubUserData = result.user;
                } else {
                    await loadGitHubToken();
                }
                updateGitHubAvatar();
                setStatusConnectionState(true);
                updateGitHubLoginModalState();
                showNotification('GitHub account connected successfully', 'success');
                hideModal('github-auth-modal');
                await updateGitHubStatus();
            } else {
                showNotification(`Failed to connect: ${result.error}`, 'error');
            }
        } catch (error) {
            showNotification(`Connection error: ${error.message}`, 'error');
        }
    });

    document.getElementById('github-token-link')?.addEventListener('click', (e) => {
        e.preventDefault();
        ipcRenderer.invoke('open-external', 'https://github.com/settings/tokens');
    });

    document.getElementById('confirm-github-upload-btn')?.addEventListener('click', async () => {
        const repoNameInput = document.getElementById('github-repo-name');
        const repoValidation = validateGitHubRepoNameInput(repoNameInput?.value || '');
        if (!repoValidation.valid) {
            updateGitHubRepoNameHint(repoValidation, { forceError: true });
            updateGitHubUploadSubmitState();
            showNotification(repoValidation.message || 'Repository name is invalid', 'error');
            repoNameInput?.focus();
            return;
        }

        if (repoNameInput && repoNameInput.value !== repoValidation.normalized) {
            repoNameInput.value = repoValidation.normalized;
        }

        if (!currentProject) {
            showNotification('No project selected', 'error');
            updateGitHubUploadSubmitState();
            return;
        }

        const readiness = getGitHubUploadSubmitReadiness(repoValidation);
        if (!readiness.canSubmit) {
            updateGitHubUploadSubmitState();
            showNotification(readiness.reason || 'Complete all required fields before uploading', 'error');
            return;
        }

        const selectedPaths = collectGitHubUploadPathspecs();
        if (selectedPaths.length === 0) {
            showNotification('Select at least one file or folder to upload', 'error');
            updateGitHubUploadSubmitState();
            return;
        }

        const description = document.getElementById('github-repo-description')?.value || '';
        const isPrivate = document.querySelector('input[name="github-visibility"]:checked')?.value === 'private';
        const addReadme = Boolean(document.getElementById('github-add-readme')?.checked);
        const addGitignore = Boolean(document.getElementById('github-add-gitignore')?.checked);
        const addLicense = Boolean(document.getElementById('github-add-license')?.checked);

        githubUploadInProgress = true;
        updateGitHubUploadSubmitState();
        ghUploadProgressShow();

        try {
            await enqueueOperation('github-upload-project', {
                projectPath: currentProject.path,
                repoData: {
                    name: repoValidation.normalized,
                    description,
                    isPrivate,
                    addReadme,
                    addGitignore,
                    addLicense,
                    selectedPaths
                }
            }, { kind: 'github-upload' });
            showNotification('GitHub upload queued. Progress is now tracked by the queue.', 'info');
        } catch (error) {
            ghUploadProgressComplete(false, null, error.message);
            githubUploadInProgress = false;
            updateGitHubUploadSubmitState();
        }
    });

    // GitHub sidebar action buttons
    document.getElementById('github-create-repo-btn')?.addEventListener('click', async () => {
        await openGitHubUploadModal();
    });

    document.getElementById('github-publish-btn')?.addEventListener('click', async () => {
        if (!currentProject) {
            showNotification('Please select a project first', 'error');
            return;
        }

        await withGitLock(async () => {
            try {
                showNotification('Publishing branch to GitHub...', 'info');
                const result = await ipcRenderer.invoke('git-push', currentProject.path);
                if (result.success) {
                    showNotification('Branch published successfully', 'success');
                    await refreshGitStatus();
                } else {
                    showNotification(`Publish failed: ${result.error}`, 'error');
                }
            } catch (error) {
                showNotification(`Publish error: ${error.message}`, 'error');
            }
        });
    });

    document.getElementById('github-pr-btn')?.addEventListener('click', async () => {
        if (!currentProject) {
            showNotification('Please select a project first', 'error');
            return;
        }

        try {
            const remoteResult = await ipcRenderer.invoke('git-remote-list', currentProject.path);
            if (remoteResult.success && remoteResult.output) {
                const match = remoteResult.output.match(/github\.com[:/](.+?)(?:\.git)?(?:\s|$)/);
                if (match) {
                    const repoPath = match[1].replace(/\.git$/, '');
                    const prUrl = `https://github.com/${repoPath}/compare`;
                    ipcRenderer.invoke('open-external', prUrl);
                    showNotification('Opening GitHub PR creation page...', 'info');
                } else {
                    showNotification('No GitHub remote found for this repository', 'error');
                }
            } else {
                showNotification('Could not get remote information', 'error');
            }
        } catch (error) {
            showNotification(`Error: ${error.message}`, 'error');
        }
    });

    document.getElementById('github-issues-btn')?.addEventListener('click', async () => {
        if (!currentProject) {
            showNotification('Please select a project first', 'error');
            return;
        }

        try {
            const remoteResult = await ipcRenderer.invoke('git-remote-list', currentProject.path);
            if (remoteResult.success && remoteResult.output) {
                const match = remoteResult.output.match(/github\.com[:/](.+?)(?:\.git)?(?:\s|$)/);
                if (match) {
                    const repoPath = match[1].replace(/\.git$/, '');
                    const issuesUrl = `https://github.com/${repoPath}/issues`;
                    ipcRenderer.invoke('open-external', issuesUrl);
                    showNotification('Opening GitHub issues page...', 'info');
                } else {
                    showNotification('No GitHub remote found for this repository', 'error');
                }
            } else {
                showNotification('Could not get remote information', 'error');
            }
        } catch (error) {
            showNotification(`Error: ${error.message}`, 'error');
        }
    });

    document.getElementById('github-disconnect-btn')?.addEventListener('click', async () => {
        const confirmed = await requestGitHubDisconnectDecision();
        if (!confirmed) {
            return;
        }

        try {
            await disconnectGitHub();
            await updateGitHubStatus();
            showNotification('GitHub account disconnected', 'success');
        } catch (error) {
            showNotification(`Disconnect error: ${error.message}`, 'error');
        }
    });

    // Advanced Git Operations
    document.getElementById('git-rebase-btn')?.addEventListener('click', async () => {
        if (!currentProject) {
            showNotification('Please select a project first', 'error');
            return;
        }
        showModal('git-rebase-modal');
        await loadBranchesForRebase();
    });

    document.getElementById('confirm-rebase-btn')?.addEventListener('click', async () => {
        const targetBranch = document.getElementById('rebase-branch-select')?.value;
        if (!targetBranch) {
            showNotification('Please select a branch', 'error');
            return;
        }
        if (!currentProject) {
            showNotification('Please select a project first', 'error');
            return;
        }

        await withGitLock(async () => {
            try {
                showNotification('Rebasing...', 'info');
                const result = await ipcRenderer.invoke('git-rebase', currentProject.path, targetBranch);
                if (result.success) {
                    showNotification('Rebase completed successfully', 'success');
                    hideModal('git-rebase-modal');
                    await refreshGitStatus();
                } else {
                    showNotification(`Rebase failed: ${result.error}`, 'error');
                }
            } catch (error) {
                showNotification(`Rebase error: ${error.message}`, 'error');
            }
        });
    });

    document.getElementById('git-cherry-pick-btn')?.addEventListener('click', () => {
        if (!currentProject) {
            showNotification('Please select a project first', 'error');
            return;
        }
        showModal('git-cherry-pick-modal');
    });

    document.getElementById('confirm-cherry-pick-btn')?.addEventListener('click', async () => {
        const commitHash = document.getElementById('cherry-pick-commit')?.value;
        const noCommit = document.getElementById('cherry-pick-no-commit')?.checked || false;

        if (!commitHash || !commitHash.trim()) {
            showNotification('Please enter a commit hash', 'error');
            return;
        }
        if (!currentProject) {
            showNotification('Please select a project first', 'error');
            return;
        }

        await withGitLock(async () => {
            try {
                showNotification('Cherry picking commit...', 'info');
                const result = await ipcRenderer.invoke('git-cherry-pick', currentProject.path, commitHash.trim(), noCommit);
                if (result.success) {
                    showNotification('Commit cherry-picked successfully', 'success');
                    hideModal('git-cherry-pick-modal');
                    await refreshGitStatus();
                } else {
                    showNotification(`Cherry pick failed: ${result.error}`, 'error');
                }
            } catch (error) {
                showNotification(`Cherry pick error: ${error.message}`, 'error');
            }
        });
    });

    document.getElementById('git-tags-btn')?.addEventListener('click', async () => {
        if (!currentProject) {
            showNotification('Please select a project first', 'error');
            return;
        }
        showModal('git-tags-modal');
        await loadGitTags();
    });

    document.getElementById('create-tag-btn')?.addEventListener('click', () => {
        document.getElementById('create-tag-form').style.display = 'block';
    });

    document.getElementById('cancel-tag-btn')?.addEventListener('click', () => {
        document.getElementById('create-tag-form').style.display = 'none';
        document.getElementById('new-tag-name').value = '';
        document.getElementById('new-tag-message').value = '';
    });

    document.getElementById('confirm-tag-btn')?.addEventListener('click', async () => {
        const tagName = document.getElementById('new-tag-name')?.value;
        const message = document.getElementById('new-tag-message')?.value || '';
        const pushToRemote = document.getElementById('tag-push-remote')?.checked || false;

        if (!tagName || !tagName.trim()) {
            showNotification('Please enter a tag name', 'error');
            return;
        }
        if (!currentProject) {
            showNotification('Please select a project first', 'error');
            return;
        }

        await withGitLock(async () => {
            try {
                showNotification('Creating tag...', 'info');
                const result = await ipcRenderer.invoke('git-tag-create', currentProject.path, tagName.trim(), message, pushToRemote);
                if (result.success) {
                    showNotification('Tag created successfully', 'success');
                    const form = document.getElementById('create-tag-form');
                    if (form) form.style.display = 'none';
                    await loadGitTags();
                } else {
                    showNotification(`Tag creation failed: ${result.error}`, 'error');
                }
            } catch (error) {
                showNotification(`Tag creation error: ${error.message}`, 'error');
            }
        });
    });

    document.getElementById('git-reset-btn')?.addEventListener('click', () => {
        if (!currentProject) {
            showNotification('Please select a project first', 'error');
            return;
        }
        showModal('git-reset-modal');
    });

    document.getElementById('confirm-reset-btn')?.addEventListener('click', async () => {
        const target = document.getElementById('reset-target')?.value;
        const modeEl = document.querySelector('input[name="reset-mode"]:checked');
        const mode = modeEl ? modeEl.value : 'mixed';

        if (!target || !target.trim()) {
            showNotification('Please enter a reset target', 'error');
            return;
        }
        if (!currentProject) {
            showNotification('Please select a project first', 'error');
            return;
        }

        if (mode === 'hard') {
            const confirmed = confirm('Hard reset will permanently discard all changes. Are you sure?');
            if (!confirmed) return;
        }

        await withGitLock(async () => {
            try {
                showNotification('Resetting...', 'info');
                const result = await ipcRenderer.invoke('git-reset', currentProject.path, target.trim(), mode);
                if (result.success) {
                    showNotification('Reset completed successfully', 'success');
                    hideModal('git-reset-modal');
                    await refreshGitStatus();
                } else {
                    showNotification(`Reset failed: ${result.error}`, 'error');
                }
            } catch (error) {
                showNotification(`Reset error: ${error.message}`, 'error');
            }
        });
    });

    document.getElementById('git-revert-btn')?.addEventListener('click', async () => {
        if (!currentProject) {
            showNotification('Please select a project first', 'error');
            return;
        }
        const commitHash = prompt('Enter commit hash to revert:');
        if (!commitHash || !commitHash.trim()) return;

        await withGitLock(async () => {
            try {
                showNotification('Reverting commit...', 'info');
                const result = await ipcRenderer.invoke('git-revert', currentProject.path, commitHash.trim());
                if (result.success) {
                    showNotification('Commit reverted successfully', 'success');
                    await refreshGitStatus();
                } else {
                    showNotification(`Revert failed: ${result.error}`, 'error');
                }
            } catch (error) {
                showNotification(`Revert error: ${error.message}`, 'error');
            }
        });
    });

    document.getElementById('git-clean-btn')?.addEventListener('click', async () => {
        if (!currentProject) {
            showNotification('Please select a project first', 'error');
            return;
        }

        const confirmed = confirm('This will remove all untracked files. Are you sure?');
        if (!confirmed) return;

        await withGitLock(async () => {
            try {
                showNotification('Cleaning repository...', 'info');
                const result = await ipcRenderer.invoke('git-clean', currentProject.path, true, true);
                if (result.success) {
                    showNotification('Repository cleaned successfully', 'success');
                    await refreshGitStatus();
                } else {
                    showNotification(`Clean failed: ${result.error}`, 'error');
                }
            } catch (error) {
                showNotification(`Clean error: ${error.message}`, 'error');
            }
        });
    });

    // Initialize GitHub status on load
    updateGitHubStatus();

    // Listen for file watcher updates
    ipcRenderer.on('git-status-changed', async (event, projectPath) => {
        try {
            if (currentProject && currentProject.path === projectPath) {
                await refreshGitStatus();
            }
        } catch (error) {
            console.error('[GIT] File watcher refresh error:', error);
        }
    });

    // Listen for git history updates
    ipcRenderer.on('git-history-updated', (event, history) => {
        // Update undo button state based on history
        const undoBtn = document.getElementById('git-undo-btn');
        if (undoBtn && Array.isArray(history)) {
            undoBtn.disabled = history.length === 0;
            const lastOp = history.length > 0 ? history[0] : null;
            undoBtn.title = lastOp && lastOp.type
                ? `Undo: ${lastOp.type} - ${lastOp.message || ''}`
                : 'No operations to undo';
        }
    });

    // Undo button handler
    document.getElementById('git-undo-btn')?.addEventListener('click', async () => {
        if (!currentProject) {
            showNotification('No project selected', 'error');
            return;
        }

        await withGitLock(async () => {
            try {
                const result = await ipcRenderer.invoke('undo-last-operation');
                if (result.success) {
                    showNotification('Operation undone successfully', 'success');
                    await refreshGitStatus();
                } else {
                    showNotification(`Undo failed: ${result.error}`, 'error');
                }
            } catch (error) {
                showNotification(`Undo error: ${error.message}`, 'error');
            }
        });
    });
}

async function openGitHubUploadModal() {
    if (!currentProject) {
        showNotification('Please select a project first', 'error');
        return false;
    }

    showModal('github-upload-modal');
    const modalElement = document.getElementById('github-upload-modal');
    if (modalElement) {
        modalElement.scrollTop = 0;
    }

    const modalBody = document.querySelector('#github-upload-modal .np-body');
    if (modalBody) {
        modalBody.scrollTop = 0;
    }

    const repoNameInput = document.getElementById('github-repo-name');
    if (repoNameInput) {
        repoNameInput.disabled = false;
        repoNameInput.readOnly = false;
        repoNameInput.removeAttribute('disabled');
        repoNameInput.removeAttribute('readonly');
        repoNameInput.value = suggestGitHubRepoName(currentProject.name || '');
        repoNameInput.focus({ preventScroll: true });
        const cursorPosition = repoNameInput.value.length;
        repoNameInput.setSelectionRange(cursorPosition, cursorPosition);
    }

    githubUploadSearchQuery = '';
    githubUploadInProgress = false;
    githubUploadLoadingCandidates = true;
    githubUploadLastResultSuccessful = null;
    githubUploadCandidates = [];
    githubUploadNodeMap = new Map();
    githubUploadRootNodes = [];
    githubUploadExpandedPaths = new Set();

    const searchInput = document.getElementById('gh-upload-search');
    if (searchInput) {
        searchInput.value = '';
    }

    const progressOverlay = document.getElementById('gh-upload-progress');
    if (progressOverlay) {
        progressOverlay.classList.remove('active');
    }
    setGitHubUploadProgressMode(false);

    const closeBtn = document.getElementById('gh-result-close');
    if (closeBtn) {
        closeBtn.textContent = 'Done';
        closeBtn.classList.remove('retry');
    }

    updateGitHubUploadSubmitState();
    await loadGitHubUploadCandidates(currentProject.path);

    if (repoNameInput && document.activeElement === document.body) {
        repoNameInput.focus({ preventScroll: true });
        const cursorPosition = repoNameInput.value.length;
        repoNameInput.setSelectionRange(cursorPosition, cursorPosition);
    }
    return true;
}

function suggestGitHubRepoName(rawName) {
    let candidate = typeof rawName === 'string' ? rawName.trim() : '';
    if (!candidate) {
        return 'project-manager';
    }

    candidate = candidate
        .replace(/\s+/g, '-')
        .replace(/[^A-Za-z0-9._-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[.-]+/, '')
        .replace(/[.-]+$/, '');

    if (!candidate) {
        return 'project-manager';
    }

    return candidate.slice(0, GITHUB_REPO_NAME_MAX_LENGTH);
}

function validateGitHubRepoNameInput(rawValue) {
    const sourceValue = typeof rawValue === 'string' ? rawValue : '';
    const normalized = sourceValue.trim();

    if (!normalized) {
        return {
            valid: false,
            normalized: '',
            message: 'Repository name is required.'
        };
    }

    if (normalized.length > GITHUB_REPO_NAME_MAX_LENGTH) {
        return {
            valid: false,
            normalized,
            message: `Repository name must be ${GITHUB_REPO_NAME_MAX_LENGTH} characters or fewer.`
        };
    }

    if (normalized.startsWith('.') || normalized.endsWith('.')) {
        return {
            valid: false,
            normalized,
            message: 'Repository name cannot start or end with a period.'
        };
    }

    if (!GITHUB_REPO_NAME_PATTERN.test(normalized)) {
        return {
            valid: false,
            normalized,
            message: 'Use only letters, numbers, periods, underscores, and hyphens.'
        };
    }

    return {
        valid: true,
        normalized,
        message: 'Repository name looks good.'
    };
}

function updateGitHubRepoNameHint(validation, options = {}) {
    const { forceError = false } = options;
    const repoInput = document.getElementById('github-repo-name');
    const hintEl = document.getElementById('github-repo-name-hint');
    const resolvedValidation = validation || validateGitHubRepoNameInput(repoInput?.value || '');

    if (repoInput) {
        repoInput.classList.remove('gh-repo-valid', 'gh-repo-invalid');
    }

    let hintState = 'neutral';
    let hintText = 'Use 1-100 characters: letters, numbers, ".", "_" or "-".';
    const hasInput = Boolean(repoInput?.value.trim());

    if (resolvedValidation.valid) {
        hintState = 'valid';
        hintText = resolvedValidation.message;
        repoInput?.classList.add('gh-repo-valid');
    } else if (hasInput || forceError) {
        hintState = 'invalid';
        hintText = resolvedValidation.message || 'Repository name is invalid.';
        repoInput?.classList.add('gh-repo-invalid');
    }

    if (hintEl) {
        hintEl.textContent = hintText;
        hintEl.dataset.state = hintState;
    }

    return resolvedValidation;
}

function getGitHubUploadSubmitReadiness(repoValidation) {
    const validation = repoValidation || validateGitHubRepoNameInput(document.getElementById('github-repo-name')?.value || '');
    const selectedPathCount = collectGitHubUploadPathspecs().length;

    if (githubUploadInProgress) {
        return {
            canSubmit: false,
            reason: 'Upload is currently in progress.',
            validation,
            selectedPathCount
        };
    }

    if (githubUploadLoadingCandidates) {
        return {
            canSubmit: false,
            reason: 'Scanning project files...',
            validation,
            selectedPathCount
        };
    }

    if (!currentProject) {
        return {
            canSubmit: false,
            reason: 'No project selected.',
            validation,
            selectedPathCount
        };
    }

    if (!validation.valid) {
        return {
            canSubmit: false,
            reason: validation.message || 'Repository name is invalid.',
            validation,
            selectedPathCount
        };
    }

    if (selectedPathCount === 0) {
        return {
            canSubmit: false,
            reason: 'Select at least one file or folder to upload.',
            validation,
            selectedPathCount
        };
    }

    return {
        canSubmit: true,
        reason: '',
        validation,
        selectedPathCount
    };
}

function updateGitHubUploadSubmitState() {
    const confirmBtn = document.getElementById('confirm-github-upload-btn');
    if (!confirmBtn) {
        return;
    }

    const validation = updateGitHubRepoNameHint();
    const readiness = getGitHubUploadSubmitReadiness(validation);
    confirmBtn.disabled = !readiness.canSubmit;
    confirmBtn.title = readiness.canSubmit
        ? 'Create repository and upload selected files'
        : (readiness.reason || 'Complete all required fields to continue');
}

function initializeGitHubUploadPickerUi() {
    if (githubUploadUiInitialized) {
        return;
    }
    githubUploadUiInitialized = true;

    const searchInput = document.getElementById('gh-upload-search');
    const sortFieldSelect = document.getElementById('gh-upload-sort-field');
    const sortDirectionBtn = document.getElementById('gh-upload-sort-direction');
    const selectAllBtn = document.getElementById('gh-upload-select-all');
    const selectNoneBtn = document.getElementById('gh-upload-select-none');
    const refreshBtn = document.getElementById('gh-upload-refresh');
    const treeContainer = document.getElementById('gh-upload-tree');

    searchInput?.addEventListener('input', () => {
        githubUploadSearchQuery = searchInput.value.trim().toLowerCase();
        applyGitHubUploadFilter();
        renderGitHubUploadTree();
    });

    sortFieldSelect?.addEventListener('change', () => {
        githubUploadSortField = sortFieldSelect.value || 'name';
        sortGitHubUploadTree();
        renderGitHubUploadTree();
    });

    sortDirectionBtn?.addEventListener('click', () => {
        githubUploadSortDirection = githubUploadSortDirection === 'asc' ? 'desc' : 'asc';
        updateGitHubSortDirectionUi();
        sortGitHubUploadTree();
        renderGitHubUploadTree();
    });

    selectAllBtn?.addEventListener('click', () => {
        setGitHubUploadSelectionForAll(true);
        renderGitHubUploadTree();
    });

    selectNoneBtn?.addEventListener('click', () => {
        setGitHubUploadSelectionForAll(false);
        renderGitHubUploadTree();
    });

    refreshBtn?.addEventListener('click', async () => {
        if (!githubUploadActiveProjectPath) {
            return;
        }
        await loadGitHubUploadCandidates(githubUploadActiveProjectPath);
    });

    treeContainer?.addEventListener('click', (event) => {
        const expandBtn = event.target.closest('.gh-file-expand-btn');
        if (expandBtn) {
            const targetPath = expandBtn.dataset.path || '';
            if (!targetPath) {
                return;
            }

            if (githubUploadExpandedPaths.has(targetPath)) {
                githubUploadExpandedPaths.delete(targetPath);
            } else {
                githubUploadExpandedPaths.add(targetPath);
            }
            renderGitHubUploadTree();
            return;
        }

        const row = event.target.closest('.gh-file-row[data-path]');
        if (!row || event.target.closest('.gh-file-check')) {
            return;
        }

        const nodePath = row.dataset.path || '';
        const node = githubUploadNodeMap.get(nodePath);
        if (!node || node.type !== 'directory') {
            return;
        }

        if (githubUploadExpandedPaths.has(nodePath)) {
            githubUploadExpandedPaths.delete(nodePath);
        } else {
            githubUploadExpandedPaths.add(nodePath);
        }
        renderGitHubUploadTree();
    });

    treeContainer?.addEventListener('change', (event) => {
        const checkbox = event.target.closest('.gh-file-check-input');
        if (!checkbox) {
            return;
        }

        const nodePath = checkbox.dataset.path || '';
        const node = githubUploadNodeMap.get(nodePath);
        if (!node) {
            return;
        }

        setGitHubUploadNodeSelection(node, checkbox.checked);
        updateGitHubUploadAncestorStates(node.parentPath);
        renderGitHubUploadTree();
    });

    treeContainer?.addEventListener('wheel', (event) => {
        if (!treeContainer) {
            return;
        }

        const canScroll = treeContainer.scrollHeight > treeContainer.clientHeight + 1;
        if (!canScroll) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }

        const atTop = treeContainer.scrollTop <= 0;
        const atBottom = treeContainer.scrollTop + treeContainer.clientHeight >= treeContainer.scrollHeight - 1;
        if ((event.deltaY < 0 && atTop) || (event.deltaY > 0 && atBottom)) {
            event.preventDefault();
        }
        event.stopPropagation();
    }, { passive: false });

    updateGitHubSortDirectionUi();
}

async function loadGitHubUploadCandidates(projectPath) {
    const treeContainer = document.getElementById('gh-upload-tree');
    const summaryEl = document.getElementById('gh-upload-selection-summary');

    if (!treeContainer) {
        githubUploadLoadingCandidates = false;
        updateGitHubUploadSubmitState();
        return;
    }

    githubUploadActiveProjectPath = projectPath || '';
    githubUploadLoadingCandidates = true;
    updateGitHubUploadSubmitState();

    treeContainer.innerHTML = `
        <div class="gh-file-state loading">
            <i class="fas fa-spinner fa-spin"></i>
            <span>Scanning project files...</span>
        </div>
    `;
    if (summaryEl) {
        summaryEl.textContent = 'Loading project structure...';
    }

    try {
        const result = await ipcRenderer.invoke('github-list-upload-candidates', projectPath);
        if (!result || !result.success) {
            throw new Error(result?.error || 'Unable to scan files for upload');
        }

        githubUploadCandidates = Array.isArray(result.items) ? result.items : [];
        buildGitHubUploadTree(githubUploadCandidates);
        applyGitHubUploadFilter();
        renderGitHubUploadTree();

        if (result.truncated) {
            showNotification('Large project detected: file list truncated for performance', 'warning');
        }
    } catch (error) {
        githubUploadCandidates = [];
        githubUploadNodeMap = new Map();
        githubUploadRootNodes = [];
        githubUploadExpandedPaths = new Set();
        treeContainer.innerHTML = `
            <div class="gh-file-state error">
                <i class="fas fa-exclamation-triangle"></i>
                <span>${escapeHtml(error.message || 'Failed to load upload candidates')}</span>
            </div>
        `;
        if (summaryEl) {
            summaryEl.textContent = 'Unable to load file selection.';
        }
    } finally {
        githubUploadLoadingCandidates = false;
        updateGitHubUploadSubmitState();
    }
}

function shouldGitHubUploadNodeBeSelectedByDefault(pathValue, type, size) {
    const normalizedPath = typeof pathValue === 'string'
        ? pathValue.replace(/\\/g, '/').trim()
        : '';
    if (!normalizedPath) {
        return false;
    }

    const segments = normalizedPath.split('/').map((segment) => segment.toLowerCase());
    if (segments.some((segment) => GITHUB_UPLOAD_DEFAULT_EXCLUDED_DIRS.has(segment))) {
        return false;
    }

    if (type === 'file' && Number(size) > GITHUB_UPLOAD_AUTO_DESELECT_FILE_SIZE_BYTES) {
        return false;
    }

    return true;
}

function syncGitHubUploadDirectorySelection(node) {
    if (!node || node.type !== 'directory') {
        return;
    }

    node.children.forEach((child) => {
        if (child.type === 'directory') {
            syncGitHubUploadDirectorySelection(child);
        }
    });

    if (node.children.length === 0) {
        node.selected = false;
        node.indeterminate = false;
        return;
    }

    const allSelected = node.children.every((child) => child.selected && !child.indeterminate);
    const anySelected = node.children.some((child) => child.selected || child.indeterminate);
    node.selected = allSelected;
    node.indeterminate = !allSelected && anySelected;
}

function buildGitHubUploadTree(items) {
    githubUploadNodeMap = new Map();
    githubUploadRootNodes = [];
    githubUploadExpandedPaths = new Set();

    for (const item of items) {
        const normalizedPath = typeof item.path === 'string'
            ? item.path.replace(/\\/g, '/').trim()
            : '';
        if (!normalizedPath) {
            continue;
        }

        const parentPath = typeof item.parentPath === 'string'
            ? item.parentPath.replace(/\\/g, '/').trim()
            : '';

        githubUploadNodeMap.set(normalizedPath, {
            path: normalizedPath,
            parentPath,
            name: item.name || normalizedPath.split('/').pop() || normalizedPath,
            type: item.type === 'directory' ? 'directory' : 'file',
            size: Number(item.size) || 0,
            mtimeMs: Number(item.mtimeMs) || 0,
            children: [],
            selected: shouldGitHubUploadNodeBeSelectedByDefault(
                normalizedPath,
                item.type === 'directory' ? 'directory' : 'file',
                Number(item.size) || 0
            ),
            indeterminate: false,
            visible: true,
            fileCount: item.type === 'directory' ? 0 : 1,
            totalSize: Number(item.size) || 0
        });
    }

    for (const node of githubUploadNodeMap.values()) {
        if (node.parentPath && githubUploadNodeMap.has(node.parentPath)) {
            githubUploadNodeMap.get(node.parentPath).children.push(node);
        } else {
            githubUploadRootNodes.push(node);
        }
    }

    for (const rootNode of githubUploadRootNodes) {
        computeGitHubUploadNodeAggregates(rootNode);
        if (rootNode.type === 'directory') {
            syncGitHubUploadDirectorySelection(rootNode);
        }
        if (rootNode.type === 'directory') {
            githubUploadExpandedPaths.add(rootNode.path);
        }
    }

    sortGitHubUploadTree();
}

function sortGitHubUploadTree() {
    const sortRecursive = (nodes) => {
        nodes.sort(compareGitHubUploadNodes);
        nodes.forEach((node) => {
            if (node.children.length > 0) {
                sortRecursive(node.children);
            }
        });
    };

    sortRecursive(githubUploadRootNodes);
}

function compareGitHubUploadNodes(a, b) {
    if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
    }

    const direction = githubUploadSortDirection === 'desc' ? -1 : 1;
    const field = githubUploadSortField;
    let valueA;
    let valueB;

    if (field === 'size') {
        valueA = a.type === 'directory' ? a.totalSize : a.size;
        valueB = b.type === 'directory' ? b.totalSize : b.size;
        if (valueA !== valueB) {
            return direction * (valueA - valueB);
        }
    } else if (field === 'modified') {
        valueA = a.mtimeMs || 0;
        valueB = b.mtimeMs || 0;
        if (valueA !== valueB) {
            return direction * (valueA - valueB);
        }
    } else if (field === 'type') {
        const extA = a.type === 'directory' ? 'directory' : getFileExtension(a.name);
        const extB = b.type === 'directory' ? 'directory' : getFileExtension(b.name);
        const extCompare = extA.localeCompare(extB, undefined, { numeric: true, sensitivity: 'base' });
        if (extCompare !== 0) {
            return direction * extCompare;
        }
    }

    return direction * a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

function computeGitHubUploadNodeAggregates(node) {
    if (node.type === 'file') {
        node.fileCount = 1;
        node.totalSize = Number(node.size) || 0;
        return;
    }

    let totalFiles = 0;
    let totalSize = 0;
    let latestMtime = Number(node.mtimeMs) || 0;
    node.children.forEach((child) => {
        computeGitHubUploadNodeAggregates(child);
        totalFiles += child.fileCount;
        totalSize += child.totalSize;
        latestMtime = Math.max(latestMtime, Number(child.mtimeMs) || 0);
    });

    node.fileCount = totalFiles;
    node.totalSize = totalSize;
    node.mtimeMs = latestMtime;
}

function applyGitHubUploadFilter() {
    const query = githubUploadSearchQuery;

    const applyVisibility = (node) => {
        const selfMatch = !query || node.name.toLowerCase().includes(query) || node.path.toLowerCase().includes(query);
        let childMatch = false;
        node.children.forEach((child) => {
            if (applyVisibility(child)) {
                childMatch = true;
            }
        });

        node.visible = selfMatch || childMatch;
        if (query && childMatch && node.type === 'directory') {
            githubUploadExpandedPaths.add(node.path);
        }
        return node.visible;
    };

    githubUploadRootNodes.forEach((rootNode) => {
        applyVisibility(rootNode);
    });
}

function renderGitHubUploadTree() {
    const treeContainer = document.getElementById('gh-upload-tree');
    if (!treeContainer) {
        return;
    }

    if (githubUploadNodeMap.size === 0) {
        treeContainer.innerHTML = `
            <div class="gh-file-state empty">
                <i class="fas fa-folder-open"></i>
                <span>No files found in this project folder.</span>
            </div>
        `;
        updateGitHubUploadSummary();
        updateGitHubUploadSubmitState();
        return;
    }

    const rows = [];
    collectGitHubUploadRows(githubUploadRootNodes, 0, rows);

    if (rows.length === 0) {
        treeContainer.innerHTML = `
            <div class="gh-file-state empty">
                <i class="fas fa-search"></i>
                <span>No files match your current filter.</span>
            </div>
        `;
        updateGitHubUploadSummary();
        updateGitHubUploadSubmitState();
        return;
    }

    treeContainer.innerHTML = rows.map((row) => {
        const node = row.node;
        const canExpand = node.type === 'directory';
        const isExpanded = canExpand && githubUploadExpandedPaths.has(node.path);
        const checkedAttr = node.selected && !node.indeterminate ? 'checked' : '';
        const indeterminateAttr = node.indeterminate ? 'true' : 'false';
        const folderMeta = `${node.fileCount} file${node.fileCount === 1 ? '' : 's'} | ${formatBytesForDisplay(node.totalSize)}`;
        const fileMeta = `${formatBytesForDisplay(node.size)} | ${formatTimestampForDisplay(node.mtimeMs)}`;

        return `
            <div class="gh-file-row ${node.type}" data-path="${escapeHtml(node.path)}" style="--gh-depth:${row.depth};">
                <button type="button" class="gh-file-expand-btn ${canExpand ? '' : 'placeholder'} ${isExpanded ? 'expanded' : ''}" data-path="${escapeHtml(node.path)}" ${canExpand ? '' : 'tabindex="-1" aria-hidden="true"'}>
                    <i class="fas fa-chevron-right"></i>
                </button>
                <label class="gh-file-check ${node.indeterminate ? 'indeterminate' : ''}" title="Select for upload">
                    <input class="gh-file-check-input" type="checkbox" data-path="${escapeHtml(node.path)}" ${checkedAttr} data-indeterminate="${indeterminateAttr}" />
                    <span class="gh-file-checkmark"></span>
                </label>
                <div class="gh-file-icon">
                    <i class="${escapeHtml(getGitHubUploadNodeIcon(node, isExpanded))}"></i>
                </div>
                <div class="gh-file-text">
                    <span class="gh-file-name">${escapeHtml(node.name)}</span>
                    <span class="gh-file-path">${escapeHtml(node.path)}</span>
                </div>
                <div class="gh-file-meta">${escapeHtml(node.type === 'directory' ? folderMeta : fileMeta)}</div>
            </div>
        `;
    }).join('');

    treeContainer.querySelectorAll('.gh-file-check-input[data-indeterminate="true"]').forEach((input) => {
        input.indeterminate = true;
    });

    updateGitHubUploadSummary();
    updateGitHubUploadSubmitState();
}

function collectGitHubUploadRows(nodes, depth, rows) {
    nodes.forEach((node) => {
        if (!node.visible) {
            return;
        }

        rows.push({ node, depth });
        if (node.type === 'directory' && githubUploadExpandedPaths.has(node.path)) {
            collectGitHubUploadRows(node.children, depth + 1, rows);
        }
    });
}

function setGitHubUploadSelectionForAll(selected) {
    githubUploadRootNodes.forEach((rootNode) => {
        setGitHubUploadNodeSelection(rootNode, selected);
    });
}

function setGitHubUploadNodeSelection(node, selected) {
    node.selected = selected;
    node.indeterminate = false;
    node.children.forEach((child) => {
        setGitHubUploadNodeSelection(child, selected);
    });
}

function updateGitHubUploadAncestorStates(parentPath) {
    let cursor = parentPath;
    while (cursor && githubUploadNodeMap.has(cursor)) {
        const parentNode = githubUploadNodeMap.get(cursor);
        const children = parentNode.children;
        if (children.length === 0) {
            parentNode.selected = false;
            parentNode.indeterminate = false;
        } else {
            const allSelected = children.every((child) => child.selected && !child.indeterminate);
            const anySelected = children.some((child) => child.selected || child.indeterminate);
            parentNode.selected = allSelected;
            parentNode.indeterminate = !allSelected && anySelected;
        }
        cursor = parentNode.parentPath;
    }
}

function updateGitHubUploadSummary() {
    const summaryEl = document.getElementById('gh-upload-selection-summary');
    if (!summaryEl) {
        return;
    }

    const selectedPathspecs = collectGitHubUploadPathspecs();
    let selectedFileCount = 0;
    let selectedBytes = 0;
    githubUploadNodeMap.forEach((node) => {
        if (node.type === 'file' && node.selected) {
            selectedFileCount += 1;
            selectedBytes += Number(node.size) || 0;
        }
    });

    summaryEl.textContent = `${selectedPathspecs.length} item${selectedPathspecs.length === 1 ? '' : 's'} selected | ${selectedFileCount} file${selectedFileCount === 1 ? '' : 's'} | ${formatBytesForDisplay(selectedBytes)}`;
}

function collectGitHubUploadPathspecs() {
    if (githubUploadNodeMap.size === 0) {
        return [];
    }

    const pathspecs = [];
    const nodes = Array.from(githubUploadNodeMap.values())
        .filter((node) => node.selected && !node.indeterminate)
        .sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));

    for (const node of nodes) {
        if (!hasSelectedGitHubUploadAncestor(node.path)) {
            pathspecs.push(node.path);
        }
    }

    return pathspecs;
}

function hasSelectedGitHubUploadAncestor(nodePath) {
    let cursor = githubUploadNodeMap.get(nodePath)?.parentPath;
    while (cursor && githubUploadNodeMap.has(cursor)) {
        const ancestor = githubUploadNodeMap.get(cursor);
        if (ancestor.selected && !ancestor.indeterminate) {
            return true;
        }
        cursor = ancestor.parentPath;
    }
    return false;
}

function getGitHubUploadNodeIcon(node, isExpanded) {
    if (node.type === 'directory') {
        return isExpanded ? 'fas fa-folder-open' : 'fas fa-folder';
    }

    const extension = getFileExtension(node.name);
    if (['js', 'ts', 'tsx', 'jsx'].includes(extension)) {
        return 'fas fa-file-code';
    }
    if (['json', 'yml', 'yaml', 'toml', 'ini'].includes(extension)) {
        return 'fas fa-file-alt';
    }
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'].includes(extension)) {
        return 'fas fa-file-image';
    }
    if (['zip', 'tar', 'gz', '7z'].includes(extension)) {
        return 'fas fa-file-archive';
    }
    if (['md', 'txt', 'log'].includes(extension)) {
        return 'fas fa-file-alt';
    }
    return 'fas fa-file';
}

function getFileExtension(filename) {
    const index = filename.lastIndexOf('.');
    if (index <= 0 || index === filename.length - 1) {
        return '';
    }
    return filename.slice(index + 1).toLowerCase();
}

function formatBytesForDisplay(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) {
        return `${value} B`;
    }
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = value / 1024;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index += 1;
    }
    const precision = size >= 100 ? 0 : size >= 10 ? 1 : 2;
    return `${size.toFixed(precision)} ${units[index]}`;
}

function formatTimestampForDisplay(timestamp) {
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
        return 'Unknown';
    }
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
        return 'Unknown';
    }
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function updateGitHubSortDirectionUi() {
    const sortDirectionBtn = document.getElementById('gh-upload-sort-direction');
    if (!sortDirectionBtn) {
        return;
    }
    const isAsc = githubUploadSortDirection === 'asc';
    sortDirectionBtn.dataset.direction = githubUploadSortDirection;
    sortDirectionBtn.title = isAsc ? 'Sort ascending' : 'Sort descending';
    sortDirectionBtn.innerHTML = isAsc
        ? '<i class="fas fa-sort-amount-down-alt"></i>'
        : '<i class="fas fa-sort-amount-up-alt"></i>';
}

// Git Helper Functions

async function loadProjectsIntoDropdown() {
    let projects;
    try {
        projects = await ipcRenderer.invoke('get-projects');
    } catch (error) {
        console.error('[GIT] Failed to load projects:', error);
        return;
    }
    const menuBody = document.getElementById('git-projects-menu-body');
    if (!menuBody) return;

    if (!projects || projects.length === 0) {
        menuBody.innerHTML = `
            <div class="git-projects-menu-empty">
                <i class="fas fa-folder-open"></i>
                <p>No projects found</p>
                <small>Create a project or clone a repository to get started</small>
            </div>
        `;
        return;
    }

    menuBody.innerHTML = projects.map(project => {
        const isActive = currentProject && currentProject.path === project.path;
        const safeProjectPath = escapeHtml(project.path || '');
        const safeProjectName = escapeHtml(project.name || '');
        const safeProjectType = escapeHtml(project.type || '');

        return `
            <div class="git-projects-menu-item ${isActive ? 'active' : ''}" data-path="${safeProjectPath}" data-name="${safeProjectName}">
                <i class="fas fa-folder"></i>
                <div class="git-projects-menu-item-content">
                    <span class="git-projects-menu-item-name">${safeProjectName}</span>
                    <span class="git-projects-menu-item-path">${safeProjectPath}</span>
                </div>
                ${project.type ? `<span class="git-projects-menu-item-badge">${safeProjectType}</span>` : ''}
            </div>
        `;
    }).join('');

    // Add click handlers
    document.querySelectorAll('.git-projects-menu-item').forEach(item => {
        item.addEventListener('click', async () => {
            const itemPath = item.dataset.path;
            const name = item.dataset.name;
            if (!itemPath || !name) return;

            currentProject = { name, path: itemPath };
            updateSelectedProject();

            try {
                // Start file watcher for real-time updates
                await ipcRenderer.invoke('start-file-watcher', itemPath);
            } catch (error) {
                console.error('[GIT] Failed to start file watcher:', error);
            }

            await refreshGitStatus();
            const menu = document.getElementById('git-projects-menu');
            const btn = document.getElementById('git-project-dropdown-btn');
            if (menu) menu.classList.remove('show');
            if (btn) btn.classList.remove('active');
        });
    });
}

function filterProjectsInDropdown(query) {
    const items = document.querySelectorAll('.git-projects-menu-item');
    const lowerQuery = (query || '').toLowerCase();

    items.forEach(item => {
        const name = (item.dataset.name || '').toLowerCase();
        const itemPath = (item.dataset.path || '').toLowerCase();

        if (name.includes(lowerQuery) || itemPath.includes(lowerQuery)) {
            item.style.display = 'flex';
        } else {
            item.style.display = 'none';
        }
    });
}

function updateSelectedProject() {
    const nameEl = document.getElementById('git-selected-project-name');
    const pathEl = document.getElementById('git-selected-project-path');

    if (!currentProject) {
        if (nameEl) nameEl.textContent = 'No repository selected';
        if (pathEl) pathEl.textContent = 'Select a project to manage';
        setStatusProjectName(null);
        setStatusGitBranch('--');

        // Clear status badges
        const badgesContainer = document.getElementById('git-repo-status-badges');
        if (badgesContainer) {
            badgesContainer.innerHTML = '';
        }
        return;
    }

    if (nameEl) nameEl.textContent = currentProject.name;
    if (pathEl) pathEl.textContent = currentProject.path;
    setStatusProjectName(currentProject.name);
    void refreshStatusBranch();

    // Add file watcher badge
    const badgesContainer = document.getElementById('git-repo-status-badges');
    if (badgesContainer) {
        badgesContainer.innerHTML = `
            <div class="git-status-badge watching" title="Real-time file monitoring active">
                <i class="fas fa-eye"></i>
                <span>Watching</span>
            </div>
        `;
    }
}

async function updateGitHubStatus() {
    let result;
    try {
        result = await ipcRenderer.invoke('github-get-user');
    } catch (error) {
        console.error('[GitHub] Failed to get user status:', error);
        return;
    }

    const statusDiv = document.getElementById('github-status');
    const actionsDiv = document.getElementById('github-actions');
    if (!statusDiv || !actionsDiv) {
        updateGitHubLoginModalState();
        return;
    }

    if (result.success && result.user) {
        githubUserData = result.user;
        githubLastSyncedAt = new Date();
        updateGitHubAvatar();
        setStatusConnectionState(true);
        const safeLogin = escapeHtml(result.user.login || 'Unknown');
        const safeEmail = escapeHtml(result.user.email || 'No email');
        statusDiv.innerHTML = `
            <div class="github-connected">
                <div class="github-connected-identity">
                    <div class="github-connected-icon">
                        <i class="fab fa-github"></i>
                    </div>
                    <div class="github-user-info">
                        <div class="github-connection-badge">
                            <i class="fas fa-check-circle"></i>
                            <span>Connected</span>
                        </div>
                        <div class="github-username">@${safeLogin}</div>
                        <div class="github-email">${safeEmail}</div>
                    </div>
                </div>
                <button class="github-disconnect-btn" id="github-disconnect-btn-inline">
                    <i class="fas fa-unlink"></i> Disconnect
                </button>
            </div>
        `;
        actionsDiv.style.display = 'flex';
        const placeholder = document.getElementById('github-actions-placeholder');
        if (placeholder) placeholder.style.display = 'none';

        // Add disconnect handler (fresh element each time innerHTML is set, so no leak)
        document.getElementById('github-disconnect-btn-inline')?.addEventListener('click', async () => {
            const confirmed = await requestGitHubDisconnectDecision();
            if (!confirmed) {
                return;
            }

            try {
                await disconnectGitHub();
                await updateGitHubStatus();
                showNotification('GitHub account disconnected', 'success');
            } catch (error) {
                showNotification(`Disconnect error: ${error.message}`, 'error');
            }
        });
    } else {
        githubUserData = null;
        githubLastSyncedAt = null;
        updateGitHubAvatar();
        setStatusConnectionState(false);
        statusDiv.innerHTML = `
            <div class="github-not-connected">
                <div class="github-empty-state">
                    <div class="github-empty-hero">
                        <div class="github-empty-icon-wrap">
                            <i class="fab fa-github"></i>
                        </div>
                        <h4 class="github-empty-title">Connect your GitHub account</h4>
                        <p class="github-empty-subtitle">Create repositories, publish branches, open pull requests, and track issues without leaving AppManager.</p>
                    </div>
                    <div class="github-empty-benefits">
                        <span class="github-empty-benefit"><i class="fas fa-rocket"></i> Fast repository setup</span>
                        <span class="github-empty-benefit"><i class="fas fa-code-branch"></i> PR and branch workflow</span>
                        <span class="github-empty-benefit"><i class="fas fa-shield-alt"></i> Secure token storage</span>
                    </div>
                    <button class="github-connect-cta" id="github-connect-status-btn">
                        <span class="btn-icon"><i class="fab fa-github"></i></span>
                        <span>Connect Account</span>
                    </button>
                    <small class="github-connect-hint">Supports classic and fine-grained personal access tokens.</small>
                </div>
            </div>
        `;
        actionsDiv.style.display = 'none';
        const placeholderEl = document.getElementById('github-actions-placeholder');
        if (placeholderEl) placeholderEl.style.display = '';

        // Add connect handler
        document.getElementById('github-connect-status-btn')?.addEventListener('click', () => {
            openGitHubLoginModal();
        });
    }

    updateGitHubLoginModalState();
    updateGitHubSyncMeta();
}

async function loadBranchesForRebase() {
    if (!currentProject) return;

    const result = await ipcRenderer.invoke('git-branches', currentProject.path);
    const select = document.getElementById('rebase-branch-select');

    if (!select || !result.success || !result.output) return;

    const branches = result.output
        .split('\n')
        .filter(b => b.trim() && !b.trim().startsWith('*'))
        .map(b => b.replace('*', '').trim().replace(/^remotes\//, ''));

    select.innerHTML = '<option value="">Select a branch...</option>' +
        branches.map(branch =>
            `<option value="${escapeHtml(branch)}">${escapeHtml(branch)}</option>`
        ).join('');
}

async function loadGitTags() {
    if (!currentProject) return;

    let result;
    try {
        result = await ipcRenderer.invoke('git-tag-list', currentProject.path);
    } catch (error) {
        showNotification(`Failed to load tags: ${error.message}`, 'error');
        return;
    }
    const tagsList = document.getElementById('git-tags-list');
    if (!tagsList) return;

    if (!result.success || !result.output || result.output.trim() === '') {
        tagsList.innerHTML = `
            <div class="tags-empty">
                <i class="fas fa-tag"></i>
                <p>No tags found</p>
            </div>
        `;
        return;
    }

    const tags = result.output.split('\n').filter(line => line.trim());
    tagsList.innerHTML = tags.map(tag => {
        const parts = tag.split(/\s+/);
        const tagName = parts[0];
        const tagMessage = parts.slice(1).join(' ') || 'No message';
        const encodedTagName = encodeURIComponent(tagName);

        return `
            <div class="tag-item">
                <div class="tag-item-info">
                    <div class="tag-item-name">${escapeHtml(tagName)}</div>
                    <div class="tag-item-message">${escapeHtml(tagMessage)}</div>
                </div>
                <div class="tag-item-actions">
                    <button class="btn-icon" onclick="deleteTag(decodeURIComponent('${encodedTagName}'))" title="Delete tag">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

async function deleteTag(tagName) {
    if (!currentProject) {
        showNotification('No project selected', 'error');
        return;
    }
    const confirmed = confirm(`Delete tag "${tagName}"?`);
    if (!confirmed) return;

    const deleteFromRemote = confirm('Also delete from remote?');
    try {
        const result = await ipcRenderer.invoke('git-tag-delete', currentProject.path, tagName, deleteFromRemote);
        if (result.success) {
            showNotification('Tag deleted successfully', 'success');
            await loadGitTags();
        } else {
            showNotification(`Failed to delete tag: ${result.error}`, 'error');
        }
    } catch (error) {
        showNotification(`Delete tag error: ${error.message}`, 'error');
    }
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('git-projects-menu');
    const btn = document.getElementById('git-project-dropdown-btn');

    if (dropdown && btn && !dropdown.contains(e.target) && !btn.contains(e.target)) {
        dropdown.classList.remove('show');
        btn.classList.remove('active');
    }
});

// Git Tabs Functionality
let gitStatusNeedsRefresh = false;
let currentGitTab = 'overview';

function initializeGitTabs() {
    const tabs = document.querySelectorAll('.git-tab');
    const panels = document.querySelectorAll('.git-tab-panel');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const targetTab = tab.dataset.tab;
            currentGitTab = targetTab;

            // Remove active class from all tabs and panels
            tabs.forEach(t => t.classList.remove('active'));
            panels.forEach(p => p.classList.remove('active'));

            // Add active class to clicked tab and corresponding panel
            tab.classList.add('active');
            const targetPanel = document.getElementById(`git-tab-${targetTab}`);
            if (targetPanel) {
                targetPanel.classList.add('active');
            }

            // If switching to changes tab and refresh is pending, do it now
            if (targetTab === 'changes' && gitStatusNeedsRefresh) {
                requestAnimationFrame(() => {
                    refreshGitStatusNow();
                });
            }
        });
    });
}

// ============================================
// EXTENSIONS - PREMIUM REDESIGN
// ============================================

// Sample marketplace extension data — themes include full CSS so they actually work
const MARKETPLACE_EXTENSIONS = [
    // ── THEMES (install as type:'themes' with real CSS) ──
    {
        id: 'synthwave-84', displayName: 'SynthWave \'84', description: 'Retro-futuristic neon theme inspired by the music and aesthetics of the 1980s',
        author: 'Robb Owen', version: '1.2.0', category: 'themes', rating: 4.9, downloads: 3200000, enabled: false, type: 'marketplace',
        installType: 'themes',
        themeCSS: `:root { --bg-primary: #262335; --bg-secondary: #1e1a31; --bg-tertiary: #34294f; --bg-hover: #2f2752; --text-primary: #e0d9f6; --text-secondary: #9d8dc7; --text-highlight: #fff; --accent-primary: #ff7edb; --accent-secondary: #36f9f6; --accent-hover: #e66cc5; --border-color: #4a3a6a; --success: #72f1b8; --warning: #fede5d; --error: #fe4450; --info: #36f9f6; }
.sidebar { background: var(--bg-secondary); } .titlebar { background: var(--bg-secondary); }
.project-card, .extension-card, .ext-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.project-card:hover, .ext-card:hover { border-color: var(--accent-primary); box-shadow: 0 4px 25px rgba(255,126,219,0.2); }
.btn-primary, .ext-btn-primary { background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary)); }
.stat-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.modal-content { background: var(--bg-secondary); border-color: var(--border-color); }`,
        preview: { background: '#262335', accent: '#ff7edb', secondary: '#36f9f6', palette: ['#262335','#ff7edb','#36f9f6','#72f1b8','#fede5d','#fe4450'] },
        tags: ['dark','neon','retro','synthwave']
    },
    {
        id: 'ayu-dark', displayName: 'Ayu Dark', description: 'A simple, bright and elegant theme with carefully selected warm colors',
        author: 'Ayu', version: '3.0.0', category: 'themes', rating: 4.7, downloads: 1800000, enabled: false, type: 'marketplace',
        installType: 'themes',
        themeCSS: `:root { --bg-primary: #0b0e14; --bg-secondary: #0d1017; --bg-tertiary: #131721; --bg-hover: #161b26; --text-primary: #bfbdb6; --text-secondary: #636a76; --text-highlight: #e6e1cf; --accent-primary: #e6b450; --accent-secondary: #ffb454; --accent-hover: #d9a23d; --border-color: #1c2433; --success: #7fd962; --warning: #e6b450; --error: #d95757; --info: #39bae6; }
.sidebar { background: var(--bg-secondary); } .titlebar { background: var(--bg-secondary); }
.project-card, .extension-card, .ext-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.project-card:hover, .ext-card:hover { border-color: var(--accent-primary); box-shadow: 0 4px 20px rgba(230,180,80,0.15); }
.btn-primary, .ext-btn-primary { background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary)); }
.stat-card { background: var(--bg-tertiary); } .modal-content { background: var(--bg-secondary); }`,
        preview: { background: '#0b0e14', accent: '#e6b450', secondary: '#ffb454', palette: ['#0b0e14','#e6b450','#ffb454','#7fd962','#39bae6','#d95757'] },
        tags: ['dark','warm','minimal','elegant']
    },
    {
        id: 'solarized-dark', displayName: 'Solarized Dark', description: 'Precision colors for machines and people — the classic Solarized palette',
        author: 'Ethan Schoonover', version: '2.0.4', category: 'themes', rating: 4.6, downloads: 2400000, enabled: false, type: 'marketplace',
        installType: 'themes',
        themeCSS: `:root { --bg-primary: #002b36; --bg-secondary: #001e27; --bg-tertiary: #073642; --bg-hover: #0a4050; --text-primary: #839496; --text-secondary: #586e75; --text-highlight: #fdf6e3; --accent-primary: #268bd2; --accent-secondary: #2aa198; --accent-hover: #1a7abc; --border-color: #0d4654; --success: #859900; --warning: #b58900; --error: #dc322f; --info: #2aa198; }
.sidebar { background: var(--bg-secondary); } .titlebar { background: var(--bg-secondary); }
.project-card, .extension-card, .ext-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.project-card:hover, .ext-card:hover { border-color: var(--accent-primary); box-shadow: 0 4px 16px rgba(38,139,210,0.15); }
.btn-primary, .ext-btn-primary { background: var(--accent-primary); }
.stat-card { background: var(--bg-tertiary); } .modal-content { background: var(--bg-secondary); }`,
        preview: { background: '#002b36', accent: '#268bd2', secondary: '#2aa198', palette: ['#002b36','#268bd2','#2aa198','#859900','#b58900','#dc322f'] },
        tags: ['dark','classic','solarized','blue']
    },
    {
        id: 'rose-pine', displayName: 'Rose Pine', description: 'All natural pine, faux fur and a bit of soho vibes for the classy minimalist',
        author: 'Rose Pine', version: '2.8.0', category: 'themes', rating: 4.8, downloads: 1500000, enabled: false, type: 'marketplace',
        installType: 'themes',
        themeCSS: `:root { --bg-primary: #191724; --bg-secondary: #1f1d2e; --bg-tertiary: #26233a; --bg-hover: #2a2740; --text-primary: #e0def4; --text-secondary: #908caa; --text-highlight: #e0def4; --accent-primary: #c4a7e7; --accent-secondary: #ebbcba; --accent-hover: #b094d4; --border-color: #393552; --success: #9ccfd8; --warning: #f6c177; --error: #eb6f92; --info: #31748f; }
.sidebar { background: var(--bg-secondary); } .titlebar { background: var(--bg-secondary); }
.project-card, .extension-card, .ext-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.project-card:hover, .ext-card:hover { border-color: var(--accent-primary); box-shadow: 0 4px 20px rgba(196,167,231,0.15); }
.btn-primary, .ext-btn-primary { background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary)); }
.stat-card { background: var(--bg-tertiary); } .modal-content { background: var(--bg-secondary); }`,
        preview: { background: '#191724', accent: '#c4a7e7', secondary: '#ebbcba', palette: ['#191724','#c4a7e7','#ebbcba','#9ccfd8','#f6c177','#eb6f92'] },
        tags: ['dark','pastel','cozy','rose']
    },
    {
        id: 'everforest-dark', displayName: 'Everforest Dark', description: 'Comfortable and pleasant green-tinted theme designed for long coding sessions',
        author: 'Sainnhe Park', version: '1.4.0', category: 'themes', rating: 4.7, downloads: 980000, enabled: false, type: 'marketplace',
        installType: 'themes',
        themeCSS: `:root { --bg-primary: #2d353b; --bg-secondary: #272e33; --bg-tertiary: #343f44; --bg-hover: #3a464c; --text-primary: #d3c6aa; --text-secondary: #859289; --text-highlight: #e4dcc8; --accent-primary: #a7c080; --accent-secondary: #83c092; --accent-hover: #8fb573; --border-color: #475258; --success: #a7c080; --warning: #dbbc7f; --error: #e67e80; --info: #7fbbb3; }
.sidebar { background: var(--bg-secondary); } .titlebar { background: var(--bg-secondary); }
.project-card, .extension-card, .ext-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.project-card:hover, .ext-card:hover { border-color: var(--accent-primary); box-shadow: 0 4px 16px rgba(167,192,128,0.12); }
.btn-primary, .ext-btn-primary { background: var(--accent-primary); color: #2d353b; }
.stat-card { background: var(--bg-tertiary); } .modal-content { background: var(--bg-secondary); }`,
        preview: { background: '#2d353b', accent: '#a7c080', secondary: '#83c092', palette: ['#2d353b','#a7c080','#83c092','#7fbbb3','#dbbc7f','#e67e80'] },
        tags: ['dark','green','nature','soft']
    },
    {
        id: 'palenight', displayName: 'Palenight', description: 'An elegant and juicy Material-like theme with vivid purple and blue hues',
        author: 'Olaolu Olawuyi', version: '2.1.0', category: 'themes', rating: 4.8, downloads: 2100000, enabled: false, type: 'marketplace',
        installType: 'themes',
        themeCSS: `:root { --bg-primary: #292d3e; --bg-secondary: #232635; --bg-tertiary: #34324a; --bg-hover: #3b3a55; --text-primary: #a6accd; --text-secondary: #676e95; --text-highlight: #ffffff; --accent-primary: #82aaff; --accent-secondary: #c792ea; --accent-hover: #6e99ed; --border-color: #3e3d58; --success: #c3e88d; --warning: #ffcb6b; --error: #ff5370; --info: #89ddff; }
.sidebar { background: var(--bg-secondary); } .titlebar { background: var(--bg-secondary); }
.project-card, .extension-card, .ext-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.project-card:hover, .ext-card:hover { border-color: var(--accent-primary); box-shadow: 0 4px 20px rgba(130,170,255,0.15); }
.btn-primary, .ext-btn-primary { background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary)); }
.stat-card { background: var(--bg-tertiary); } .modal-content { background: var(--bg-secondary); }`,
        preview: { background: '#292d3e', accent: '#82aaff', secondary: '#c792ea', palette: ['#292d3e','#82aaff','#c792ea','#c3e88d','#ffcb6b','#ff5370'] },
        tags: ['dark','material','purple','vibrant']
    },
    // ── PRODUCTIVITY EXTENSIONS (with per-extension settings) ──
    {
        id: 'gitlens', displayName: 'GitLens', description: 'Supercharge Git with blame annotations, code lens, and powerful comparison commands',
        author: 'GitKraken', version: '14.5.0', category: 'productivity', rating: 4.8, downloads: 2500000, enabled: false, type: 'marketplace',
        settings: {
            showInlineBlame: { type: 'toggle', label: 'Show inline blame annotations', default: true },
            showCodeLens: { type: 'toggle', label: 'Show CodeLens above functions', default: true },
            dateFormat: { type: 'select', label: 'Date format', options: ['relative','absolute','short'], default: 'relative' }
        }
    },
    {
        id: 'prettier', displayName: 'Prettier', description: 'Code formatter using prettier with support for many languages',
        author: 'Prettier', version: '10.4.0', category: 'formatters', rating: 4.9, downloads: 8200000, enabled: false, type: 'marketplace',
        settings: {
            formatOnSave: { type: 'toggle', label: 'Format on save', default: true },
            tabWidth: { type: 'select', label: 'Tab width', options: ['2','4','8'], default: '2' },
            useSemicolons: { type: 'toggle', label: 'Use semicolons', default: true },
            singleQuote: { type: 'toggle', label: 'Use single quotes', default: false },
            trailingComma: { type: 'select', label: 'Trailing commas', options: ['none','es5','all'], default: 'es5' }
        }
    },
    {
        id: 'eslint', displayName: 'ESLint', description: 'Integrates ESLint JavaScript into your editor for real-time linting',
        author: 'Microsoft', version: '3.0.5', category: 'linters', rating: 4.7, downloads: 12300000, enabled: false, type: 'marketplace',
        settings: {
            autoFixOnSave: { type: 'toggle', label: 'Auto-fix on save', default: false },
            showInlineErrors: { type: 'toggle', label: 'Show inline error markers', default: true },
            lintOnType: { type: 'toggle', label: 'Lint as you type', default: true }
        }
    },
    {
        id: 'live-server', displayName: 'Live Server', description: 'Launch a development local server with live reload feature for static pages',
        author: 'Ritwick Dey', version: '5.7.9', category: 'productivity', rating: 4.9, downloads: 7400000, enabled: false, type: 'marketplace',
        settings: {
            port: { type: 'select', label: 'Default port', options: ['3000','5500','8080','8000'], default: '5500' },
            autoOpen: { type: 'toggle', label: 'Auto-open browser on start', default: true },
            liveReload: { type: 'toggle', label: 'Enable live reload', default: true }
        }
    },
    {
        id: 'path-intellisense', displayName: 'Path IntelliSense', description: 'Visual Studio Code plugin that autocompletes filenames',
        author: 'Christian Kohler', version: '2.9.0', category: 'productivity', rating: 4.8, downloads: 3900000, enabled: false, type: 'marketplace',
        settings: {
            showHiddenFiles: { type: 'toggle', label: 'Show hidden files', default: false },
            autoSlash: { type: 'toggle', label: 'Auto-append slash after directory', default: true }
        }
    },
    {
        id: 'docker', displayName: 'Docker', description: 'Makes it easy to create, manage, and debug containerized applications',
        author: 'Microsoft', version: '1.28.0', category: 'productivity', rating: 4.7, downloads: 5600000, enabled: false, type: 'marketplace',
        settings: {
            showExplorer: { type: 'toggle', label: 'Show Docker Explorer in sidebar', default: true },
            pruneConfirm: { type: 'toggle', label: 'Confirm before prune', default: true }
        }
    },
    {
        id: 'thunder-client', displayName: 'Thunder Client', description: 'Lightweight REST API client with beautiful UI for testing APIs',
        author: 'Thunder Client', version: '2.15.1', category: 'productivity', rating: 4.8, downloads: 3100000, enabled: false, type: 'marketplace',
        settings: {
            saveToWorkspace: { type: 'toggle', label: 'Save requests to workspace', default: false },
            followRedirects: { type: 'toggle', label: 'Follow redirects', default: true },
            timeout: { type: 'select', label: 'Request timeout (seconds)', options: ['10','30','60','120'], default: '30' }
        }
    },
    {
        id: 'auto-rename-tag', displayName: 'Auto Rename Tag', description: 'Automatically rename paired HTML/XML tags when editing',
        author: 'Jun Han', version: '0.1.10', category: 'productivity', rating: 4.6, downloads: 6800000, enabled: false, type: 'marketplace',
        settings: {
            activateOnLanguage: { type: 'select', label: 'Active for', options: ['html','html+xml','all'], default: 'all' }
        }
    },
    {
        id: 'bracket-colorizer', displayName: 'Bracket Pair Colorizer', description: 'Color matching brackets with distinct colors for easy identification',
        author: 'CoenraadS', version: '2.0.2', category: 'productivity', rating: 4.5, downloads: 4200000, enabled: false, type: 'marketplace',
        settings: {
            showVerticalLine: { type: 'toggle', label: 'Show vertical scope line', default: true },
            highlightActive: { type: 'toggle', label: 'Highlight active bracket pair', default: true }
        }
    },
    {
        id: 'python-ext', displayName: 'Python', description: 'Rich support for Python including IntelliSense, linting, debugging, and Jupyter',
        author: 'Microsoft', version: '2024.2.1', category: 'languages', rating: 4.7, downloads: 9800000, enabled: false, type: 'marketplace',
        settings: {
            linting: { type: 'toggle', label: 'Enable linting', default: true },
            formatting: { type: 'select', label: 'Formatter', options: ['autopep8','black','yapf'], default: 'black' },
            analysisType: { type: 'select', label: 'Analysis type', options: ['off','basic','strict'], default: 'basic' }
        }
    },
    {
        id: 'rust-analyzer', displayName: 'rust-analyzer', description: 'Rust language support with smart code completion, inline errors, and more',
        author: 'rust-lang', version: '0.3.1845', category: 'languages', rating: 4.9, downloads: 2100000, enabled: false, type: 'marketplace',
        settings: {
            checkOnSave: { type: 'toggle', label: 'Run cargo check on save', default: true },
            inlayHints: { type: 'toggle', label: 'Show inlay type hints', default: true },
            cargoFeatures: { type: 'select', label: 'Cargo features', options: ['default','all','none'], default: 'default' }
        }
    },
    {
        id: 'tailwind-css', displayName: 'Tailwind CSS IntelliSense', description: 'Intelligent Tailwind CSS tooling with autocomplete, linting, and hover previews',
        author: 'Tailwind Labs', version: '0.12.1', category: 'productivity', rating: 4.9, downloads: 4500000, enabled: false, type: 'marketplace',
        settings: {
            suggestions: { type: 'toggle', label: 'Enable class suggestions', default: true },
            validate: { type: 'toggle', label: 'Validate class names', default: true },
            hoverPreview: { type: 'toggle', label: 'Show CSS on hover', default: true }
        }
    }
];

// Current extensions state
let currentExtViewMode = 'grid';
let currentExtSort = 'popular';
let currentExtFilter = 'all';
let currentExtSearch = '';
let installedExtensionsCache = [];

function initializeExtensions() {
    // Pill tabs
    document.querySelectorAll('.ext-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.ext-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.ext-tab-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            const content = document.getElementById(`ext-${tab.dataset.extTab}`);
            if (content) content.classList.add('active');

            // Load themes tab content on first click
            if (tab.dataset.extTab === 'themes') {
                renderThemesTab();
            }
            if (tab.dataset.extTab === 'marketplace') {
                renderMarketplaceTab();
            }
        });
    });

    // Search with debounce
    let searchTimeout;
    const searchInput = document.getElementById('extension-search');
    const searchClear = document.getElementById('ext-search-clear');

    searchInput?.addEventListener('input', (e) => {
        currentExtSearch = e.target.value;
        searchClear.style.display = currentExtSearch ? 'flex' : 'none';
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => filterAndRenderActiveTab(), 150);
    });

    searchClear?.addEventListener('click', () => {
        searchInput.value = '';
        currentExtSearch = '';
        searchClear.style.display = 'none';
        filterAndRenderActiveTab();
    });

    // Sort select
    document.getElementById('ext-sort')?.addEventListener('change', (e) => {
        currentExtSort = e.target.value;
        filterAndRenderActiveTab();
    });

    // View toggle
    document.querySelectorAll('.ext-view-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.ext-view-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentExtViewMode = btn.dataset.view;
            document.querySelectorAll('.ext-cards-container').forEach(c => {
                c.classList.remove('grid-view', 'list-view');
                c.classList.add(`${currentExtViewMode}-view`);
            });
            try { localStorage.setItem('ext-view-mode', currentExtViewMode); } catch(e) {}
        });
    });

    // Restore view mode
    try {
        const saved = localStorage.getItem('ext-view-mode');
        if (saved === 'list' || saved === 'grid') {
            currentExtViewMode = saved;
            document.querySelectorAll('.ext-view-btn').forEach(b => {
                b.classList.toggle('active', b.dataset.view === currentExtViewMode);
            });
        }
    } catch(e) {}

    // Filter pills
    document.querySelectorAll('.ext-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            document.querySelectorAll('.ext-pill').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            currentExtFilter = pill.dataset.filter;
            filterAndRenderActiveTab();
        });
    });

    // Category cards
    document.querySelectorAll('.ext-category-card').forEach(card => {
        card.addEventListener('click', () => {
            const cat = card.dataset.category;
            // Switch to marketplace tab with that filter
            document.querySelectorAll('.ext-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.ext-tab-content').forEach(c => c.classList.remove('active'));
            const mpTab = document.querySelector('[data-ext-tab="marketplace"]');
            mpTab?.classList.add('active');
            document.getElementById('ext-marketplace')?.classList.add('active');
            // Set filter
            currentExtFilter = cat;
            document.querySelectorAll('.ext-pill').forEach(p => {
                p.classList.toggle('active', p.dataset.filter === cat);
            });
            renderMarketplaceTab();
        });
    });

    // Refresh
    document.getElementById('refresh-extensions')?.addEventListener('click', () => {
        refreshExtensions();
    });

    // Detail panel close
    document.getElementById('ext-detail-close')?.addEventListener('click', closeExtensionDetail);
    document.getElementById('ext-detail-backdrop')?.addEventListener('click', closeExtensionDetail);

    // Featured install button
    document.querySelector('.ext-featured-install')?.addEventListener('click', (e) => {
        const extId = e.currentTarget.dataset.extId;
        const ext = MARKETPLACE_EXTENSIONS.find(x => x.id === extId);
        if (ext) installMarketplaceExtension(ext);
    });

    // Load initial data
    loadInstalledExtensions();
    updateExtensionStats();
}

// Filter and re-render the currently active tab
function filterAndRenderActiveTab() {
    const activeTab = document.querySelector('.ext-tab.active');
    if (!activeTab) return;
    const tab = activeTab.dataset.extTab;
    if (tab === 'installed') renderInstalledCards();
    else if (tab === 'marketplace') renderMarketplaceTab();
}

// Format download numbers
function formatDownloads(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return String(num);
}

// Render star rating HTML
function renderStarRating(rating) {
    let html = '';
    for (let i = 1; i <= 5; i++) {
        if (rating >= i) html += '<i class="fas fa-star"></i>';
        else if (rating >= i - 0.5) html += '<i class="fas fa-star-half-alt"></i>';
        else html += '<i class="far fa-star"></i>';
    }
    return html;
}

// Get category gradient class
function getCategoryClass(category) {
    const map = {
        'themes': 'cat-themes', 'languages': 'cat-languages', 'snippets': 'cat-snippets',
        'linters': 'cat-linters', 'debuggers': 'cat-debuggers', 'productivity': 'cat-productivity',
        'formatters': 'cat-formatters', 'general': 'cat-general'
    };
    return map[category] || 'cat-general';
}

// Get icon for extension category
function getCategoryIcon(category) {
    const icons = {
        'themes': 'fa-palette', 'languages': 'fa-code', 'snippets': 'fa-file-code',
        'linters': 'fa-check-circle', 'debuggers': 'fa-bug', 'productivity': 'fa-rocket',
        'formatters': 'fa-align-left', 'general': 'fa-puzzle-piece'
    };
    return icons[category] || 'fa-puzzle-piece';
}

// Sort extensions array
function sortExtensions(exts) {
    const sorted = [...exts];
    switch (currentExtSort) {
        case 'popular': sorted.sort((a, b) => (b.downloads || 0) - (a.downloads || 0)); break;
        case 'rating': sorted.sort((a, b) => (b.rating || 0) - (a.rating || 0)); break;
        case 'newest': sorted.sort((a, b) => (b.version || '').localeCompare(a.version || '')); break;
        case 'name': sorted.sort((a, b) => (a.displayName || a.name || '').localeCompare(b.displayName || b.name || '')); break;
    }
    return sorted;
}

// Filter extensions by search + category
function filterExtensions(exts) {
    let filtered = exts;
    if (currentExtFilter && currentExtFilter !== 'all') {
        filtered = filtered.filter(e => e.category === currentExtFilter || e.type === currentExtFilter);
    }
    if (currentExtSearch) {
        const q = currentExtSearch.toLowerCase();
        filtered = filtered.filter(e => {
            const name = (e.displayName || e.name || '').toLowerCase();
            const desc = (e.description || '').toLowerCase();
            const author = (e.author || '').toLowerCase();
            return name.includes(q) || desc.includes(q) || author.includes(q);
        });
    }
    return filtered;
}

// Create extension card DOM element
function createExtensionCard(extension, options = {}) {
    const card = document.createElement('div');
    card.className = 'ext-card';
    card.dataset.extensionId = extension.id;
    card.dataset.type = extension.type || 'installed';
    card.dataset.category = extension.category || 'general';

    if (options.animationDelay) {
        card.style.animationDelay = options.animationDelay;
    }

    const safeName = escapeHtml(extension.displayName || extension.name || 'Unnamed');
    const safeDesc = escapeHtml(extension.description || 'No description available');
    const safeVersion = escapeHtml(extension.version || '1.0.0');
    const safeAuthor = escapeHtml(extension.author || 'Unknown');
    const catClass = getCategoryClass(extension.category);
    const iconClass = getCategoryIcon(extension.category);
    const isInstalled = extension.type === 'installed' || extension.type === 'themes' || extension.type === 'theme' || installedExtensionsCache.some(e => e.id === extension.id);
    const rating = extension.rating || 0;
    const downloads = extension.downloads || 0;

    let actionsHTML = '';
    if (isInstalled && extension.type !== 'marketplace') {
        actionsHTML = `
            <label class="ext-toggle" title="${extension.enabled ? 'Disable' : 'Enable'}">
                <input type="checkbox" ${extension.enabled ? 'checked' : ''} data-toggle-ext="${extension.id}">
                <span class="ext-toggle-slider"></span>
            </label>
            <button class="ext-btn ext-btn-danger" data-action="uninstall" data-ext-id="${extension.id}" title="Uninstall">
                <i class="fas fa-trash"></i>
            </button>
        `;
    } else {
        actionsHTML = `
            <button class="ext-btn ext-btn-primary" data-action="install" data-ext-id="${extension.id}">
                <i class="fas fa-download"></i> Install
            </button>
        `;
    }

    card.innerHTML = `
        <div class="ext-card-header">
            <div class="ext-card-icon ${catClass}">
                <i class="fas ${iconClass}"></i>
            </div>
            <div class="ext-card-title-row">
                <h4 class="ext-card-name">${safeName}</h4>
                <p class="ext-card-author">${safeAuthor}</p>
            </div>
            <div class="ext-card-actions">
                ${actionsHTML}
            </div>
        </div>
        <p class="ext-card-desc">${safeDesc}</p>
        <div class="ext-card-footer">
            <div class="ext-card-meta">
                <span class="ext-meta-version"><i class="fas fa-tag"></i> v${safeVersion}</span>
                ${downloads ? `<span><i class="fas fa-download"></i> ${formatDownloads(downloads)}</span>` : ''}
            </div>
            ${rating ? `<div class="ext-card-rating">${renderStarRating(rating)}<span>${rating}</span></div>` : ''}
        </div>
    `;

    // Toggle switch event
    const toggle = card.querySelector('[data-toggle-ext]');
    if (toggle) {
        toggle.addEventListener('change', async (e) => {
            e.stopPropagation();
            const extId = e.target.dataset.toggleExt;
            const enable = e.target.checked;
            const result = enable
                ? await ipcRenderer.invoke('enable-extension', extId)
                : await ipcRenderer.invoke('disable-extension', extId);
            if (result.success) {
                showNotification(`${safeName} ${enable ? 'enabled' : 'disabled'}`, 'success');
                updateExtensionStats();
            } else {
                e.target.checked = !enable; // revert
                showNotification(`Failed: ${result.error}`, 'error');
            }
        });
    }

    // Uninstall button
    const uninstallBtn = card.querySelector('[data-action="uninstall"]');
    if (uninstallBtn) {
        uninstallBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const extId = e.currentTarget.dataset.extId;
            if (confirm(`Are you sure you want to uninstall ${safeName}?`)) {
                const result = await ipcRenderer.invoke('uninstall-extension', extId);
                if (result.success) {
                    card.style.transition = 'all 0.3s ease';
                    card.style.opacity = '0';
                    card.style.transform = 'scale(0.95)';
                    setTimeout(() => {
                        card.remove();
                        showNotification(`${safeName} uninstalled`, 'success');
                        loadInstalledExtensions();
                    }, 300);
                } else {
                    showNotification(`Failed: ${result.error}`, 'error');
                }
            }
        });
    }

    // Install button
    const installBtn = card.querySelector('[data-action="install"]');
    if (installBtn) {
        installBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await installMarketplaceExtension(extension, installBtn);
        });
    }

    // Card click → open detail panel
    card.addEventListener('click', (e) => {
        if (e.target.closest('.ext-toggle') || e.target.closest('.ext-btn')) return;
        openExtensionDetail(extension);
    });

    return card;
}

// Install a marketplace extension
async function installMarketplaceExtension(ext, btn) {
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Installing...';
    }

    const isTheme = ext.installType === 'themes' || ext.category === 'themes';
    const installType = isTheme ? 'themes' : 'installed';

    const manifest = {
        name: ext.id,
        displayName: ext.displayName || ext.name,
        version: ext.version || '1.0.0',
        description: ext.description || '',
        publisher: ext.author || 'Marketplace',
        category: ext.category || 'general',
        rating: ext.rating,
        downloads: ext.downloads
    };

    const files = {
        'manifest.json': JSON.stringify(manifest, null, 2)
    };

    // Theme extensions: include the CSS file and theme metadata
    if (isTheme && ext.themeCSS) {
        manifest.main = 'theme.css';
        manifest.colors = ext.preview?.palette || [];
        manifest.preview = ext.preview || {};
        files['manifest.json'] = JSON.stringify(manifest, null, 2);
        files['theme.css'] = ext.themeCSS;
    }

    // Non-theme extensions: store settings schema so we can render settings later
    if (ext.settings) {
        manifest.settingsSchema = ext.settings;
        files['manifest.json'] = JSON.stringify(manifest, null, 2);
    }

    const extensionData = {
        id: ext.id,
        name: ext.displayName || ext.name,
        type: installType,
        files: files
    };

    const result = await ipcRenderer.invoke('install-extension', extensionData);

    if (result.success) {
        if (btn) btn.innerHTML = '<i class="fas fa-check"></i> Installed';
        showNotification(`${ext.displayName || ext.name} installed`, 'success');

        // Reload extensions and refresh theme dropdowns
        await loadInstalledExtensions();

        if (isTheme) {
            // Refresh theme list in settings dropdown
            await loadThemeExtensions();
        }

        // Refresh the settings extensions panel if it exists
        renderSettingsExtensionsList();
    } else {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-download"></i> Install';
        }
        showNotification(`Failed: ${result.error}`, 'error');
    }
}

// Render installed extension cards
function renderInstalledCards() {
    const container = document.getElementById('ext-installed-cards');
    const emptyState = document.getElementById('ext-empty-installed');
    if (!container) return;

    let exts = filterExtensions(installedExtensionsCache);
    exts = sortExtensions(exts);

    container.innerHTML = '';
    container.classList.remove('grid-view', 'list-view');
    container.classList.add(`${currentExtViewMode}-view`);

    if (exts.length === 0) {
        container.style.display = 'none';
        if (emptyState) {
            emptyState.style.display = 'block';
            emptyState.querySelector('h3').textContent = currentExtSearch ? 'No extensions found' : 'No extensions installed';
            emptyState.querySelector('p').textContent = currentExtSearch ? 'Try a different search term' : 'Browse the marketplace to discover and install extensions';
        }
        return;
    }

    container.style.display = '';
    if (emptyState) emptyState.style.display = 'none';

    exts.forEach((ext, i) => {
        const card = createExtensionCard(ext, { animationDelay: `${i * 0.05}s` });
        container.appendChild(card);
    });
}

// Render marketplace tab
function renderMarketplaceTab() {
    const container = document.getElementById('ext-marketplace-cards');
    if (!container) return;

    let exts = filterExtensions(MARKETPLACE_EXTENSIONS);
    exts = sortExtensions(exts);

    container.innerHTML = '';
    container.classList.remove('grid-view', 'list-view');
    container.classList.add(`${currentExtViewMode}-view`);

    exts.forEach((ext, i) => {
        const card = createExtensionCard(ext, { animationDelay: `${i * 0.05}s` });
        container.appendChild(card);
    });
}

// Render themes tab (inline, not modal)
function renderThemesTab() {
    const grid = document.getElementById('ext-themes-grid');
    if (!grid) return;

    // Combine themes from THEME_MARKETPLACE (external file) and MARKETPLACE_EXTENSIONS (inline themes)
    const oldThemes = (typeof THEME_MARKETPLACE !== 'undefined') ? THEME_MARKETPLACE : [];
    const newThemes = MARKETPLACE_EXTENSIONS.filter(e => e.category === 'themes' && e.preview);

    // Build a unified list, deduplicating by id
    const seenIds = new Set();
    const allThemes = [];

    // New inline marketplace themes first (they have themeCSS)
    for (const t of newThemes) {
        if (!seenIds.has(t.id)) {
            seenIds.add(t.id);
            allThemes.push({
                id: t.id, displayName: t.displayName, description: t.description,
                author: t.author, version: t.version, rating: t.rating, downloads: t.downloads,
                preview: t.preview, tags: t.tags || [], css: t.themeCSS,
                source: 'marketplace' // installed via installMarketplaceExtension
            });
        }
    }

    // Old THEME_MARKETPLACE themes
    for (const t of oldThemes) {
        if (!seenIds.has(t.id)) {
            seenIds.add(t.id);
            allThemes.push({
                id: t.id, displayName: t.displayName, description: t.description,
                author: t.author, version: t.version, rating: t.rating, downloads: t.downloads,
                preview: t.preview, tags: t.tags || [], css: t.css,
                source: 'legacy' // installed via downloadMarketplaceTheme
            });
        }
    }

    if (allThemes.length === 0) return;

    // Check which are already installed
    const installedIds = new Set(installedExtensionsCache.map(e => e.id));

    grid.innerHTML = allThemes.map((theme, i) => {
        const stars = renderStarRating(theme.rating);
        const isInstalled = installedIds.has(theme.id);
        return `
            <div class="ext-theme-card" style="animation-delay: ${i * 0.05}s" data-theme-id="${theme.id}">
                <div class="ext-theme-preview" style="background: ${theme.preview.background};">
                    <div class="ext-theme-palette">
                        ${theme.preview.palette.map(c => `<div class="ext-theme-swatch" style="background:${c};"></div>`).join('')}
                    </div>
                </div>
                <div class="ext-theme-info">
                    <h3 class="ext-theme-name">${escapeHtml(theme.displayName)}</h3>
                    <p class="ext-theme-desc">${escapeHtml(theme.description)}</p>
                </div>
                <div class="ext-theme-tags">
                    ${(theme.tags || []).slice(0, 3).map(t => `<span class="ext-theme-tag">${t}</span>`).join('')}
                </div>
                <div class="ext-theme-footer">
                    <div class="ext-theme-stats">
                        <span><span class="ext-star-color">${stars}</span> ${theme.rating}</span>
                        <span><i class="fas fa-download"></i> ${formatDownloads(theme.downloads)}</span>
                    </div>
                    <button class="ext-theme-install-btn${isInstalled ? ' installed' : ''}" data-theme-install="${theme.id}" data-theme-source="${theme.source}" ${isInstalled ? 'disabled' : ''}>
                        <i class="fas fa-${isInstalled ? 'check' : 'download'}"></i> ${isInstalled ? 'Installed' : 'Install'}
                    </button>
                </div>
            </div>
        `;
    }).join('');

    // Attach install handlers
    grid.querySelectorAll('[data-theme-install]:not([disabled])').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const themeId = e.currentTarget.dataset.themeInstall;
            const source = e.currentTarget.dataset.themeSource;

            e.currentTarget.disabled = true;
            e.currentTarget.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

            let success = false;
            if (source === 'marketplace') {
                // Install via new flow (writes theme.css + manifest)
                const ext = MARKETPLACE_EXTENSIONS.find(x => x.id === themeId);
                if (ext) {
                    await installMarketplaceExtension(ext, null);
                    success = true;
                }
            } else {
                // Legacy flow
                const theme = oldThemes.find(t => t.id === themeId);
                if (theme) {
                    success = await downloadMarketplaceTheme(theme);
                }
            }

            if (success) {
                e.currentTarget.innerHTML = '<i class="fas fa-check"></i> Installed';
                // Refresh the themes grid to update installed state
                await loadThemeExtensions();
                renderSettingsExtensionsList();
            } else {
                e.currentTarget.disabled = false;
                e.currentTarget.innerHTML = '<i class="fas fa-download"></i> Install';
            }
        });
    });
}

// Open extension detail panel
function openExtensionDetail(ext) {
    const panel = document.getElementById('ext-detail-panel');
    const backdrop = document.getElementById('ext-detail-backdrop');
    if (!panel || !backdrop) return;

    const safeName = escapeHtml(ext.displayName || ext.name || 'Extension');
    const safeAuthor = escapeHtml(ext.author || 'Unknown');
    const safeDesc = escapeHtml(ext.description || 'No description available');
    const catClass = getCategoryClass(ext.category);
    const iconClass = getCategoryIcon(ext.category);

    // Populate
    const iconEl = document.getElementById('ext-detail-icon');
    iconEl.className = `ext-detail-icon ${catClass}`;
    iconEl.innerHTML = `<i class="fas ${iconClass}"></i>`;

    document.getElementById('ext-detail-name').textContent = safeName;
    document.getElementById('ext-detail-author').textContent = `by ${safeAuthor}`;
    document.getElementById('ext-detail-rating').innerHTML = ext.rating ? renderStarRating(ext.rating) : '';
    document.getElementById('ext-detail-version').textContent = `v${ext.version || '1.0.0'}`;
    document.getElementById('ext-detail-downloads').textContent = formatDownloads(ext.downloads || 0);
    document.getElementById('ext-detail-category').textContent = (ext.category || 'general').charAt(0).toUpperCase() + (ext.category || 'general').slice(1);
    document.getElementById('ext-detail-description').textContent = safeDesc;

    // Actions
    const actionsEl = document.getElementById('ext-detail-actions');
    const isInstalled = ext.type === 'installed' || ext.type === 'themes' || ext.type === 'theme' || installedExtensionsCache.some(e => e.id === ext.id);

    if (isInstalled) {
        actionsEl.innerHTML = `
            <button class="ext-btn ext-btn-primary" id="ext-detail-toggle-btn">
                <i class="fas fa-${ext.enabled ? 'pause' : 'play'}"></i> ${ext.enabled ? 'Disable' : 'Enable'}
            </button>
            <button class="ext-btn ext-btn-danger" id="ext-detail-uninstall-btn">
                <i class="fas fa-trash"></i> Uninstall
            </button>
        `;
        document.getElementById('ext-detail-toggle-btn')?.addEventListener('click', async () => {
            const result = ext.enabled
                ? await ipcRenderer.invoke('disable-extension', ext.id)
                : await ipcRenderer.invoke('enable-extension', ext.id);
            if (result.success) {
                showNotification(`${safeName} ${ext.enabled ? 'disabled' : 'enabled'}`, 'success');
                closeExtensionDetail();
                loadInstalledExtensions();
            } else {
                showNotification(`Failed: ${result.error}`, 'error');
            }
        });
        document.getElementById('ext-detail-uninstall-btn')?.addEventListener('click', async () => {
            if (confirm(`Uninstall ${safeName}?`)) {
                const result = await ipcRenderer.invoke('uninstall-extension', ext.id);
                if (result.success) {
                    showNotification(`${safeName} uninstalled`, 'success');
                    closeExtensionDetail();
                    loadInstalledExtensions();
                } else {
                    showNotification(`Failed: ${result.error}`, 'error');
                }
            }
        });
    } else {
        actionsEl.innerHTML = `
            <button class="ext-btn ext-btn-primary" id="ext-detail-install-btn">
                <i class="fas fa-download"></i> Install Extension
            </button>
        `;
        document.getElementById('ext-detail-install-btn')?.addEventListener('click', async () => {
            const btn = document.getElementById('ext-detail-install-btn');
            await installMarketplaceExtension(ext, btn);
        });
    }

    // Show
    panel.classList.add('visible');
    backdrop.classList.add('visible');
}

// Close extension detail panel
function closeExtensionDetail() {
    document.getElementById('ext-detail-panel')?.classList.remove('visible');
    document.getElementById('ext-detail-backdrop')?.classList.remove('visible');
}

// Refresh extensions
async function refreshExtensions() {
    const btn = document.getElementById('refresh-extensions');
    if (btn) {
        btn.disabled = true;
        btn.querySelector('i').className = 'fas fa-sync-alt fa-spin';
    }

    await loadInstalledExtensions();

    setTimeout(() => {
        if (btn) {
            btn.disabled = false;
            btn.querySelector('i').className = 'fas fa-sync-alt';
        }
        showNotification('Extensions refreshed', 'success');
    }, 400);
}

// Load installed extensions from backend
async function loadInstalledExtensions() {
    // Show skeleton while loading
    const container = document.getElementById('ext-installed-cards');
    if (container && installedExtensionsCache.length === 0) {
        container.innerHTML = Array(3).fill(0).map(() => `
            <div class="ext-skeleton">
                <div class="ext-skeleton-row">
                    <div class="ext-skeleton-icon"></div>
                    <div class="ext-skeleton-lines">
                        <div class="ext-skeleton-line"></div>
                        <div class="ext-skeleton-line"></div>
                        <div class="ext-skeleton-line"></div>
                    </div>
                </div>
            </div>
        `).join('');
    }

    try {
        const result = await ipcRenderer.invoke('get-installed-extensions');

        if (result.success && result.extensions) {
            installedExtensionsCache = result.extensions;
        } else {
            installedExtensionsCache = [];
        }
    } catch (error) {
        console.error('Failed to load installed extensions:', error);
        installedExtensionsCache = [];
    }

    renderInstalledCards();
    updateExtensionStats();
    renderSettingsExtensionsList();
}

// Update hero stats and tab badge
function updateExtensionStats() {
    const total = installedExtensionsCache.length;
    const enabled = installedExtensionsCache.filter(e => e.enabled).length;
    const themes = installedExtensionsCache.filter(e => e.type === 'themes' || e.type === 'theme' || e.category === 'themes').length;

    const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    };

    setVal('ext-stat-total', total);
    setVal('ext-stat-enabled', enabled);
    setVal('ext-stat-themes', themes);
    setVal('ext-tab-badge-installed', total);
}

// Legacy compat
function updateExtensionCounts() {
    updateExtensionStats();
}

// ============================================
// SETTINGS > EXTENSIONS — Installed Extension List & Settings Modal
// ============================================

function normalizeSettingsExtensionsFilter(filterValue) {
    const allowed = new Set(['all', 'themes', 'extensions', 'enabled', 'disabled', 'configurable']);
    return allowed.has(filterValue) ? filterValue : 'all';
}

function normalizeSettingsExtensionsSort(sortValue) {
    const allowed = new Set(['name-asc', 'name-desc', 'status', 'type', 'version-desc']);
    return allowed.has(sortValue) ? sortValue : 'name-asc';
}

function parseVersionParts(versionValue) {
    const version = typeof versionValue === 'string' ? versionValue : String(versionValue || '');
    const parts = version.replace(/^v/i, '').match(/\d+/g);
    if (!parts) {
        return [0];
    }
    return parts.map((part) => Number(part) || 0);
}

function compareVersionDescending(leftVersion, rightVersion) {
    const leftParts = parseVersionParts(leftVersion);
    const rightParts = parseVersionParts(rightVersion);
    const maxLength = Math.max(leftParts.length, rightParts.length);
    for (let i = 0; i < maxLength; i += 1) {
        const left = leftParts[i] || 0;
        const right = rightParts[i] || 0;
        if (left !== right) {
            return right - left;
        }
    }
    return 0;
}

function initializeSettingsExtensionsControls() {
    if (settingsExtensionsUiInitialized) {
        return;
    }

    const searchInput = document.getElementById('settings-ext-search');
    const filterSelect = document.getElementById('settings-ext-filter');
    const sortSelect = document.getElementById('settings-ext-sort');
    if (!searchInput || !filterSelect || !sortSelect) {
        return;
    }

    settingsExtensionsUiInitialized = true;
    filterSelect.value = normalizeSettingsExtensionsFilter(settingsExtensionsFilter);
    sortSelect.value = normalizeSettingsExtensionsSort(settingsExtensionsSort);
    searchInput.value = settingsExtensionsSearchQuery;

    searchInput.addEventListener('input', () => {
        settingsExtensionsSearchQuery = searchInput.value.trim().toLowerCase();
        renderSettingsExtensionsList();
    });

    filterSelect.addEventListener('change', () => {
        settingsExtensionsFilter = normalizeSettingsExtensionsFilter(filterSelect.value);
        renderSettingsExtensionsList();
    });

    sortSelect.addEventListener('change', () => {
        settingsExtensionsSort = normalizeSettingsExtensionsSort(sortSelect.value);
        renderSettingsExtensionsList();
    });
}

function updateSettingsExtensionsSummary(model) {
    const summaryEl = document.getElementById('settings-ext-summary');
    if (!summaryEl) {
        return;
    }

    if (!model || model.total === 0) {
        summaryEl.textContent = 'No installed extensions';
        return;
    }

    summaryEl.textContent =
        `${model.visible} of ${model.total} shown | ${model.enabled} enabled | ${model.themes} themes | ${model.configurable} configurable`;
}

function renderSettingsExtensionsList() {
    initializeSettingsExtensionsControls();

    const container = document.getElementById('settings-ext-list');
    if (!container) {
        return;
    }

    const searchInput = document.getElementById('settings-ext-search');
    const filterSelect = document.getElementById('settings-ext-filter');
    const sortSelect = document.getElementById('settings-ext-sort');
    if (searchInput) {
        searchInput.value = settingsExtensionsSearchQuery;
    }
    if (filterSelect) {
        filterSelect.value = normalizeSettingsExtensionsFilter(settingsExtensionsFilter);
    }
    if (sortSelect) {
        sortSelect.value = normalizeSettingsExtensionsSort(settingsExtensionsSort);
    }

    const exts = Array.isArray(installedExtensionsCache) ? installedExtensionsCache : [];
    if (exts.length === 0) {
        updateSettingsExtensionsSummary({ total: 0 });
        container.innerHTML = `
            <div class="settings-ext-empty">
                <i class="fas fa-puzzle-piece"></i>
                <p>No extensions installed yet</p>
            </div>
        `;
        return;
    }

    const currentTheme = document.getElementById('theme-select')?.value || '';
    const models = exts.map((ext) => {
        const isTheme = ext.type === 'theme' || ext.type === 'themes' || ext.category === 'themes';
        const marketplaceExt = MARKETPLACE_EXTENSIONS.find((item) => item.id === ext.id);
        const hasSettings = !isTheme && Boolean(
            (marketplaceExt && marketplaceExt.settings) ||
            (ext.settingsSchema && typeof ext.settingsSchema === 'object')
        );

        return {
            raw: ext,
            id: String(ext.id || ''),
            name: String(ext.displayName || ext.name || ext.id || 'Unknown Extension'),
            description: String(ext.description || '').trim(),
            version: String(ext.version || '1.0.0'),
            isTheme,
            isEnabled: Boolean(ext.enabled),
            isActiveTheme: isTheme && currentTheme === `ext:${ext.id}`,
            hasSettings,
            categoryClass: getCategoryClass(ext.category || 'general'),
            iconClass: getCategoryIcon(ext.category || 'general')
        };
    });

    const query = settingsExtensionsSearchQuery.trim().toLowerCase();
    const filtered = models.filter((model) => {
        if (query) {
            const haystack = `${model.name} ${model.description} ${model.id} ${model.version}`.toLowerCase();
            if (!haystack.includes(query)) {
                return false;
            }
        }

        const filter = normalizeSettingsExtensionsFilter(settingsExtensionsFilter);
        if (filter === 'themes') {
            return model.isTheme;
        }
        if (filter === 'extensions') {
            return !model.isTheme;
        }
        if (filter === 'enabled') {
            return model.isEnabled;
        }
        if (filter === 'disabled') {
            return !model.isEnabled;
        }
        if (filter === 'configurable') {
            return model.hasSettings;
        }
        return true;
    });

    const sortMode = normalizeSettingsExtensionsSort(settingsExtensionsSort);
    filtered.sort((left, right) => {
        if (sortMode === 'name-desc') {
            return right.name.localeCompare(left.name, undefined, { numeric: true, sensitivity: 'base' });
        }
        if (sortMode === 'status') {
            if (left.isEnabled !== right.isEnabled) {
                return left.isEnabled ? -1 : 1;
            }
            return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
        }
        if (sortMode === 'type') {
            if (left.isTheme !== right.isTheme) {
                return left.isTheme ? -1 : 1;
            }
            return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
        }
        if (sortMode === 'version-desc') {
            const versionCompare = compareVersionDescending(left.version, right.version);
            if (versionCompare !== 0) {
                return versionCompare;
            }
            return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
        }
        return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    const summaryModel = {
        total: models.length,
        visible: filtered.length,
        enabled: models.filter((model) => model.isEnabled).length,
        themes: models.filter((model) => model.isTheme).length,
        configurable: models.filter((model) => model.hasSettings).length
    };
    updateSettingsExtensionsSummary(summaryModel);

    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="settings-ext-empty settings-ext-empty-search">
                <i class="fas fa-search"></i>
                <p>No extensions match your current search/filter.</p>
                <button class="btn-secondary" id="settings-ext-clear-filters">
                    <i class="fas fa-rotate-left"></i> Clear Filters
                </button>
            </div>
        `;

        document.getElementById('settings-ext-clear-filters')?.addEventListener('click', () => {
            settingsExtensionsSearchQuery = '';
            settingsExtensionsFilter = 'all';
            settingsExtensionsSort = 'name-asc';
            renderSettingsExtensionsList();
        });
        return;
    }

    container.innerHTML = filtered.map((model) => {
        const safeName = escapeHtml(model.name);
        const safeDesc = escapeHtml(model.description || (model.isTheme ? 'Theme extension' : 'No description provided'));
        const safeVersion = escapeHtml(model.version);
        const safeId = escapeHtml(model.id);

        return `
            <div class="settings-ext-item ${model.isTheme ? 'is-theme' : 'is-extension'} ${model.isEnabled ? 'is-enabled' : 'is-disabled'}" data-ext-id="${safeId}">
                <div class="settings-ext-icon ${model.categoryClass}">
                    <i class="fas ${model.iconClass}"></i>
                </div>
                <div class="settings-ext-info">
                    <div class="settings-ext-name-row">
                        <h4 class="settings-ext-name">${safeName}</h4>
                        <div class="settings-ext-tags">
                            <span class="settings-ext-status ${model.isEnabled ? 'enabled' : 'disabled'}">${model.isEnabled ? 'Enabled' : 'Disabled'}</span>
                            <span class="settings-ext-type-badge ${model.isTheme ? 'theme-badge' : 'ext-badge'}">${model.isTheme ? 'Theme' : 'Extension'}</span>
                            ${model.isActiveTheme ? '<span class="settings-ext-state-badge active-theme">Active Theme</span>' : ''}
                            ${model.hasSettings ? '<span class="settings-ext-state-badge configurable">Configurable</span>' : ''}
                        </div>
                    </div>
                    <p class="settings-ext-desc">${safeDesc}</p>
                    <div class="settings-ext-meta">
                        <span class="settings-ext-id">${safeId}</span>
                        <span class="settings-ext-version">v${safeVersion}</span>
                    </div>
                </div>
                <div class="settings-ext-actions">
                    ${model.isTheme ? `
                        <button class="${model.isActiveTheme ? 'active-theme-btn' : ''}" data-action="apply-theme" data-ext-id="${safeId}" title="${model.isActiveTheme ? 'Theme currently active' : 'Apply this theme'}">
                            <i class="fas fa-${model.isActiveTheme ? 'check' : 'palette'}"></i>
                        </button>
                    ` : `
                        <button data-action="toggle-ext" data-ext-id="${safeId}" data-enable="${model.isEnabled ? 'false' : 'true'}" title="${model.isEnabled ? 'Disable extension' : 'Enable extension'}">
                            <i class="fas fa-${model.isEnabled ? 'pause' : 'play'}"></i>
                        </button>
                    `}
                    ${model.hasSettings ? `
                        <button data-action="ext-settings" data-ext-id="${safeId}" title="Open extension settings">
                            <i class="fas fa-cog"></i>
                        </button>
                    ` : ''}
                    <button class="danger-btn" data-action="uninstall-ext" data-ext-id="${safeId}" title="Uninstall extension">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
        `;
    }).join('');

    container.querySelectorAll('[data-action="apply-theme"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const themeId = btn.dataset.extId;
            const theme = `ext:${themeId}`;
            const themeSelect = document.getElementById('theme-select');
            if (themeSelect) {
                themeSelect.value = theme;
                themeSelect.dispatchEvent(new Event('change', { bubbles: true }));
            } else {
                await applyTheme(theme);
                refreshSettingsDirtyState();
            }
            renderSettingsExtensionsList();
        });
    });

    container.querySelectorAll('[data-action="toggle-ext"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const extId = btn.dataset.extId;
            const shouldEnable = btn.dataset.enable === 'true';
            const ext = installedExtensionsCache.find((item) => item.id === extId);
            const extName = ext?.displayName || ext?.name || extId;

            btn.disabled = true;
            const result = shouldEnable
                ? await ipcRenderer.invoke('enable-extension', extId)
                : await ipcRenderer.invoke('disable-extension', extId);
            if (result.success) {
                showNotification(`${extName} ${shouldEnable ? 'enabled' : 'disabled'}`, 'success');
                await loadInstalledExtensions();
                renderSettingsExtensionsList();
            } else {
                showNotification(`Failed: ${result.error}`, 'error');
                btn.disabled = false;
            }
        });
    });

    container.querySelectorAll('[data-action="ext-settings"]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const extId = btn.dataset.extId;
            openExtensionSettingsModal(extId);
        });
    });

    container.querySelectorAll('[data-action="uninstall-ext"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const extId = btn.dataset.extId;
            const ext = installedExtensionsCache.find((item) => item.id === extId);
            const name = ext?.displayName || ext?.name || extId;
            if (confirm(`Uninstall ${name}?`)) {
                const result = await ipcRenderer.invoke('uninstall-extension', extId);
                if (result.success) {
                    showNotification(`${name} uninstalled`, 'success');
                    await loadInstalledExtensions();
                    await loadThemeExtensions();
                    renderSettingsExtensionsList();
                } else {
                    showNotification(`Failed: ${result.error}`, 'error');
                }
            }
        });
    });
}

// Open the per-extension settings modal
async function openExtensionSettingsModal(extId) {
    const marketplaceExt = MARKETPLACE_EXTENSIONS.find(m => m.id === extId);
    const installedExt = installedExtensionsCache.find(e => e.id === extId);
    const settingsSchema = (marketplaceExt && marketplaceExt.settings)
        ? marketplaceExt.settings
        : (installedExt && installedExt.settingsSchema && typeof installedExt.settingsSchema === 'object'
            ? installedExt.settingsSchema
            : null);
    if (!settingsSchema) {
        showNotification('No configurable settings for this extension', 'info');
        return;
    }

    const extensionSource = marketplaceExt || installedExt || { id: extId };
    const safeName = escapeHtml(extensionSource.displayName || extensionSource.name || extId);
    const safeAuthor = escapeHtml(extensionSource.author || extensionSource.publisher || 'Unknown');
    const catClass = getCategoryClass(extensionSource.category || 'general');
    const iconClass = getCategoryIcon(extensionSource.category || 'general');

    // Load saved settings from backend
    let savedSettings = {};
    try {
        const result = await ipcRenderer.invoke('get-extension-settings', extId);
        if (result && typeof result === 'object' && result.success && result.settings && typeof result.settings === 'object') {
            savedSettings = result.settings;
        } else if (result && typeof result === 'object' && !Array.isArray(result)) {
            savedSettings = result;
        }
    } catch (e) {
        console.error('Failed to load extension settings:', e);
    }

    // Build settings rows
    const schema = settingsSchema;
    let settingsHTML = '';
    for (const [key, config] of Object.entries(schema)) {
        const currentVal = savedSettings[key] !== undefined ? savedSettings[key] : config.default;
        const safeLabel = escapeHtml(config.label);

        if (config.type === 'toggle') {
            settingsHTML += `
                <div class="ext-setting-row">
                    <span class="ext-setting-label">${safeLabel}</span>
                    <label class="ext-toggle">
                        <input type="checkbox" data-setting-key="${key}" ${currentVal ? 'checked' : ''}>
                        <span class="ext-toggle-slider"></span>
                    </label>
                </div>
            `;
        } else if (config.type === 'select') {
            const optionsHTML = config.options.map(opt =>
                `<option value="${escapeHtml(opt)}" ${String(currentVal) === String(opt) ? 'selected' : ''}>${escapeHtml(opt)}</option>`
            ).join('');
            settingsHTML += `
                <div class="ext-setting-row">
                    <span class="ext-setting-label">${safeLabel}</span>
                    <select data-setting-key="${key}">${optionsHTML}</select>
                </div>
            `;
        }
    }

    // Create modal
    const overlay = document.createElement('div');
    overlay.className = 'ext-settings-modal-overlay';
    overlay.innerHTML = `
        <div class="ext-settings-modal">
            <div class="ext-settings-modal-header">
                <div class="settings-ext-icon ${catClass}">
                    <i class="fas ${iconClass}"></i>
                </div>
                <h3>${safeName}<small>by ${safeAuthor}</small></h3>
                <button class="ext-settings-modal-close"><i class="fas fa-times"></i></button>
            </div>
            <div class="ext-settings-modal-body">
                ${settingsHTML}
            </div>
            <div class="ext-settings-modal-footer">
                <button class="ext-settings-cancel-btn">Cancel</button>
                <button class="ext-settings-save-btn"><i class="fas fa-check"></i> Save Settings</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    // Close handlers
    const closeModal = () => overlay.remove();
    overlay.querySelector('.ext-settings-modal-close').addEventListener('click', closeModal);
    overlay.querySelector('.ext-settings-cancel-btn').addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModal();
    });

    // Save handler
    overlay.querySelector('.ext-settings-save-btn').addEventListener('click', async () => {
        const newSettings = {};
        overlay.querySelectorAll('[data-setting-key]').forEach(el => {
            const key = el.dataset.settingKey;
            if (el.type === 'checkbox') {
                newSettings[key] = el.checked;
            } else {
                newSettings[key] = el.value;
            }
        });

        try {
            const result = await ipcRenderer.invoke('save-extension-settings', extId, newSettings);
            if (result.success) {
                showNotification(`${safeName} settings saved`, 'success');
                closeModal();
            } else {
                showNotification(`Failed to save settings: ${result.error}`, 'error');
            }
        } catch (e) {
            showNotification('Failed to save settings', 'error');
        }
    });
}

// Hook: render the settings extensions list when the Extensions settings panel is shown
(function hookSettingsExtPanel() {
    // Wait for DOM, then observe settings category clicks
    const observer = new MutationObserver(() => {
        const navItems = document.querySelectorAll('.settings-category');
        if (navItems.length > 0) {
            observer.disconnect();
            navItems.forEach(item => {
                item.addEventListener('click', () => {
                    if (item.dataset.category === 'extensions') {
                        renderSettingsExtensionsList();
                    }
                });
            });
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
})();

// ============================================
// THEME MARKETPLACE SYSTEM
// ============================================

// Load marketplace themes from external file or inline
const THEME_MARKETPLACE = [
    {
        id: 'monokai-pro',
        displayName: 'Monokai Pro',
        description: 'Beautiful Monokai-inspired dark theme with vibrant syntax highlighting',
        author: 'Monokai',
        version: '2.1.0',
        rating: 4.9,
        downloads: 125340,
        category: 'Dark',
        tags: ['dark', 'vibrant', 'popular', 'pro'],
        preview: {
            background: '#2d2a2e',
            accent: '#ff6188',
            secondary: '#ffd866',
            palette: ['#2d2a2e', '#ff6188', '#ffd866', '#a9dc76', '#78dce8', '#ab9df2']
        },
        css: `:root { --bg-primary: #2d2a2e; --bg-secondary: #221f22; --bg-tertiary: #3a3739; --text-primary: #fcfcfa; --text-secondary: #939293; --accent-primary: #ff6188; --accent-secondary: #ffd866; --border-color: #5b595c; --success: #a9dc76; --warning: #fc9867; --error: #ff6188; --info: #78dce8; }
.sidebar { background: var(--bg-secondary); border-right: 1px solid var(--border-color); }
.titlebar { background: var(--bg-secondary); }
.project-card, .extension-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.project-card:hover, .extension-card:hover { border-color: var(--accent-primary); transform: translateY(-2px); box-shadow: 0 8px 24px rgba(255, 97, 136, 0.15); }
.btn-primary { background: linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%); }`
    },
    // Dracula Official
    {
        id: 'dracula-official',
        displayName: 'Dracula Official',
        description: 'Dark theme with perfect contrast and vibrant colors',
        author: 'Dracula Theme',
        version: '4.0.1',
        rating: 4.8,
        downloads: 234750,
        category: 'Dark',
        tags: ['dark', 'vibrant', 'popular', 'purple'],
        preview: {
            background: '#282a36',
            accent: '#bd93f9',
            secondary: '#ff79c6',
            palette: ['#282a36', '#bd93f9', '#ff79c6', '#50fa7b', '#8be9fd', '#f1fa8c']
        },
        css: `:root { --bg-primary: #282a36; --bg-secondary: #21222c; --bg-tertiary: #343746; --text-primary: #f8f8f2; --text-secondary: #6272a4; --accent-primary: #bd93f9; --accent-secondary: #ff79c6; --border-color: #44475a; --success: #50fa7b; --warning: #f1fa8c; --error: #ff5555; --info: #8be9fd; }
.sidebar { background: var(--bg-secondary); }
.project-card, .extension-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.project-card:hover, .extension-card:hover { border-color: var(--accent-primary); box-shadow: 0 4px 20px rgba(189, 147, 249, 0.2); }`
    },
    // Tokyo Night
    {
        id: 'tokyo-night',
        displayName: 'Tokyo Night',
        description: 'Clean, dark theme inspired by Tokyo nights with neon accents',
        author: 'Tokyo Night',
        version: '1.3.0',
        rating: 4.9,
        downloads: 156240,
        category: 'Dark',
        tags: ['dark', 'blue', 'neon', 'modern'],
        preview: {
            background: '#1a1b26',
            accent: '#7aa2f7',
            secondary: '#bb9af7',
            palette: ['#1a1b26', '#7aa2f7', '#bb9af7', '#9ece6a', '#e0af68', '#f7768e']
        },
        css: `:root { --bg-primary: #1a1b26; --bg-secondary: #16161e; --bg-tertiary: #24283b; --text-primary: #c0caf5; --text-secondary: #565f89; --accent-primary: #7aa2f7; --accent-secondary: #bb9af7; --border-color: #292e42; --success: #9ece6a; --warning: #e0af68; --error: #f7768e; --info: #7dcfff; }
.sidebar { background: var(--bg-secondary); }
.project-card, .extension-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.project-card:hover { border-color: var(--accent-primary); box-shadow: 0 8px 24px rgba(122, 162, 247, 0.2); }`
    }
];

// Download and install marketplace theme
async function downloadMarketplaceTheme(themeData) {
    showNotification(`Downloading ${themeData.displayName}...`, 'info');

    const extensionData = {
        id: themeData.id,
        name: themeData.displayName,
        type: 'themes',
        files: {
            'manifest.json': JSON.stringify({
                name: themeData.id,
                displayName: themeData.displayName,
                version: themeData.version,
                description: themeData.description,
                publisher: themeData.author,
                category: 'themes',
                main: 'theme.css',
                rating: themeData.rating,
                downloads: themeData.downloads,
                preview: themeData.preview,
                colors: themeData.preview?.palette || []
            }, null, 2),
            'theme.css': themeData.css
        }
    };

    const result = await ipcRenderer.invoke('install-extension', extensionData);

    if (result.success) {
        showNotification(`${themeData.displayName} installed successfully!`, 'success');
        await loadThemeExtensions();
        await loadInstalledExtensions();
        return true;
    } else {
        showNotification(`Failed to install ${themeData.displayName}: ${result.error}`, 'error');
        return false;
    }
}

// Show theme marketplace - redirects to themes tab in extensions view
function showThemeMarketplace() {
    // Switch to extensions view and themes tab
    const extView = document.getElementById('extensions-view');
    if (extView) {
        // Activate the extensions view if not already active
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        extView.classList.add('active');
    }
    // Activate themes tab
    document.querySelectorAll('.ext-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.ext-tab-content').forEach(c => c.classList.remove('active'));
    const themesTab = document.querySelector('[data-ext-tab="themes"]');
    if (themesTab) themesTab.classList.add('active');
    const themesContent = document.getElementById('ext-themes');
    if (themesContent) themesContent.classList.add('active');
    renderThemesTab();

    // Legacy: if modal was somehow opened, also handle that
    const modalHTML = `
        <div class="modal" id="theme-marketplace-modal">
            <div class="modal-content" style="max-width: 1200px; height: 80vh; overflow: hidden; display: flex; flex-direction: column;">
                <div class="modal-header">
                    <h2><i class="fas fa-palette"></i> Theme Marketplace</h2>
                    <button class="close-modal" onclick="hideModal('theme-marketplace-modal')">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="modal-body" style="flex: 1; overflow-y: auto; padding: 20px;">
                    <div class="marketplace-search" style="margin-bottom: 20px;">
                        <input type="text" id="marketplace-search" placeholder="Search themes..." style="width: 100%; padding: 12px; border-radius: 8px; border: 1px solid var(--border-color); background: var(--bg-tertiary); color: var(--text-primary);">
                    </div>
                    <div class="marketplace-grid" id="marketplace-themes-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(350px, 1fr)); gap: 20px;">
                        <!-- Themes will be injected here -->
                    </div>
                </div>
            </div>
        </div>
    `;

    // Add modal to page if it doesn't exist
    if (!document.getElementById('theme-marketplace-modal')) {
        document.body.insertAdjacentHTML('beforeend', modalHTML);
    }

    // Populate themes
    const grid = document.getElementById('marketplace-themes-grid');
    grid.innerHTML = THEME_MARKETPLACE.map(theme => createMarketplaceThemeCard(theme)).join('');

    // Add search functionality
    document.getElementById('marketplace-search')?.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        const cards = grid.querySelectorAll('.marketplace-theme-card');
        cards.forEach(card => {
            const text = card.textContent.toLowerCase();
            card.style.display = text.includes(query) ? 'block' : 'none';
        });
    });

    showModal('theme-marketplace-modal');
}

// Create marketplace theme card
function createMarketplaceThemeCard(theme) {
    const stars = '\u2605'.repeat(Math.floor(theme.rating)) + '\u2606'.repeat(5 - Math.floor(theme.rating));

    return `
        <div class="marketplace-theme-card" data-theme-id="${theme.id}" style="
            background: var(--bg-tertiary);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            padding: 20px;
            cursor: pointer;
            transition: all 0.3s ease;
        ">
            <div class="theme-preview" style="
                height: 80px;
                border-radius: 8px;
                background: ${theme.preview.background};
                margin-bottom: 15px;
                position: relative;
                overflow: hidden;
                display: flex;
                align-items: flex-end;
                padding: 10px;
            ">
                <div style="display: flex; gap: 6px;">
                    ${theme.preview.palette.map(color => `
                        <div style="width: 24px; height: 24px; border-radius: 4px; background: ${color}; border: 2px solid rgba(255,255,255,0.2);"></div>
                    `).join('')}
                </div>
            </div>

            <h3 style="margin: 0 0 8px 0; font-size: 18px; color: var(--text-primary);">
                ${theme.displayName}
            </h3>

            <p style="font-size: 13px; color: var(--text-secondary); margin: 0 0 12px 0; line-height: 1.5;">
                ${theme.description}
            </p>

            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                <div style="font-size: 12px; color: var(--text-secondary);">
                    <span style="color: #ffd866;">${stars}</span> ${theme.rating}
                </div>
                <div style="font-size: 12px; color: var(--text-secondary);">
                    <i class="fas fa-download"></i> ${(theme.downloads / 1000).toFixed(1)}k
                </div>
            </div>

            <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 15px;">
                ${theme.tags.slice(0, 3).map(tag => `
                    <span style="
                        background: var(--bg-secondary);
                        color: var(--accent-primary);
                        padding: 4px 10px;
                        border-radius: 12px;
                        font-size: 11px;
                        font-weight: 500;
                    ">${tag}</span>
                `).join('')}
            </div>

            <button class="btn-primary" style="width: 100%; padding: 10px; border-radius: 8px; border: none; cursor: pointer; font-weight: 500;"
                onclick="event.stopPropagation(); installMarketplaceTheme('${theme.id}')">
                <i class="fas fa-download"></i> Install Theme
            </button>
        </div>
    `;
}

// Install marketplace theme by ID
async function installMarketplaceTheme(themeId) {
    const theme = THEME_MARKETPLACE.find(t => t.id === themeId);
    if (theme) {
        const success = await downloadMarketplaceTheme(theme);
        if (success) {
            hideModal('theme-marketplace-modal');
        }
    }
}

// Make functions globally accessible
window.showThemeMarketplace = showThemeMarketplace;
window.installMarketplaceTheme = installMarketplaceTheme;

// Install all marketplace themes (for quick setup)
async function installAllMarketplaceThemes() {
    showNotification('Installing curated themes from marketplace...', 'info');

    let installedCount = 0;
    for (const theme of THEME_MARKETPLACE) {
        const success = await downloadMarketplaceTheme(theme);
        if (success) installedCount++;
    }

    if (installedCount > 0) {
        showNotification(`Successfully installed ${installedCount} themes!`, 'success');
    }
}

// Legacy function - redirects to marketplace
async function installSampleThemes() {
    showThemeMarketplace();
}

// Make globally accessible
window.installAllMarketplaceThemes = installAllMarketplaceThemes;

// Install sample theme extensions for testing (OLD - kept for compatibility)
async function installSampleThemesOld() {
    const themes = [
        {
            id: 'monokai-pro',
            name: 'Monokai Pro',
            description: 'Beautiful Monokai-inspired dark theme',
            css: `
:root {
    --bg-primary: #2d2a2e;
    --bg-secondary: #221f22;
    --bg-tertiary: #3a3739;
    --text-primary: #fcfcfa;
    --text-secondary: #939293;
    --accent-primary: #ff6188;
    --accent-secondary: #ffd866;
    --border-color: #5b595c;
    --success: #a9dc76;
    --warning: #fc9867;
    --error: #ff6188;
    --info: #78dce8;
}

.sidebar {
    background: var(--bg-secondary);
}

.project-card, .extension-card {
    background: var(--bg-tertiary);
    border-color: var(--border-color);
}

.project-card:hover, .extension-card:hover {
    border-color: var(--accent-primary);
}

.btn-primary {
    background: linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%);
}
`
        },
        {
            id: 'dracula',
            name: 'Dracula',
            description: 'Dark theme with vibrant colors',
            css: `
:root {
    --bg-primary: #282a36;
    --bg-secondary: #21222c;
    --bg-tertiary: #343746;
    --text-primary: #f8f8f2;
    --text-secondary: #6272a4;
    --accent-primary: #bd93f9;
    --accent-secondary: #ff79c6;
    --border-color: #44475a;
    --success: #50fa7b;
    --warning: #f1fa8c;
    --error: #ff5555;
    --info: #8be9fd;
}

.sidebar {
    background: var(--bg-secondary);
}

.titlebar {
    background: var(--bg-secondary);
}

.project-card, .extension-card {
    background: var(--bg-tertiary);
    border-color: var(--border-color);
}

.project-card:hover, .extension-card:hover {
    border-color: var(--accent-primary);
    box-shadow: 0 4px 20px rgba(189, 147, 249, 0.2);
}

.btn-primary {
    background: linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%);
}
`
        },
        {
            id: 'nord',
            name: 'Nord',
            description: 'Arctic, north-bluish color palette',
            css: `
:root {
    --bg-primary: #2e3440;
    --bg-secondary: #3b4252;
    --bg-tertiary: #434c5e;
    --text-primary: #eceff4;
    --text-secondary: #d8dee9;
    --accent-primary: #88c0d0;
    --accent-secondary: #81a1c1;
    --border-color: #4c566a;
    --success: #a3be8c;
    --warning: #ebcb8b;
    --error: #bf616a;
    --info: #5e81ac;
}

.sidebar {
    background: var(--bg-secondary);
}

.titlebar {
    background: var(--bg-secondary);
}

.project-card, .extension-card {
    background: var(--bg-tertiary);
    border-color: var(--border-color);
}

.project-card:hover, .extension-card:hover {
    border-color: var(--accent-primary);
}

.btn-primary {
    background: linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%);
}
`
        },
        {
            id: 'solarized-dark',
            name: 'Solarized Dark',
            description: 'Precision colors for machines and people',
            css: `
:root {
    --bg-primary: #002b36;
    --bg-secondary: #073642;
    --bg-tertiary: #0f4b5a;
    --text-primary: #fdf6e3;
    --text-secondary: #93a1a1;
    --accent-primary: #268bd2;
    --accent-secondary: #2aa198;
    --border-color: #586e75;
    --success: #859900;
    --warning: #b58900;
    --error: #dc322f;
    --info: #268bd2;
}

.sidebar {
    background: var(--bg-secondary);
}

.titlebar {
    background: var(--bg-secondary);
}

.project-card, .extension-card {
    background: var(--bg-tertiary);
    border-color: var(--border-color);
}

.btn-primary {
    background: linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%);
}
`
        }
    ];

    let installedCount = 0;
    for (const theme of themes) {
        const extensionData = {
            id: theme.id,
            name: theme.name,
            type: 'themes',
            files: {
                'manifest.json': JSON.stringify({
                    name: theme.id,
                    displayName: theme.name,
                    version: '1.0.0',
                    description: theme.description,
                    publisher: 'Built-in',
                    category: 'themes',
                    main: 'theme.css',
                    colors: {}
                }, null, 2),
                'theme.css': theme.css
            }
        };

        const result = await ipcRenderer.invoke('install-extension', extensionData);
        if (result.success) {
            installedCount++;
        }
    }

    if (installedCount > 0) {
        showNotification(`Installed ${installedCount} sample themes`, 'success');
        await loadThemeExtensions();
        await loadInstalledExtensions();
    }
}

// Make function available globally for testing
window.installSampleThemes = installSampleThemes;

// Command palette
function initializeCommandPalette() {
    const input = document.getElementById('command-palette-input');
    const commandList = document.getElementById('command-list');
    
    input?.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        const items = commandList.querySelectorAll('.command-item');
        
        items.forEach(item => {
            const text = item.textContent.toLowerCase();
            if (text.includes(query)) {
                item.style.display = 'flex';
            } else {
                item.style.display = 'none';
            }
        });
    });
    
    document.querySelectorAll('.command-item').forEach(item => {
        item.addEventListener('click', () => {
            executeCommand(item.dataset.command);
            hideModal('command-palette-modal');
        });
    });
    
    // Handle Enter key in command palette
    input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const visibleItems = commandList.querySelectorAll('.command-item:not([style*="display: none"])');
            if (visibleItems.length > 0) {
                executeCommand(visibleItems[0].dataset.command);
                hideModal('command-palette-modal');
            }
        }
    });
}

// Execute command from command palette
function executeCommand(command) {
    switch(command) {
        case 'new-project':
            showModal('new-project-modal');
            break;
        case 'open-project':
            document.getElementById('open-project-menu').click();
            break;
        case 'search-projects':
            showModal('search-modal');
            break;
        case 'open-terminal':
            document.getElementById('terminal-menu').click();
            break;
        case 'toggle-sidebar':
            toggleSidebar();
            break;
        case 'settings':
            switchView('settings');
            break;
        case 'workspace-snapshot':
            void createWorkspaceSnapshotFromCommand();
            break;
        case 'restore-workspace-snapshot':
            void restoreWorkspaceSnapshotFromCommand();
            break;
        case 'task-profiles':
            void manageTaskProfilesFromCommand();
            break;
        case 'indexed-search':
            void rebuildSearchIndexFromCommand();
            break;
        case 'operation-queue':
            void showOperationQueueModal();
            break;
        case 'conflict-assistant':
            void openConflictAssistant();
            break;
    }
}

async function createWorkspaceSnapshotFromCommand() {
    const name = prompt('Snapshot name (optional):', `Snapshot ${new Date().toLocaleString()}`) || '';
    const result = await ipcRenderer.invoke('create-workspace-snapshot', name);
    if (!result?.success) {
        showNotification(result?.error || 'Failed to create snapshot', 'error');
        return;
    }
    showNotification(`Snapshot created: ${result.snapshot.name}`, 'success');
}

async function restoreWorkspaceSnapshotFromCommand() {
    const listResult = await ipcRenderer.invoke('get-workspace-snapshots');
    if (!listResult?.success || !Array.isArray(listResult.snapshots) || listResult.snapshots.length === 0) {
        showNotification('No snapshots available', 'warning');
        return;
    }

    const optionsText = listResult.snapshots
        .slice(0, 10)
        .map((snapshot, index) => `${index + 1}. ${snapshot.name} (${snapshot.createdAt})`)
        .join('\n');
    const choiceRaw = prompt(`Select snapshot to restore:\n${optionsText}\n\nEnter number:`, '1');
    const choiceIndex = Number(choiceRaw) - 1;
    const selected = listResult.snapshots[choiceIndex];
    if (!selected) {
        showNotification('Snapshot restore cancelled', 'info');
        return;
    }

    const confirmRestore = confirm(`Restore snapshot "${selected.name}"? Current workspace state will be replaced.`);
    if (!confirmRestore) {
        return;
    }

    const restoreResult = await ipcRenderer.invoke('restore-workspace-snapshot', selected.id);
    if (!restoreResult?.success) {
        showNotification(restoreResult?.error || 'Failed to restore snapshot', 'error');
        return;
    }

    await loadSettings();
    await loadWorkspacePath();
    await loadRecentProjects();
    await loadAllProjects();
    showNotification(`Restored snapshot: ${selected.name}`, 'success');
}

async function rebuildSearchIndexFromCommand() {
    showNotification('Building search index...', 'info');
    const result = await ipcRenderer.invoke('build-search-index', workspacePath);
    if (!result?.success) {
        showNotification(result?.error || 'Failed to build search index', 'error');
        return;
    }
    indexedSearchWorkspace = workspacePath || '';
    indexedSearchReady = true;
    indexedSearchBuildInFlight = null;
    showNotification(`Indexed ${result.totalEntries} entries across ${result.projectCount} projects`, 'success');
}

async function manageTaskProfilesFromCommand() {
    if (!currentProject?.path) {
        showNotification('Select a project first', 'warning');
        return;
    }

    const loadResult = await ipcRenderer.invoke('get-project-task-profiles', currentProject.path);
    if (!loadResult?.success) {
        showNotification(loadResult?.error || 'Failed to load task profiles', 'error');
        return;
    }

    const profiles = Array.isArray(loadResult.profiles) ? [...loadResult.profiles] : [];
    const summary = profiles.length
        ? profiles.map((profile, index) => `${index + 1}. ${profile.name} -> ${profile.command}`).join('\n')
        : 'No task profiles yet.';
    const action = prompt(
        `Task profiles for ${currentProject.name}\n\n${summary}\n\nActions:\nadd | run | delete`,
        profiles.length ? 'run' : 'add'
    );

    if (!action) {
        return;
    }

    const normalizedAction = action.trim().toLowerCase();
    if (normalizedAction === 'add') {
        const name = prompt('Task profile name:', 'Custom Task');
        if (!name) return;
        const command = prompt('Command (must match allowed command policy):', 'npm run build');
        if (!command) return;
        profiles.push({
            id: `task-${Date.now()}`,
            name: name.trim(),
            command: command.trim(),
            cwd: '.',
            runOn: 'manual'
        });
        const saveResult = await ipcRenderer.invoke('save-project-task-profile', currentProject.path, profiles);
        if (!saveResult?.success) {
            showNotification(saveResult?.error || 'Failed to save task profile', 'error');
            return;
        }
        showNotification(`Task profile "${name}" saved`, 'success');
        return;
    }

    if (normalizedAction === 'run') {
        if (!profiles.length) {
            showNotification('No task profiles to run', 'warning');
            return;
        }
        const pick = Number(prompt(`Run which profile?\n${summary}\n\nEnter number:`, '1'));
        const selected = profiles[pick - 1];
        if (!selected) {
            showNotification('Invalid profile selection', 'warning');
            return;
        }
        const runResult = await ipcRenderer.invoke('run-project-task-profile', currentProject.path, selected.id);
        if (!runResult?.success) {
            showNotification(runResult?.error || 'Task failed', 'error');
            return;
        }
        showNotification(`Task "${selected.name}" completed`, 'success');
        return;
    }

    if (normalizedAction === 'delete') {
        if (!profiles.length) {
            showNotification('No task profiles to delete', 'warning');
            return;
        }
        const pick = Number(prompt(`Delete which profile?\n${summary}\n\nEnter number:`, '1'));
        if (!Number.isFinite(pick) || pick < 1 || pick > profiles.length) {
            showNotification('Invalid profile selection', 'warning');
            return;
        }
        const [removed] = profiles.splice(pick - 1, 1);
        const saveResult = await ipcRenderer.invoke('save-project-task-profile', currentProject.path, profiles);
        if (!saveResult?.success) {
            showNotification(saveResult?.error || 'Failed to save task profiles', 'error');
            return;
        }
        showNotification(`Removed task profile "${removed.name}"`, 'success');
    }
}

async function showOperationQueueModal() {
    await loadOperationQueue();
    showModal('operation-queue-modal');
}

// Modal functionality
function initializeModals() {
    // Close buttons for all modals
    document.querySelectorAll('.modal-close').forEach(btn => {
        btn.addEventListener('click', () => {
            const modal = btn.closest('.modal');
            if (modal) {
                hideModal(modal.id);
            }
        });
    });
    
    // Close modal on outside click
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                if (modal.id === 'github-upload-modal') {
                    return;
                }
                hideModal(modal.id);
            }
        });
    });
    
    // New project modal
    const cancelBtn = document.getElementById('cancel-project');
    const createBtn = document.getElementById('create-project-btn');
    const browseBtn = document.getElementById('browse-location');

    cancelBtn?.addEventListener('click', () => hideModal('new-project-modal'));
    createBtn?.addEventListener('click', async () => await createProject());

    browseBtn?.addEventListener('click', async () => {
        const selectedPath = await ipcRenderer.invoke('select-folder');
        if (selectedPath) {
            document.getElementById('project-location').value = selectedPath;
        }
    });

    // Custom template dropdown
    initializeTemplateDropdown();
    
    // Search modal
    document.getElementById('search-input')?.addEventListener('input', async (e) => {
        const query = typeof e.target.value === 'string' ? e.target.value : '';
        if (query.trim().length >= 2) {
            await searchProjects(query);
            return;
        }

        const resultsContainer = document.getElementById('search-results');
        if (resultsContainer) {
            resultsContainer.innerHTML = '';
        }
    });
}

// Quick actions
function initializeQuickActions() {
    document.getElementById('new-project-btn')?.addEventListener('click', () => {
        showModal('new-project-modal');
    });
    
    document.getElementById('open-folder-btn')?.addEventListener('click', async () => {
        const selectedPath = await ipcRenderer.invoke('select-folder');
        if (selectedPath) {
            if (normalizeSettings(appSettings).openInVSCode) {
                ipcRenderer.invoke('open-in-vscode', selectedPath);
            } else {
                ipcRenderer.invoke('open-in-explorer', selectedPath);
            }
        }
    });
    
    document.getElementById('clone-repo-btn')?.addEventListener('click', () => {
        if (!ensureProAccess('Git Management')) {
            return;
        }
        showModal('clone-modal');
    });
    
    document.getElementById('create-project')?.addEventListener('click', () => {
        showModal('new-project-modal');
    });
    
    document.getElementById('change-workspace')?.addEventListener('click', async () => {
        const selectedPath = await ipcRenderer.invoke('select-folder');
        if (selectedPath) {
            workspacePath = selectedPath;
            markIndexedSearchStale(workspacePath);
            document.getElementById('workspace-path').textContent = selectedPath;
            refreshStatusBar();
            updateStatusMessage('Workspace changed');
        }
    });
}

// Templates
function initializeTemplates() {
    const templateCards = document.querySelectorAll('.template-card');
    
    templateCards.forEach(card => {
        card.addEventListener('click', () => {
            const template = card.dataset.template;
            showModal('new-project-modal');
            document.getElementById('project-type').value = template;
        });
    });
}

// Keyboard shortcuts
function initializeKeyboardShortcuts() {
    document.addEventListener('keydown', async (e) => {
        const target = e.target;
        const isTypingContext = Boolean(
            target && (
                target.tagName === 'INPUT' ||
                target.tagName === 'TEXTAREA' ||
                target.tagName === 'SELECT' ||
                target.isContentEditable
            )
        );

        // Ctrl+N - New project
        if (e.ctrlKey && e.key === 'n') {
            e.preventDefault();
            showModal('new-project-modal');
        }
        
        // Ctrl+O - Open project
        if (e.ctrlKey && e.key === 'o') {
            e.preventDefault();
            document.getElementById('open-project-menu').click();
        }
        
        // Ctrl+F - Find projects
        if (e.ctrlKey && e.key === 'f') {
            e.preventDefault();
            const settingsView = document.getElementById('settings-view');
            const documentationView = document.getElementById('documentation-view');
            if (settingsView && settingsView.classList.contains('active')) {
                document.getElementById('settings-search')?.focus();
            } else if (documentationView && documentationView.classList.contains('active')) {
                document.getElementById('docs-search')?.focus();
            } else {
                showModal('search-modal');
            }
        }
        
        // Ctrl+S - Save workspace or settings
        if (e.ctrlKey && e.key === 's') {
            e.preventDefault();
            const settingsView = document.getElementById('settings-view');
            if (settingsView && settingsView.classList.contains('active')) {
                await saveSettings();
            } else {
                await saveWorkspace();
            }
        }
        
        // Ctrl+, - Settings
        if (e.ctrlKey && e.key === ',') {
            e.preventDefault();
            const switched = await switchView('settings');
            if (switched) {
                document.querySelector('.sidebar-item[data-view="settings"]')?.focus();
            }
        }

        // F1 - Open Documentation
        if (e.key === 'F1') {
            e.preventDefault();
            const switched = await openDocumentationView();
            if (switched) {
                document.getElementById('docs-search')?.focus();
            }
        }

        if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !isTypingContext) {
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                await navigateViewHistory('back');
                return;
            }
            if (e.key === 'ArrowRight') {
                e.preventDefault();
                await navigateViewHistory('forward');
                return;
            }
        }

        // Alt+1..6 - Sidebar primary navigation
        if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !isTypingContext) {
            const altViewMap = {
                '1': 'dashboard',
                '2': 'projects',
                '3': 'templates',
                '4': 'recent',
                '5': 'git',
                '6': 'extensions'
            };
            const targetView = altViewMap[e.key];

            if (targetView) {
                e.preventDefault();
                const switched = await switchView(targetView);
                if (switched) {
                    document.querySelector(`.sidebar-item[data-view="${targetView}"]`)?.focus();
                }
            }

            if (e.key.toLowerCase() === 'g') {
                e.preventDefault();
                document.getElementById('github-account-btn')?.click();
                document.getElementById('github-account-btn')?.focus();
            }
        }
        
        // Ctrl+B - Toggle sidebar
        if (e.ctrlKey && e.key === 'b') {
            e.preventDefault();
            toggleSidebar();
        }
        
        // Ctrl+Shift+P - Command palette
        if (e.ctrlKey && e.shiftKey && e.key === 'P') {
            e.preventDefault();
            showModal('command-palette-modal');
        }
        
        // Ctrl+` - Terminal
        if (e.ctrlKey && e.key === '`') {
            e.preventDefault();
            document.getElementById('terminal-menu').click();
        }
        
        // F5 - Run project
        if (e.key === 'F5') {
            e.preventDefault();
            await runProject();
        }
        
        // F11 - Fullscreen
        if (e.key === 'F11') {
            e.preventDefault();
            document.getElementById('fullscreen-menu').click();
        }
        
        // Escape - Close modal
        if (e.key === 'Escape') {
            const modals = document.querySelectorAll('.modal.show');
            modals.forEach(modal => {
                hideModal(modal.id);
            });
        }
    });
}

// Create project
async function createProject() {
    const name = document.getElementById('project-name').value.trim();
    const type = document.getElementById('project-type').value;
    const description = document.getElementById('project-description').value.trim();
    const location = document.getElementById('project-location').value || workspacePath;
    const initGit = Boolean(document.getElementById('init-git')?.checked);
    const openInVSCode = Boolean(document.getElementById('open-vscode')?.checked);

    // Validate project name
    const nameValidation = validateProjectName(name);
    if (!nameValidation.valid) {
        showNotification(nameValidation.error, 'error');
        return;
    }

    if (!type) {
        showNotification('Please select a project type', 'error');
        return;
    }

    // Show loading state
    const createBtn = document.getElementById('create-project-btn');
    const originalText = createBtn.innerHTML;
    createBtn.innerHTML = '<span class="spinner"></span> Creating...';
    createBtn.disabled = true;

    try {
        let result;

        // Check if it's one of the new advanced templates
        const advancedTemplates = ['react-app', 'node-api', 'python-app'];
        if (advancedTemplates.includes(type)) {
            // Use the new template system
            result = await ipcRenderer.invoke('create-from-template', type, name, location, {
                initGit,
                openInVSCode
            });
        } else {
            // Use the old project creation system
            result = await ipcRenderer.invoke('create-project', {
                name,
                type,
                description,
                path: location,
                initGit,
                openInVSCode
            });
        }

        if (result.success) {
            // Add to recent projects
            const project = {
                name,
                type,
                description,
                path: result.path,
                createdAt: new Date().toISOString()
            };

            await addToRecentProjects(project);

            showNotification(`Project "${name}" created successfully!`, 'success');
            hideModal('new-project-modal');

            // Clear form
            document.getElementById('project-name').value = '';
            document.getElementById('project-type').value = '';
            document.getElementById('project-description').value = '';
            document.getElementById('project-location').value = '';

            // Reload recent projects
            await loadRecentProjects();

            // Set as current project
            currentProject = project;

            // Reload projects dropdown
            await loadProjectsIntoDropdown();
        } else {
            showNotification(`Failed to create project: ${result.error}`, 'error');
        }
    } catch (error) {
        showNotification(`Error creating project: ${error.message}`, 'error');
    } finally {
        createBtn.innerHTML = originalText;
        createBtn.disabled = false;
    }
}

// Load settings
async function loadSettings() {
    const loadedSettings = await ipcRenderer.invoke('get-settings');
    appSettings = normalizeSettings(loadedSettings);

    // Load theme extensions first so extension themes are available in the selector.
    await loadThemeExtensions();
    await applySettingsToForm(appSettings, { resetDirtyState: true });
    renderSettingsExtensionsList();
    refreshCustomDropdowns();
    await enforceRecentProjectsLimit();
}

// Load theme extensions and add to theme selector
async function loadThemeExtensions() {
    try {
        const result = await ipcRenderer.invoke('get-theme-extensions');

        if (result.success && result.themes) {
            const themeSelect = document.getElementById('theme-select');
            if (!themeSelect) return;

            // Remove existing extension theme options (keep built-in themes)
            const existingOptions = Array.from(themeSelect.options);
            existingOptions.forEach(option => {
                if (option.dataset.isExtension === 'true') {
                    option.remove();
                }
            });

            // Add theme extension options
            result.themes.forEach(theme => {
                const option = document.createElement('option');
                option.value = `ext:${theme.id}`;
                option.textContent = `${theme.name} (Extension)`;
                option.dataset.isExtension = 'true';
                themeSelect.appendChild(option);
            });
        }
    } catch (error) {
        console.error('Failed to load theme extensions:', error);
    }
}

// Save settings with validation
async function saveSettings(options = {}) {
    const { showSuccessDialog = true } = options;
    const saveBtn = document.getElementById('save-settings-btn');

    if (!settingsDirty) {
        updateSaveSettingsButtonState();
        return true;
    }

    if (saveBtn) {
        saveBtn.classList.add('saving');
        saveBtn.disabled = true;
    }

    clearSettingsValidationErrors();
    const previousSettings = normalizeSettings(appSettings);
    const candidateSettings = collectSettingsFromUi();
    const { normalized, errors, warnings } = validateSettingsPayload(candidateSettings);

    if (errors.length > 0) {
        errors.forEach((error) => addSettingValidationError(error.inputId, error.message));
        const firstErrorInput = document.getElementById(errors[0].inputId);
        firstErrorInput?.focus();
        showNotification('Please fix validation errors before saving', 'error');

        if (saveBtn) {
            saveBtn.classList.remove('saving');
            updateSaveSettingsButtonState();
        }
        return false;
    }

    try {
        const payload = normalizeSettings({
            ...previousSettings,
            ...normalized,
            extensions: {
                ...(previousSettings.extensions || {}),
                ...(normalized.extensions || {}),
                autoUpdate: normalized.autoUpdateExtensions,
                updateCheckInterval: normalized.extensionUpdateCheck
            }
        });

        const success = await ipcRenderer.invoke('save-settings', payload);
        if (!success) {
            showNotification('Failed to save settings', 'error');
            return false;
        }

        appSettings = normalizeSettings(payload);
        if (previousSettings.defaultProjectPath !== appSettings.defaultProjectPath) {
            await loadWorkspacePath();
        }
        await applySettingsToForm(appSettings, { resetDirtyState: true });
        renderSettingsExtensionsList();
        await enforceRecentProjectsLimit();

        const changedCount = Math.max(1, countChangedSettings(previousSettings, appSettings));
        if (showSuccessDialog) {
            await showSettingsSavedDialog(changedCount, warnings);
        }
        showNotification('Settings saved successfully', 'success');
        return true;
    } catch (error) {
        console.error('Error saving settings:', error);
        showNotification('An error occurred while saving settings', 'error');
        return false;
    } finally {
        if (saveBtn) {
            saveBtn.classList.remove('saving');
            updateSaveSettingsButtonState();
        }
    }
}

// Apply theme
async function applyTheme(theme) {
    // Remove existing theme classes
    document.body.classList.remove('light-theme', 'high-contrast');

    // Remove existing extension theme style
    const existingExtTheme = document.getElementById('extension-theme-style');
    if (existingExtTheme) {
        existingExtTheme.remove();
    }

    // Check if it's an extension theme
    if (theme && theme.startsWith('ext:')) {
        const themeId = theme.substring(4); // Remove 'ext:' prefix
        await applyExtensionTheme(themeId);
    } else {
        // Built-in themes
        if (theme === 'light') {
            document.body.classList.add('light-theme');
        } else if (theme === 'high-contrast') {
            document.body.classList.add('high-contrast');
        }
    }
}

// Apply extension theme
async function applyExtensionTheme(themeId) {
    try {
        const result = await ipcRenderer.invoke('load-theme-css', themeId);

        if (result.success && result.css) {
            // Create style element
            const style = document.createElement('style');
            style.id = 'extension-theme-style';
            style.textContent = result.css;
            document.head.appendChild(style);

            showNotification(`Theme "${themeId}" applied`, 'success');
        } else {
            showNotification(`Failed to load theme: ${result.error}`, 'error');
            // Fall back to dark theme
            appSettings.theme = 'dark';
            await applyTheme('dark');
        }
    } catch (error) {
        console.error('Failed to apply extension theme:', error);
        showNotification('Failed to apply theme', 'error');
    }
}

// Load workspace path
async function loadWorkspacePath() {
    workspacePath = await ipcRenderer.invoke('get-projects-path');
    markIndexedSearchStale(workspacePath);
    document.getElementById('workspace-path').textContent = workspacePath;
    document.getElementById('project-location').value = workspacePath;
    refreshStatusBar();
}

// Load recent projects
async function importProject() {
    showNotification('Importing project...', 'info');
    const result = await ipcRenderer.invoke('import-project');
    if (result.success) {
        await addToRecentProjects(result.project);
        await loadAllProjects(); // Refresh projects view
        showNotification(`Project "${result.project.name}" imported successfully!`, 'success');

        // Switch to projects view to show the imported project
        if (document.getElementById('welcome-view')?.classList.contains('active')) {
            switchView('projects');
        }
    }
}

function normalizeRecentProjectPath(projectPath) {
    if (!projectPath || typeof projectPath !== 'string') {
        return null;
    }

    return path.resolve(projectPath)
        .toLowerCase()
        .replace(/\\/g, '/')
        .replace(/\/$/, '');
}

function loadFavoriteProjectsState() {
    try {
        const raw = localStorage.getItem(FAVORITE_PROJECTS_STORAGE_KEY);
        if (!raw) {
            favoriteProjects = {};
            return;
        }

        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            favoriteProjects = {};
            return;
        }

        favoriteProjects = Object.fromEntries(
            Object.entries(parsed).filter(([key, value]) => typeof key === 'string' && key && value === true)
        );
    } catch {
        favoriteProjects = {};
    }
}

function saveFavoriteProjectsState() {
    try {
        localStorage.setItem(FAVORITE_PROJECTS_STORAGE_KEY, JSON.stringify(favoriteProjects));
    } catch (error) {
        console.warn('Unable to persist favorite projects:', error);
    }
}

function isFavoriteProject(projectPath) {
    const normalizedPath = normalizeRecentProjectPath(projectPath);
    return Boolean(normalizedPath && favoriteProjects[normalizedPath]);
}

function setProjectFavorite(projectPath, isFavorite) {
    const normalizedPath = normalizeRecentProjectPath(projectPath);
    if (!normalizedPath) return false;

    if (isFavorite) {
        favoriteProjects[normalizedPath] = true;
    } else {
        delete favoriteProjects[normalizedPath];
    }

    saveFavoriteProjectsState();
    return true;
}

function syncFavoriteStateAcrossCards(projectPath) {
    const normalizedPath = normalizeRecentProjectPath(projectPath);
    if (!normalizedPath) {
        return;
    }

    const cards = document.querySelectorAll('.project-card-modern[data-project-path]');
    cards.forEach((card) => {
        const cardPath = normalizeRecentProjectPath(card.dataset.projectPath || '');
        if (cardPath !== normalizedPath) {
            return;
        }

        const isFavorite = isFavoriteProject(projectPath);
        card.dataset.favorite = String(isFavorite);

        const favoriteBtn = card.querySelector('[data-toggle-favorite]');
        if (favoriteBtn) {
            favoriteBtn.classList.toggle('is-active', isFavorite);
            favoriteBtn.title = isFavorite ? 'Remove from favorites' : 'Add to favorites';
            favoriteBtn.setAttribute('aria-label', isFavorite ? 'Remove from favorites' : 'Add to favorites');
            favoriteBtn.innerHTML = `<i class="${isFavorite ? 'fas' : 'far'} fa-star"></i>`;
        }

        const metaRow = card.querySelector('.project-meta');
        if (!metaRow) {
            return;
        }

        const existingFavoritePill = metaRow.querySelector('.project-favorite-pill');
        if (isFavorite && !existingFavoritePill) {
            const pill = document.createElement('span');
            pill.className = 'project-favorite-pill';
            pill.innerHTML = '<i class="fas fa-star"></i> Favorite';
            const timeEl = metaRow.querySelector('.project-time');
            metaRow.insertBefore(pill, timeEl || null);
        } else if (!isFavorite && existingFavoritePill) {
            existingFavoritePill.remove();
        }
    });
}

function moveProjectFavoritePath(oldPath, newPath) {
    const oldKey = normalizeRecentProjectPath(oldPath);
    const newKey = normalizeRecentProjectPath(newPath);

    if (!oldKey || !newKey || oldKey === newKey || favoriteProjects[oldKey] !== true) {
        return;
    }

    favoriteProjects[newKey] = true;
    delete favoriteProjects[oldKey];
    saveFavoriteProjectsState();
}

function compareProjectsForDisplay(a, b) {
    const favoriteA = isFavoriteProject(a.path) ? 1 : 0;
    const favoriteB = isFavoriteProject(b.path) ? 1 : 0;
    if (favoriteA !== favoriteB) {
        return favoriteB - favoriteA;
    }

    return (b.lastAccessed || 0) - (a.lastAccessed || 0);
}

function setSelectedProjectCardByPath(projectPath) {
    const selectedKey = normalizeRecentProjectPath(projectPath);
    const cards = document.querySelectorAll('.project-card-modern[data-project-path]');

    cards.forEach((card) => {
        const cardKey = normalizeRecentProjectPath(card.dataset.projectPath || '');
        card.classList.toggle('is-selected', Boolean(selectedKey) && cardKey === selectedKey);
    });
}

function isGitRepositoryPath(projectPath) {
    if (typeof projectPath !== 'string' || !projectPath.trim()) {
        return false;
    }

    try {
        return fs.existsSync(path.join(projectPath, '.git'));
    } catch {
        return false;
    }
}

function selectProjectFromCard(project, options = {}) {
    if (!project || !project.path) {
        return;
    }

    const normalizedPath = normalizeRecentProjectPath(project.path);
    const currentPath = normalizeRecentProjectPath(currentProject?.path || '');
    const hasChanged = normalizedPath && normalizedPath !== currentPath;

    currentProject = {
        path: project.path,
        name: project.name || 'Untitled Project',
        type: project.type || 'unknown',
        hasGit: project.isGitRepo === true || project.hasGit === true || isGitRepositoryPath(project.path)
    };

    const currentRepo = document.getElementById('git-current-repo');
    if (currentRepo) {
        currentRepo.innerHTML = `
            <p><strong>Project:</strong> ${escapeHtml(currentProject.name)}</p>
            <p><strong>Path:</strong> ${escapeHtml(currentProject.path)}</p>
        `;
    }

    updateStatusBarProject(currentProject.name);
    setSelectedProjectCardByPath(currentProject.path);

    if (options.showNotification) {
        showNotification(`Selected project: ${currentProject.name}`, 'success');
    }

    if (currentView === 'git' && hasChanged && options.refreshGit !== false) {
        refreshGitStatus();
    }
}

async function toggleProjectFavorite(project) {
    if (!project || !project.path) {
        return;
    }

    const nextFavoriteState = !isFavoriteProject(project.path);
    if (!setProjectFavorite(project.path, nextFavoriteState)) {
        return;
    }

    syncFavoriteStateAcrossCards(project.path);
    const sortValue = document.getElementById('project-sort')?.value || 'name';
    displayRecentProjects();
    sortProjects(sortValue, { silent: true });
    setSelectedProjectCardByPath(currentProject?.path || '');

    showNotification(
        nextFavoriteState ? `Added ${project.name} to favorites` : `Removed ${project.name} from favorites`,
        'success'
    );
}

async function renameProjectFromCard(project) {
    if (!project || !project.path) {
        return;
    }

    const enteredName = prompt('Enter a new project name:', project.name || '');
    if (enteredName === null) {
        return;
    }

    const trimmedName = enteredName.trim();
    const validation = validateProjectName(trimmedName);
    if (!validation.valid) {
        showNotification(validation.error, 'error');
        return;
    }

    const result = await ipcRenderer.invoke('rename-project', project.path, trimmedName);
    if (!result || !result.success || !result.project) {
        showNotification(result?.error || 'Failed to rename project', 'error');
        return;
    }

    const renamedProject = result.project;
    const oldPathKey = normalizeRecentProjectPath(project.path);
    const updatedRecent = [];
    const seenPaths = new Set();

    for (const recentProject of recentProjects) {
        if (!recentProject || !recentProject.path) {
            continue;
        }

        const currentKey = normalizeRecentProjectPath(recentProject.path);
        const nextProject = currentKey === oldPathKey
            ? { ...recentProject, name: renamedProject.name, path: renamedProject.path }
            : recentProject;

        const nextKey = normalizeRecentProjectPath(nextProject.path);
        if (!nextKey || seenPaths.has(nextKey)) {
            continue;
        }

        seenPaths.add(nextKey);
        updatedRecent.push(nextProject);
    }

    recentProjects = updatedRecent;
    moveProjectFavoritePath(project.path, renamedProject.path);
    await ipcRenderer.invoke('save-recent-projects', recentProjects);

    if (normalizeRecentProjectPath(currentProject?.path || '') === oldPathKey) {
        selectProjectFromCard({
            ...currentProject,
            name: renamedProject.name,
            path: renamedProject.path
        }, { showNotification: false, refreshGit: true });
    }

    displayRecentProjects();
    await loadAllProjects();
    setSelectedProjectCardByPath(currentProject?.path || '');
    showNotification(`Renamed project to ${renamedProject.name}`, 'success');
}

async function loadRecentProjects() {
    const storedProjects = await ipcRenderer.invoke('get-recent-projects');
    const projects = Array.isArray(storedProjects) ? storedProjects : [];
    const seenPaths = new Set();
    const validProjects = [];

    for (const project of projects) {
        if (!project || !project.path) {
            continue;
        }

        const normalizedPath = normalizeRecentProjectPath(project.path);
        if (!normalizedPath) {
            continue;
        }

        try {
            fs.accessSync(project.path);

            if (seenPaths.has(normalizedPath)) {
                continue;
            }

            seenPaths.add(normalizedPath);
            validProjects.push({
                ...project,
                lastAccessed: project.lastAccessed || Date.now()
            });
        } catch {
            // Skip projects that no longer exist on disk.
        }
    }

    validProjects.sort(compareProjectsForDisplay);
    const recentLimit = getRecentProjectsLimitSetting();
    const limitedProjects = validProjects.slice(0, recentLimit);
    await ipcRenderer.invoke('save-recent-projects', limitedProjects);

    recentProjects = limitedProjects;
    displayRecentProjects();
    updateStatusProjectCounts(document.querySelectorAll('#all-projects-list .project-card-modern').length, recentProjects.length);
}
// Display recent projects
function displayRecentProjects() {
    const container = document.getElementById('recent-projects-list');
    if (!container) return;
    
    container.innerHTML = '';
    
    if (recentProjects.length === 0) {
        container.innerHTML = `
            <div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-secondary);">
                <i class="fas fa-folder-open" style="font-size: 48px; margin-bottom: 10px;"></i>
                <p>No recent projects</p>
                <p style="font-size: 12px; margin-top: 10px;">Create your first project to get started</p>
            </div>
        `;
        return;
    }
    
    const sortedRecent = [...recentProjects].sort(compareProjectsForDisplay);
    sortedRecent.slice(0, 6).forEach((project, index) => {
        const projectCard = createProjectCard(project, index);
        container.appendChild(projectCard);
    });

    setSelectedProjectCardByPath(currentProject?.path || '');
}

// Create project card element
function createProjectCard(project, renderIndex = 0) {
    const card = document.createElement('div');
    card.className = 'project-card-modern';
    card.style.setProperty('--project-card-delay', `${Math.min(renderIndex * 35, 220)}ms`);

    // Check if project has Git
    const hasGit = typeof project.path === 'string' && fs.existsSync(path.join(project.path, '.git'));
    const isFavorite = isFavoriteProject(project.path);
    const modifiedTimestamp = project.lastModified
        ? new Date(project.lastModified).getTime()
        : (project.lastAccessed || Date.now());

    card.dataset.type = project.type || 'unknown';
    card.dataset.modified = String(Number.isFinite(modifiedTimestamp) ? modifiedTimestamp : Date.now());
    card.dataset.hasGit = String(Boolean(hasGit || project.isGitRepo === true));
    card.dataset.projectPath = project.path || '';
    card.dataset.favorite = String(isFavorite);

    // Get last accessed time
    const lastAccessed = project.lastAccessed || Date.now();
    const timeAgo = getTimeAgo(lastAccessed);

    // Icon and color mapping
    const typeConfig = {
        electron: { icon: 'fab fa-react', color: '#61dafb', label: 'Electron' },
        python: { icon: 'fab fa-python', color: '#3776ab', label: 'Python' },
        web: { icon: 'fab fa-html5', color: '#e34f26', label: 'Web' },
        node: { icon: 'fab fa-node-js', color: '#339933', label: 'Node.js' },
        nodejs: { icon: 'fab fa-node-js', color: '#339933', label: 'Node.js' },
        react: { icon: 'fab fa-react', color: '#61dafb', label: 'React' },
        vue: { icon: 'fab fa-vuejs', color: '#4fc08d', label: 'Vue.js' },
        cpp: { icon: 'fas fa-code', color: '#00599c', label: 'C++' },
        java: { icon: 'fab fa-java', color: '#007396', label: 'Java' },
        empty: { icon: 'fas fa-folder', color: '#dcb67a', label: 'Empty' }
    };

    const config = typeConfig[project.type] || typeConfig.empty;
    const safeProjectName = escapeHtml(project.name || 'Untitled Project');
    const safeProjectPath = escapeHtml(project.path || '');
    const safeTruncatedProjectPath = escapeHtml(truncatePath(project.path || '', 35));

    // Create a safe project object for passing to functions
    const safeProject = {
        name: project.name,
        path: project.path,
        type: project.type
    };

    card.innerHTML = `
        <div class="project-card-accent" style="background: ${config.color}"></div>
        <div class="project-card-content">
            <div class="project-card-top">
                <div class="project-icon-modern" style="background: ${config.color}15; color: ${config.color}">
                    <i class="${config.icon}"></i>
                </div>
                <div class="project-badges">
                    ${hasGit ? '<span class="project-badge git-badge"><i class="fab fa-git-alt"></i></span>' : ''}
                    <button class="project-badge-btn project-favorite-btn ${isFavorite ? 'is-active' : ''}" data-toggle-favorite title="${isFavorite ? 'Remove from favorites' : 'Add to favorites'}" aria-label="${isFavorite ? 'Remove from favorites' : 'Add to favorites'}">
                        <i class="${isFavorite ? 'fas' : 'far'} fa-star"></i>
                    </button>
                    <button class="project-badge-btn project-menu-btn" data-project-menu title="Project actions" aria-label="Project actions">
                        <i class="fas fa-ellipsis-v"></i>
                    </button>
                </div>
            </div>
            <div class="project-details">
                <h3 class="project-name" title="${safeProjectName}">${safeProjectName}</h3>
                <div class="project-meta">
                    <span class="project-type-badge" style="background: ${config.color}20; color: ${config.color}">
                        ${config.label}
                    </span>
                    ${isFavorite ? '<span class="project-favorite-pill"><i class="fas fa-star"></i> Favorite</span>' : ''}
                    <span class="project-time">
                        <i class="far fa-clock"></i> ${timeAgo}
                    </span>
                </div>
                <div class="project-path-modern" title="${safeProjectPath}">
                    <i class="fas fa-folder-open"></i>
                    ${safeTruncatedProjectPath}
                </div>
            </div>
            <div class="project-actions-modern">
                <button class="project-btn project-btn-primary" data-open-vscode>
                    <i class="fas fa-code"></i>
                    <span>Open</span>
                </button>
                <button class="project-btn project-btn-secondary project-btn-icon" data-open-explorer title="Open in explorer">
                    <i class="fas fa-external-link-alt"></i>
                </button>
                <button class="project-btn project-btn-danger project-btn-icon" data-delete-project title="Delete project">
                    <i class="fas fa-trash-alt"></i>
                </button>
            </div>
        </div>
    `;

    // Select card without opening the project.
    card.addEventListener('click', (e) => {
        if (!e.target.closest('button')) {
            selectProjectFromCard(project, { showNotification: false, refreshGit: false });
        }
    });

    // Add button handlers
    const openBtn = card.querySelector('[data-open-vscode]');
    openBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        void openInVscode(project.path);
        selectProjectFromCard(project, { showNotification: false, refreshGit: false });
        updateProjectAccessTime(project.path);
    });

    const explorerBtn = card.querySelector('[data-open-explorer]');
    explorerBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        void openInExplorer(project.path);
    });

    const deleteBtn = card.querySelector('[data-delete-project]');
    deleteBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        showDeleteProjectModal(safeProject);
    });

    const favoriteBtn = card.querySelector('[data-toggle-favorite]');
    favoriteBtn?.addEventListener('click', async (e) => {
        e.stopPropagation();
        await toggleProjectFavorite(project);
    });

    const menuBtn = card.querySelector('[data-project-menu]');
    menuBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        const rect = menuBtn.getBoundingClientRect();
        showProjectContextMenu({
            pageX: rect.right + window.scrollX - 4,
            pageY: rect.bottom + window.scrollY + 6
        }, project);
    });

    // Add context menu handler
    card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showProjectContextMenu(e, project);
    });

    return card;
}

// Show context menu for project card
function showProjectContextMenu(event, project) {
    // Remove existing context menu if any
    const existingMenu = document.querySelector('.context-menu');
    if (existingMenu) {
        existingMenu.remove();
    }

    const isFavorite = isFavoriteProject(project.path);
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.innerHTML = `
        <div class="context-menu-item" data-action="select">
            <i class="fas fa-crosshairs"></i>
            <span>Select Project</span>
        </div>
        <div class="context-menu-divider"></div>
        <div class="context-menu-item" data-action="open">
            <i class="fas fa-code"></i>
            <span>Open in VS Code</span>
        </div>
        <div class="context-menu-item" data-action="explorer">
            <i class="fas fa-folder-open"></i>
            <span>Open in File Explorer</span>
        </div>
        <div class="context-menu-item" data-action="terminal">
            <i class="fas fa-terminal"></i>
            <span>Open in Terminal</span>
        </div>
        <div class="context-menu-divider"></div>
        <div class="context-menu-item" data-action="rename">
            <i class="fas fa-pen"></i>
            <span>Rename Project</span>
        </div>
        <div class="context-menu-item" data-action="favorite">
            <i class="${isFavorite ? 'fas' : 'far'} fa-star"></i>
            <span>${isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}</span>
        </div>
        <div class="context-menu-divider"></div>
        <div class="context-menu-item" data-action="copy-path">
            <i class="fas fa-copy"></i>
            <span>Copy Path</span>
        </div>
        <div class="context-menu-item" data-action="copy-name">
            <i class="fas fa-file-signature"></i>
            <span>Copy Name</span>
        </div>
        <div class="context-menu-divider"></div>
        <div class="context-menu-item" data-action="remove">
            <i class="fas fa-times"></i>
            <span>Remove from Recent</span>
        </div>
        <div class="context-menu-item context-menu-danger" data-action="delete">
            <i class="fas fa-trash-alt"></i>
            <span>Delete Project</span>
        </div>
    `;

    // Position menu
    const pageX = typeof event?.pageX === 'number' ? event.pageX : 0;
    const pageY = typeof event?.pageY === 'number' ? event.pageY : 0;
    menu.style.left = `${pageX}px`;
    menu.style.top = `${pageY}px`;
    document.body.appendChild(menu);

    // Adjust position if menu goes off screen
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
        menu.style.left = (window.innerWidth - rect.width - 10) + 'px';
    }
    if (rect.bottom > window.innerHeight) {
        menu.style.top = (window.innerHeight - rect.height - 10) + 'px';
    }

    // Handle menu item clicks
    menu.querySelectorAll('.context-menu-item').forEach(item => {
        item.addEventListener('click', async () => {
            const action = item.getAttribute('data-action');
            await handleContextMenuAction(action, project);
            menu.remove();
        });
    });

    // Close menu on click outside
    setTimeout(() => {
        document.addEventListener('click', function closeMenu(e) {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        });
    }, 0);
}

// Handle context menu actions
async function handleContextMenuAction(action, project) {
    switch (action) {
        case 'select':
            selectProjectFromCard(project, { showNotification: true, refreshGit: false });
            break;
        case 'open':
            void openInVscode(project.path);
            selectProjectFromCard(project, { showNotification: false, refreshGit: false });
            updateProjectAccessTime(project.path);
            break;
        case 'explorer':
            void openInExplorer(project.path);
            break;
        case 'terminal':
            await ipcRenderer.invoke('open-terminal', resolveTerminalLaunchPath(project.path));
            showNotification('Opening terminal...', 'info');
            break;
        case 'rename':
            await renameProjectFromCard(project);
            break;
        case 'favorite':
            await toggleProjectFavorite(project);
            break;
        case 'copy-path':
            navigator.clipboard.writeText(project.path);
            showNotification('Path copied to clipboard', 'success');
            break;
        case 'copy-name':
            navigator.clipboard.writeText(project.name);
            showNotification('Name copied to clipboard', 'success');
            break;
        case 'remove':
            await removeFromRecent(project.path);
            break;
        case 'delete':
            showDeleteProjectModal(project);
            break;
    }
}

// Remove project from recent list
async function removeFromRecent(projectPath) {
    const index = recentProjects.findIndex(p => p.path === projectPath);
    if (index !== -1) {
        recentProjects.splice(index, 1);
        await ipcRenderer.invoke('save-recent-projects', recentProjects);
        displayRecentProjects();
        updateStatusProjectCounts(document.querySelectorAll('#all-projects-list .project-card-modern').length, recentProjects.length);
        showNotification('Removed from recent projects', 'success');
    } else {
        showNotification('Project is not in the recent list', 'info');
    }
}

// Helper function to get time ago string
function getTimeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);

    if (seconds < 60) return 'Just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
    if (seconds < 2592000) return `${Math.floor(seconds / 604800)}w ago`;
    return `${Math.floor(seconds / 2592000)}mo ago`;
}

// Helper function to truncate path
function truncatePath(fullPath, maxLength) {
    if (fullPath.length <= maxLength) return fullPath;

    const parts = fullPath.split(path.sep);
    if (parts.length <= 2) return fullPath;

    return '...' + path.sep + parts.slice(-2).join(path.sep);
}

// Update project access time
async function updateProjectAccessTime(projectPath) {
    const projectIndex = recentProjects.findIndex(p => p.path === projectPath);
    if (projectIndex !== -1) {
        recentProjects[projectIndex].lastAccessed = Date.now();
        // Move to front
        const [project] = recentProjects.splice(projectIndex, 1);
        recentProjects.unshift(project);
        recentProjects.sort(compareProjectsForDisplay);
        await ipcRenderer.invoke('save-recent-projects', recentProjects);
        displayRecentProjects();
        updateStatusProjectCounts(document.querySelectorAll('#all-projects-list .project-card-modern').length, recentProjects.length);
    }
}

// Add project to recent (avoiding duplicates)
async function addToRecentProjects(project) {
    if (!project || !project.path) {
        return;
    }

    const normalizedPath = normalizeRecentProjectPath(project.path);
    if (!normalizedPath) {
        return;
    }

    recentProjects = recentProjects.filter((existingProject) => {
        const existingPath = normalizeRecentProjectPath(existingProject.path);
        if (!existingPath) {
            return false;
        }
        return existingPath !== normalizedPath;
    });

    recentProjects.unshift({
        ...project,
        lastAccessed: Date.now()
    });

    recentProjects.sort(compareProjectsForDisplay);
    const recentLimit = getRecentProjectsLimitSetting();
    recentProjects = recentProjects.slice(0, recentLimit);

    await ipcRenderer.invoke('save-recent-projects', recentProjects);
    displayRecentProjects();
    updateStatusProjectCounts(document.querySelectorAll('#all-projects-list .project-card-modern').length, recentProjects.length);
}
// Load all projects
async function loadAllProjects() {
    const projectsList = document.getElementById('all-projects-list');
    if (!projectsList) return;
    markIndexedSearchStale(workspacePath);

    const useListView = projectsList.classList.contains('list-view');

    projectsList.innerHTML = '<div class="loading"><span class="spinner"></span><span class="loading-text">Loading projects...</span></div>';

    const projects = await ipcRenderer.invoke('search-projects', workspacePath, '');

    if (projects.length === 0) {
        projectsList.innerHTML = `
            <div style="text-align: center; padding: 40px; color: var(--text-secondary);">
                <i class="fas fa-folder-open" style="font-size: 48px; margin-bottom: 10px;"></i>
                <p>No projects found in workspace</p>
                <p style="font-size: 12px; margin-top: 10px;">Create a new project or change workspace location</p>
            </div>
        `;
    } else {
        projectsList.innerHTML = '';
        projectsList.className = useListView ? 'projects-list list-view' : 'projects-list grid-view';
        projects.forEach((project, index) => {
            const card = createProjectCard(project, index);
            projectsList.appendChild(card);
        });

        const selectedSort = document.getElementById('project-sort')?.value || 'name';
        sortProjects(selectedSort, { silent: true });
    }

    // Update project stats after loading projects
    await updateProjectStats();
    setSelectedProjectCardByPath(currentProject?.path || '');
}

// Search projects
async function searchProjects(query) {
    const resultsContainer = document.getElementById('search-results');
    if (!resultsContainer) {
        return;
    }

    const normalizedQuery = typeof query === 'string' ? query.trim() : '';
    if (!normalizedQuery) {
        resultsContainer.innerHTML = '';
        return;
    }

    resultsContainer.innerHTML = '<div class="loading"><span class="spinner"></span></div>';

    let indexedResults = [];
    try {
        await ensureIndexedSearchReady();
        const indexedResponse = await ipcRenderer.invoke('query-search-index', normalizedQuery, 80);
        if (indexedResponse?.success && Array.isArray(indexedResponse.results)) {
            indexedResults = indexedResponse.results;
        }
    } catch (error) {
        console.warn('Indexed search unavailable, falling back to project search', error);
    }

    resultsContainer.innerHTML = '';

    if (indexedResults.length > 0) {
        indexedResults.forEach((item) => {
            const row = document.createElement('div');
            row.className = 'search-result-item';

            const title = document.createElement('h4');
            const type = String(item.type || 'project');
            if (type === 'file') {
                title.textContent = item.label || 'File';
            } else if (type === 'commit') {
                title.textContent = item.label || 'Commit';
            } else {
                title.textContent = item.label || path.basename(item.projectPath || '') || 'Project';
            }

            const location = document.createElement('p');
            if (type === 'file') {
                location.textContent = item.filePath || item.projectPath || '';
            } else if (type === 'commit') {
                const commitRef = item.hash ? `Commit ${item.hash}` : 'Commit';
                location.textContent = `${commitRef} - ${item.projectPath || ''}`;
            } else {
                location.textContent = item.projectPath || '';
            }

            const badge = document.createElement('span');
            badge.className = 'tag';
            badge.textContent = type;
            row.appendChild(badge);
            row.appendChild(title);
            row.appendChild(location);

            row.addEventListener('click', () => {
                void openGlobalSearchResult(item);
            });
            resultsContainer.appendChild(row);
        });
        return;
    }

    const projects = await ipcRenderer.invoke('search-projects', workspacePath, normalizedQuery);
    if (!Array.isArray(projects) || projects.length === 0) {
        resultsContainer.innerHTML = '<p style="color: var(--text-secondary); text-align: center;">No projects found</p>';
        return;
    }

    projects.forEach((project) => {
        const row = document.createElement('div');
        row.className = 'search-result-item';

        const title = document.createElement('h4');
        title.textContent = project.name || 'Untitled Project';
        const location = document.createElement('p');
        location.textContent = project.path || '';

        row.appendChild(title);
        row.appendChild(location);

        row.addEventListener('click', () => {
            if (normalizeSettings(appSettings).openInVSCode) {
                ipcRenderer.invoke('open-in-vscode', project.path);
            } else {
                ipcRenderer.invoke('open-in-explorer', project.path);
            }
            hideModal('search-modal');
        });
        resultsContainer.appendChild(row);
    });
}

// Git operations
async function initializeGit() {
    if (!ensureProAccess('Git Management')) {
        return;
    }

    if (!currentProject) {
        showNotification('Please select a project first', 'error');
        return;
    }
    
    try {
        const result = await ipcRenderer.invoke('init-git', currentProject.path);
        if (result.success) {
            showNotification('Git repository initialized', 'success');
            await refreshGitStatus();
        } else {
            showNotification(`Failed to initialize Git: ${result.error}`, 'error');
        }
    } catch (error) {
        showNotification(`Git init error: ${error.message}`, 'error');
    }
}

// Operation lock to prevent concurrent git operations
let _gitOpLock = false;
async function withGitLock(fn) {
    if (_gitOpLock) {
        return;
    }
    _gitOpLock = true;
    try {
        return await fn();
    } finally {
        _gitOpLock = false;
    }
}

// Debounced refresh with lazy rendering
let gitRefreshTimeout = null;
let _isRefreshing = false;
async function refreshGitStatus() {
    // If changes tab is not active, mark for later refresh
    if (currentGitTab !== 'changes') {
        gitStatusNeedsRefresh = true;
        return;
    }

    // Debounce rapid refresh calls
    if (gitRefreshTimeout) {
        clearTimeout(gitRefreshTimeout);
    }

    gitRefreshTimeout = setTimeout(() => {
        refreshGitStatusNow();
    }, 150);
}

async function refreshGitStatusNow() {
    // Prevent concurrent refresh calls
    if (_isRefreshing) return;
    _isRefreshing = true;
    gitStatusNeedsRefresh = false;

    const statusContainer = document.getElementById('git-status');

    if (!statusContainer) {
        console.error('[GIT] git-status element not found in DOM');
        _isRefreshing = false;
        return;
    }

    if (!currentProject) {
        statusContainer.innerHTML = `
            <div class="git-empty-state">
                <i class="fab fa-git-alt" style="font-size: 48px; color: var(--text-secondary); opacity: 0.3;"></i>
                <p>No repository loaded</p>
                <p class="git-hint">Select a project to view git status</p>
            </div>
        `;
        _isRefreshing = false;
        return;
    }

    let result;
    try {
        result = await ipcRenderer.invoke('git-status', currentProject.path);
    } catch (error) {
        console.error('[GIT] Failed to fetch git status:', error);
        _isRefreshing = false;
        return;
    }

    if (!result.success) {
        statusContainer.innerHTML = `
            <div class="git-not-initialized">
                <i class="fab fa-git-alt" style="font-size: 48px; color: var(--warning); opacity: 0.5;"></i>
                <p style="color: var(--text-primary); margin: 16px 0 8px 0; font-weight: 500;">Not a git repository</p>
                <p style="color: var(--text-secondary); font-size: 13px; margin-bottom: 16px;">Initialize git to start version control</p>
                <button class="btn-primary" onclick="initializeGit()">
                    <i class="fas fa-play"></i> Initialize Git
                </button>
            </div>
        `;
        _isRefreshing = false;
        return;
    }

    if (!result.output || result.output.trim() === '') {
        statusContainer.innerHTML = `
            <div class="git-clean-state">
                <i class="fas fa-check-circle" style="font-size: 48px; color: var(--success); opacity: 0.6;"></i>
                <p style="color: var(--text-primary); margin: 16px 0 4px 0; font-weight: 500;">Working tree clean</p>
                <p style="color: var(--text-secondary); font-size: 13px;">No changes to commit</p>
            </div>
        `;

        // Update file counts
        const modEl = document.getElementById('git-modified');
        if (modEl) modEl.textContent = '0';

        // Load branches even when clean
        await loadBranches();
        _isRefreshing = false;
        return;
    }

    // Parse git status output
    const files = result.output.split('\n').filter(line => line.trim());
    const stagedFiles = [];
    const unstagedFiles = [];
    const untrackedFiles = [];

    files.forEach(file => {
        const statusCode = file.substring(0, 2);
        const filename = file.substring(3).trim();

        const fileInfo = {
            filename,
            statusCode,
            status: '',
            icon: '',
            color: ''
        };

        // Parse status codes (XY format: X = staged, Y = unstaged)
        const staged = statusCode[0];
        const unstaged = statusCode[1];

        if (staged !== ' ' && staged !== '?') {
            // File is staged
            if (staged === 'M') {
                fileInfo.status = 'Modified';
                fileInfo.icon = 'fa-edit';
                fileInfo.color = '#ce9178';
            } else if (staged === 'A') {
                fileInfo.status = 'Added';
                fileInfo.icon = 'fa-plus';
                fileInfo.color = '#4ec9b0';
            } else if (staged === 'D') {
                fileInfo.status = 'Deleted';
                fileInfo.icon = 'fa-trash';
                fileInfo.color = '#f48771';
            } else if (staged === 'R') {
                fileInfo.status = 'Renamed';
                fileInfo.icon = 'fa-exchange-alt';
                fileInfo.color = '#dcdcaa';
            }
            stagedFiles.push({...fileInfo});
        }

        if (unstaged !== ' ') {
            // File has unstaged changes
            if (unstaged === 'M') {
                fileInfo.status = 'Modified';
                fileInfo.icon = 'fa-edit';
                fileInfo.color = '#ce9178';
            } else if (unstaged === 'D') {
                fileInfo.status = 'Deleted';
                fileInfo.icon = 'fa-trash';
                fileInfo.color = '#f48771';
            }

            if (statusCode === '??') {
                // Untracked file
                fileInfo.status = 'Untracked';
                fileInfo.icon = 'fa-file';
                fileInfo.color = '#858585';
                untrackedFiles.push({...fileInfo});
            } else {
                unstagedFiles.push({...fileInfo});
            }
        }
    });

    // Helper function to group files by folder (root level only)
    function groupFilesByFolder(files) {
        const grouped = {};
        files.forEach(file => {
            const parts = file.filename.split('/');
            let folder = 'Root';

            if (parts.length > 1) {
                // Only use the FIRST folder in the path (root level)
                folder = parts[0];
            }

            if (!grouped[folder]) {
                grouped[folder] = [];
            }
            grouped[folder].push(file);
        });
        return grouped;
    }

    // Helper function to render files with optional grouping
    function renderFileList(files, type, groupByFolder = false) {
        if (files.length === 0) return '';

        let html = '';

        if (groupByFolder) {
            // Group by folder
            const grouped = groupFilesByFolder(files);
            const folders = Object.keys(grouped).sort();

            // Separate root files from folder files
            const rootFiles = grouped['Root'] || [];
            const actualFolders = folders.filter(f => f !== 'Root');

            // Render actual folders FIRST as collapsible groups
            actualFolders.forEach(folder => {
                const folderFiles = grouped[folder];
                const folderId = `folder-${type}-${folder.replace(/[^a-zA-Z0-9]/g, '-')}`;
                const safeFolderName = escapeHtml(folder);

                html += `
                    <div class="git-folder-group">
                        <div class="git-folder-header">
                            <i class="fas fa-chevron-right git-folder-icon" id="${folderId}-icon" onclick="toggleFolder('${folderId}')"></i>
                            <input type="checkbox" class="git-folder-checkbox"
                                   data-folder-id="${folderId}"
                                   data-type="${type}"
                                   onchange="toggleFolderSelection('${folderId}', '${type}', this.checked)"
                                   onclick="event.stopPropagation()"
                                   title="Select all files in this folder">
                            <i class="fas fa-folder" style="color: #dcb67a;" onclick="toggleFolder('${folderId}')"></i>
                            <span class="git-folder-name" onclick="toggleFolder('${folderId}')">${safeFolderName}</span>
                            <span class="git-count-badge" onclick="toggleFolder('${folderId}')">${folderFiles.length}</span>
                        </div>
                        <div class="git-folder-files" id="${folderId}" style="display: none;">
                `;

                folderFiles.forEach(file => {
                    html += renderFileItem(file, type);
                });

                html += `
                        </div>
                    </div>
                `;
            });

            // Render root files AFTER folders (without folder wrapper)
            rootFiles.forEach(file => {
                html += renderFileItem(file, type);
            });
        } else {
            // Flat list when grouping disabled
            files.forEach(file => {
                html += renderFileItem(file, type);
            });
        }

        return html;
    }

    // Helper function to render a single file item
    function renderFileItem(file, type) {
        const checkboxClass = type === 'staged' ? 'staged-checkbox' : 'unstaged-checkbox';
        const encodedFilename = encodeURIComponent(file.filename);
        const safeFilename = escapeHtml(file.filename);
        const safeFileNameLabel = escapeHtml(file.filename.split('/').pop());
        const safeFilePath = file.filename.includes('/')
            ? escapeHtml(`${file.filename.split('/').slice(0, -1).join('/')}/`)
            : '';
        const safeFileStatus = escapeHtml(file.status);
        const supportsHunks = file.status !== 'Untracked';
        const hunkButton = supportsHunks
            ? `<button class="btn-icon-sm" onclick="event.stopPropagation(); openHunkStageModal(decodeURIComponent('${encodedFilename}'), '${type === 'staged' ? 'staged' : 'unstaged'}')" title="${type === 'staged' ? 'Unstage Hunks' : 'Stage Hunks'}">
                   <i class="fas fa-grip-lines"></i>
               </button>`
            : '';
        const stageButton = type === 'staged'
            ? `${hunkButton}
               <button class="btn-icon-sm" onclick="event.stopPropagation(); unstageFile(decodeURIComponent('${encodedFilename}'))" title="Unstage">
                   <i class="fas fa-minus"></i>
               </button>`
            : `${hunkButton}
               <button class="btn-icon-sm" onclick="event.stopPropagation(); stageFile(decodeURIComponent('${encodedFilename}'))" title="Stage">
                   <i class="fas fa-plus"></i>
               </button>
               <button class="btn-icon-sm" onclick="event.stopPropagation(); discardFile(decodeURIComponent('${encodedFilename}'))" title="Discard">
                   <i class="fas fa-undo"></i>
               </button>`;

        return `
            <div class="git-file-item ${type}" data-filename="${safeFilename}">
                <input type="checkbox" class="git-file-checkbox ${checkboxClass}"
                       onchange="update${type === 'staged' ? 'Staged' : 'Unstaged'}SelectionState()"
                       onclick="event.stopPropagation()">
                <div class="git-file-info" onclick="viewFileDiff(decodeURIComponent('${encodedFilename}'))">
                    <i class="fas ${file.icon}" style="color: ${file.color};"></i>
                    <span class="git-file-name">${safeFileNameLabel}</span>
                    ${safeFilePath ? `<span class="git-file-path">${safeFilePath}</span>` : ''}
                    <span class="git-file-status" style="color: ${file.color};">${safeFileStatus}</span>
                </div>
                <div class="git-file-actions">
                    ${stageButton}
                </div>
            </div>
        `;
    }

    // Build improved UI
    let html = '';

    // Staged changes section
    html += `
        <div class="git-changes-group">
            <div class="git-changes-group-header">
                <div class="git-group-title">
                    ${stagedFiles.length > 0 ? '<input type="checkbox" class="git-select-all" onchange="toggleSelectAllStaged(this)" title="Select All">' : ''}
                    <i class="fas fa-circle" style="color: #4ec9b0;"></i>
                    <span>Staged Changes</span>
                    <span class="git-count-badge">${stagedFiles.length}</span>
                </div>
                <div class="git-group-actions">
                    ${stagedFiles.length > 0 ? '<button class="btn-icon" onclick="unstageSelected()" title="Unstage Selected"><i class="fas fa-minus"></i></button>' : ''}
                    ${stagedFiles.length > 0 ? '<button class="btn-icon" onclick="unstageAll()" title="Unstage All"><i class="fas fa-minus-circle"></i></button>' : ''}
                </div>
            </div>
            <div class="git-files-list">
    `;

    if (stagedFiles.length === 0) {
        html += '<div class="git-changes-empty">No staged changes</div>';
    } else {
        html += renderFileList(stagedFiles, 'staged', true);
    }

    html += `
            </div>
        </div>
    `;

    // Unstaged changes section
    html += `
        <div class="git-changes-group">
            <div class="git-changes-group-header">
                <div class="git-group-title">
                    ${(unstagedFiles.length + untrackedFiles.length) > 0 ? '<input type="checkbox" class="git-select-all" onchange="toggleSelectAllUnstaged(this)" title="Select All">' : ''}
                    <i class="fas fa-circle" style="color: #ce9178;"></i>
                    <span>Changes</span>
                    <span class="git-count-badge">${unstagedFiles.length + untrackedFiles.length}</span>
                </div>
                <div class="git-group-actions">
                    ${(unstagedFiles.length + untrackedFiles.length) > 0 ? '<button class="btn-icon" onclick="stageSelected()" title="Stage Selected"><i class="fas fa-plus"></i></button>' : ''}
                    ${(unstagedFiles.length + untrackedFiles.length) > 0 ? '<button class="btn-icon" onclick="stageAll()" title="Stage All"><i class="fas fa-plus-circle"></i></button>' : ''}
                </div>
            </div>
            <div class="git-files-list">
    `;

    if (unstagedFiles.length === 0 && untrackedFiles.length === 0) {
        html += '<div class="git-changes-empty">No unstaged changes</div>';
    } else {
        html += renderFileList([...unstagedFiles, ...untrackedFiles], 'unstaged', true);
    }

    html += `
            </div>
        </div>
    `;

    // Use requestAnimationFrame for smoother rendering
    requestAnimationFrame(() => {
        statusContainer.innerHTML = html;

        // Update modified files count
        const modifiedEl = document.getElementById('git-modified');
        if (modifiedEl) {
            modifiedEl.textContent = files.length;
        }
    });

    // Load branches asynchronously
    loadBranches();
    _isRefreshing = false;
}

// Project operations
async function buildProject() {
    if (!currentProject) {
        showNotification('Please select a project first', 'error');
        return;
    }

    let command = '';
    switch(currentProject.type) {
        case 'nodejs':
        case 'react':
        case 'vue':
        case 'electron':
            command = 'npm run build';
            break;
        case 'python':
            command = 'python setup.py build';
            break;
        case 'cpp':
            command = 'make build';
            break;
        case 'java':
            command = 'mvn compile';
            break;
        default:
            showNotification('Build not configured for this project type', 'warning');
            return;
    }

    try {
        showNotification('Building project...', 'info');
        const result = await ipcRenderer.invoke('run-command', command, currentProject.path);

        if (result.success) {
            showNotification('Build completed successfully', 'success');
        } else {
            showNotification(`Build failed: ${result.error}`, 'error');
        }
    } catch (error) {
        handleError(error, 'Build Project');
    }
}

async function runProject() {
    if (!currentProject) {
        showNotification('Please select a project first', 'error');
        return;
    }

    let command = '';
    switch(currentProject.type) {
        case 'nodejs':
        case 'react':
        case 'vue':
        case 'electron':
            command = 'npm start';
            break;
        case 'python':
            command = 'python main.py';
            break;
        case 'cpp':
            command = './main';
            break;
        case 'java':
            command = 'java Main';
            break;
        case 'web':
            // Open in browser
            try {
                const indexFileUrl = pathToFileURL(path.join(currentProject.path, 'index.html')).toString();
                await ipcRenderer.invoke('open-external', indexFileUrl);
            } catch (error) {
                handleError(error, 'Open in Browser');
            }
            return;
        default:
            showNotification('Run not configured for this project type', 'warning');
            return;
    }

    try {
        showNotification('Running project...', 'info');
        await ipcRenderer.invoke('open-terminal', resolveTerminalLaunchPath(currentProject.path));
        await ipcRenderer.invoke('run-command', command, currentProject.path);
    } catch (error) {
        handleError(error, 'Run Project');
    }
}

async function installDependencies() {
    if (!currentProject) {
        showNotification('Please select a project first', 'error');
        return;
    }

    let command = '';
    switch(currentProject.type) {
        case 'nodejs':
        case 'react':
        case 'vue':
        case 'electron':
            command = 'npm install';
            break;
        case 'python':
            command = 'pip install -r requirements.txt';
            break;
        case 'java':
            command = 'mvn install';
            break;
        default:
            showNotification('Dependency installation not configured for this project type', 'warning');
            return;
    }

    try {
        showNotification('Installing dependencies...', 'info');
        const result = await ipcRenderer.invoke('run-command', command, currentProject.path);

        if (result.success) {
            showNotification('Dependencies installed successfully', 'success');
        } else {
            showNotification(`Installation failed: ${result.error}`, 'error');
        }
    } catch (error) {
        handleError(error, 'Install Dependencies');
    }
}

async function updateDependencies() {
    if (!currentProject) {
        showNotification('Please select a project first', 'error');
        return;
    }

    let command = '';
    switch(currentProject.type) {
        case 'nodejs':
        case 'react':
        case 'vue':
        case 'electron':
            command = 'npm update';
            break;
        case 'python':
            command = 'pip install --upgrade -r requirements.txt';
            break;
        case 'java':
            command = 'mvn versions:use-latest-releases';
            break;
        default:
            showNotification('Dependency update not configured for this project type', 'warning');
            return;
    }

    showNotification('Updating dependencies...', 'info');
    const result = await ipcRenderer.invoke('run-command', command, currentProject.path);

    if (result.success) {
        showNotification('Dependencies updated successfully', 'success');
    } else {
        showNotification(`Update failed: ${result.error}`, 'error');
    }
}

function showDeleteConfirmation(project) {
    if (!normalizeSettings(appSettings).confirmDelete) {
        deleteProjectFiles(project);
        return;
    }

    const confirmed = confirm(
        `Are you sure you want to permanently delete "${project.name || project.path}"?\n\nThis action cannot be undone. All project files will be removed.`
    );
    if (confirmed) {
        deleteProjectFiles(project);
    }
}

async function deleteProjectFiles(project) {
    try {
        const result = await ipcRenderer.invoke('delete-project-files', project.path);
        if (result.success) {
            currentProject = null;
            await loadAllProjects();
            await loadRecentProjects();
            showNotification('Project deleted successfully', 'success');
        } else {
            showNotification(`Delete failed: ${result.error}`, 'error');
        }
    } catch (error) {
        handleError(error, 'Delete Project');
    }
}

// Utility functions
function toggleSidebar() {
    const sidebar = document.querySelector('.sidebar');
    const contentArea = document.querySelector('.content-area');
    const sidebarWidth = getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width').trim() || '62px';
    
    if (sidebar.style.display === 'none') {
        sidebar.style.display = 'flex';
        contentArea.style.marginLeft = sidebarWidth;
    } else {
        sidebar.style.display = 'none';
        contentArea.style.marginLeft = '0';
    }
}

function toggleStatusBar() {
    const statusBar = document.querySelector('.status-bar');
    
    if (statusBar.style.display === 'none') {
        statusBar.style.display = 'flex';
    } else {
        statusBar.style.display = 'none';
    }
}

async function saveWorkspace() {
    // Save current workspace configuration
    const workspace = {
        path: workspacePath,
        recentProjects: recentProjects,
        currentProject: currentProject
    };
    
    // In a real app, this would save to a file
    localStorage.setItem('workspace', JSON.stringify(workspace));
    showNotification('Workspace saved', 'success');
}

function showProjectSettings() {
    // Show project-specific settings
    switchView('settings');
    showNotification(`Settings for ${currentProject.name}`, 'success');
}

async function checkVSCodeInstallation() {
    const isInstalled = await ipcRenderer.invoke('check-vscode');
    if (!isInstalled) {
        showNotification('VS Code not found. Please install it for the best experience.', 'warning');
    }
}

// Format project type
function formatProjectType(type) {
    const types = {
        electron: 'Electron Application',
        python: 'Python Project',
        web: 'Web Project',
        nodejs: 'Node.js Application',
        react: 'React Application',
        vue: 'Vue.js Application',
        cpp: 'C++ Project',
        java: 'Java Project',
        empty: 'Empty Project'
    };
    return types[type] || type;
}

// Global functions for onclick handlers
window.openInVscode = async (projectPath) => {
    const result = await ipcRenderer.invoke('open-in-vscode', projectPath);
    if (result?.success) {
        showNotification('Opening in VS Code...', 'success');
    } else {
        showNotification(result?.error || 'Unable to open in VS Code', 'error');
    }
    return result;
};

window.openInExplorer = async (projectPath) => {
    const result = await ipcRenderer.invoke('open-in-explorer', projectPath);
    if (!result?.success) {
        showNotification(result?.error || 'Unable to open in explorer', 'error');
    }
    return result;
};

window.setCurrentProject = (projectPath, name, type) => {
    selectProjectFromCard(
        { path: projectPath, name, type },
        { showNotification: true, refreshGit: true }
    );
};

function updateStatusBarProject(projectName) {
    setStatusProjectName(projectName);
    refreshStatusBar();
}

// Modal functions
function showModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.add('show');
        
        // Reset new project modal when opened
        if (modalId === 'new-project-modal') {
            const normalizedSettings = normalizeSettings(appSettings);
            const nameInput = document.getElementById('project-name');
            const descInput = document.getElementById('project-description');
            const locationInput = document.getElementById('project-location');
            const hint = document.getElementById('project-name-hint');
            const initGitInput = document.getElementById('init-git');
            const openInVsCodeInput = document.getElementById('open-vscode');
            if (nameInput) { nameInput.value = ''; nameInput.style.borderColor = ''; }
            if (descInput) descInput.value = '';
            if (locationInput) { locationInput.value = workspacePath; delete locationInput.dataset.customPath; }
            if (hint) hint.textContent = '';
            if (initGitInput) initGitInput.checked = normalizedSettings.gitAutoInit;
            if (openInVsCodeInput) openInVsCodeInput.checked = normalizedSettings.openInVSCode;
            resetTemplateDropdown();
        }

        // Focus first input or the command palette input
        setTimeout(() => {
            const input = modal.querySelector('input[type="text"]:not([readonly]), textarea') ||
                          modal.querySelector('#command-palette-input');
            if (input) {
                input.focus();
                if (modalId === 'command-palette-modal' || modalId === 'search-modal') {
                    input.value = '';
                    // Show all commands
                    document.querySelectorAll('.command-item').forEach(item => {
                        item.style.display = 'flex';
                    });
                }
            }
        }, 100);
    }
}

function isGitHubUploadModalBusy() {
    if (githubUploadInProgress) {
        return true;
    }

    const overlay = document.getElementById('gh-upload-progress');
    return Boolean(overlay && overlay.classList.contains('active'));
}

function hideModal(modalId) {
    if (modalId === 'github-upload-modal' && isGitHubUploadModalBusy()) {
        return false;
    }

    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('show');
    }

    if (modalId === 'github-upload-modal') {
        const overlay = document.getElementById('gh-upload-progress');
        if (overlay) {
            overlay.classList.remove('active');
        }
        setGitHubUploadProgressMode(false);
    }
    return true;
}

// Notifications
let notificationTimeout = null;

function showNotification(message, type = 'success') {
    const toast = document.getElementById('toast');
    const toastMessage = document.getElementById('toast-message');
    const toastIcon = toast.querySelector('i');

    // Clear any existing timeout to prevent premature hiding
    if (notificationTimeout) {
        clearTimeout(notificationTimeout);
    }

    toastMessage.textContent = message;

    // Update icon and color based on type
    if (type === 'error') {
        toastIcon.className = 'fas fa-exclamation-circle';
        toastIcon.style.color = 'var(--error)';
        toast.style.borderLeft = '3px solid var(--error)';
    } else if (type === 'warning') {
        toastIcon.className = 'fas fa-exclamation-triangle';
        toastIcon.style.color = 'var(--warning)';
        toast.style.borderLeft = '3px solid var(--warning)';
    } else if (type === 'info') {
        toastIcon.className = 'fas fa-info-circle';
        toastIcon.style.color = 'var(--accent)';
        toast.style.borderLeft = '3px solid var(--accent)';
    } else {
        toastIcon.className = 'fas fa-check-circle';
        toastIcon.style.color = 'var(--success)';
        toast.style.borderLeft = '3px solid var(--success)';
    }

    toast.classList.add('show');

    // Errors stay longer so the user can read them
    const duration = type === 'error' ? 5000 : 3000;
    notificationTimeout = setTimeout(() => {
        toast.classList.remove('show');
    }, duration);
}

// ==========================================
// GitHub Upload Progress UI
// ==========================================

const GH_STEPS = ['create-repo', 'init-git', 'add-remote', 'stage-files', 'commit', 'push'];
const GH_STEP_WEIGHTS = { 'create-repo': 20, 'init-git': 10, 'add-remote': 10, 'stage-files': 15, 'commit': 15, 'push': 30 };

function setGitHubUploadProgressMode(active) {
    const modalContent = document.querySelector('#github-upload-modal .modal-content.gh-modal');
    if (!modalContent) {
        return;
    }

    modalContent.classList.toggle('gh-progress-active', Boolean(active));
}

function ghUploadProgressShow() {
    const overlay = document.getElementById('gh-upload-progress');
    if (!overlay) return;

    const modalElement = document.getElementById('github-upload-modal');
    if (modalElement) {
        modalElement.scrollTop = 0;
    }

    const modalBody = document.querySelector('#github-upload-modal .np-body');
    if (modalBody) {
        modalBody.scrollTop = 0;
    }

    overlay.scrollTop = 0;

    githubUploadLastResultSuccessful = null;

    const closeBtn = document.getElementById('gh-result-close');
    if (closeBtn) {
        closeBtn.textContent = 'Done';
        closeBtn.classList.remove('retry');
    }

    // Reset all steps
    GH_STEPS.forEach(step => {
        const el = overlay.querySelector(`[data-step="${step}"]`);
        if (el) {
            el.className = 'gh-step';
            el.querySelector('.gh-step-status').textContent = '';
        }
    });

    // Reset progress bar and ring
    document.getElementById('gh-progress-bar-fill').style.width = '0%';
    document.getElementById('gh-progress-percent').textContent = '0%';
    document.getElementById('gh-ring-fill').style.strokeDashoffset = '125.66';

    // Reset header
    document.getElementById('gh-progress-title').textContent = 'Uploading to GitHub';
    document.getElementById('gh-progress-subtitle').textContent = 'Preparing your project...';
    const progressHeader = overlay.querySelector('.gh-progress-header');
    const progressBarWrap = overlay.querySelector('.gh-progress-bar-wrap');
    if (progressHeader) {
        progressHeader.style.display = 'block';
    }
    if (progressBarWrap) {
        progressBarWrap.style.display = 'flex';
    }

    // Hide result section
    document.getElementById('gh-progress-result').style.display = 'none';
    document.getElementById('gh-progress-steps').style.display = 'flex';

    // Show overlay
    setGitHubUploadProgressMode(true);
    requestAnimationFrame(() => {
        overlay.classList.add('active');
    });
}

function ghUploadProgressUpdate(step, status, detail) {
    const overlay = document.getElementById('gh-upload-progress');
    if (!overlay) return;

    const stepEl = overlay.querySelector(`[data-step="${step}"]`);
    if (!stepEl) return;

    // Update step class
    stepEl.className = `gh-step ${status}`;

    // Update step status text
    const statusEl = stepEl.querySelector('.gh-step-status');
    if (status === 'active') {
        statusEl.textContent = 'In progress...';
    } else if (status === 'done') {
        statusEl.textContent = detail || 'Done';
    } else if (status === 'error') {
        statusEl.textContent = detail || 'Failed';
    }

    // Update subtitle
    if (status === 'active' && detail) {
        document.getElementById('gh-progress-subtitle').textContent = detail;
    }

    // Calculate overall progress
    let progress = 0;
    GH_STEPS.forEach(s => {
        const el = overlay.querySelector(`[data-step="${s}"]`);
        if (el && el.classList.contains('done')) {
            progress += GH_STEP_WEIGHTS[s];
        } else if (el && el.classList.contains('active')) {
            const activeFactor = s === 'push' ? 0.75 : 0.4;
            progress += GH_STEP_WEIGHTS[s] * activeFactor;
        }
    });
    progress = Math.min(Math.round(progress), 100);

    // Update bar
    document.getElementById('gh-progress-bar-fill').style.width = progress + '%';
    document.getElementById('gh-progress-percent').textContent = progress + '%';

    // Update circular ring (circumference = 125.66)
    const offset = 125.66 - (125.66 * progress / 100);
    document.getElementById('gh-ring-fill').style.strokeDashoffset = offset;
}

function ghUploadProgressComplete(success, repo, errorMsg) {
    const overlay = document.getElementById('gh-upload-progress');
    if (!overlay) return;

    githubUploadLastResultSuccessful = Boolean(success);

    // Fill progress to 100% on success
    if (success) {
        document.getElementById('gh-progress-bar-fill').style.width = '100%';
        document.getElementById('gh-progress-percent').textContent = '100%';
        document.getElementById('gh-ring-fill').style.strokeDashoffset = '0';
    }

    // Update title
    document.getElementById('gh-progress-title').textContent = success
        ? 'Upload Complete!'
        : 'Upload Failed';
    document.getElementById('gh-progress-subtitle').textContent = success
        ? 'Your project is now on GitHub'
        : (errorMsg || 'Something went wrong');

    // Show result area after a short delay
    setTimeout(() => {
        document.getElementById('gh-progress-steps').style.display = 'none';
        const resultEl = document.getElementById('gh-progress-result');
        resultEl.style.display = 'block';

        const iconEl = document.getElementById('gh-result-icon');
        iconEl.className = `gh-result-icon ${success ? 'success' : 'error'}`;
        iconEl.innerHTML = success
            ? '<i class="fas fa-check-circle"></i>'
            : '<i class="fas fa-times-circle"></i>';

        document.getElementById('gh-result-message').textContent = success
            ? `Repository "${repo.name}" created and uploaded successfully.`
            : (errorMsg || 'The upload could not be completed.');

        const closeBtn = document.getElementById('gh-result-close');
        if (closeBtn) {
            closeBtn.textContent = success ? 'Done' : 'Back to Upload';
            closeBtn.classList.toggle('retry', !success);
        }

        const linkEl = document.getElementById('gh-result-link');
        if (success && repo && repo.html_url) {
            linkEl.style.display = 'inline-flex';
            linkEl.onclick = (e) => {
                e.preventDefault();
                ipcRenderer.invoke('open-external', repo.html_url);
            };
        } else {
            linkEl.style.display = 'none';
        }
    }, success ? 600 : 300);
}

// Listen for progress events from main process
ipcRenderer.on('github-upload-progress', (event, data) => {
    ghUploadProgressUpdate(data.step, data.status, data.detail);
});

// Close progress overlay and modal
document.getElementById('gh-result-close')?.addEventListener('click', () => {
    const overlay = document.getElementById('gh-upload-progress');
    if (overlay) overlay.classList.remove('active');
    setGitHubUploadProgressMode(false);

    if (githubUploadLastResultSuccessful) {
        hideModal('github-upload-modal');
        return;
    }

    document.getElementById('github-repo-name')?.focus();
    updateGitHubUploadSubmitState();
});

// Update status message
function updateStatusMessage(message) {
    const statusMessageEl = document.getElementById('status-message');
    if (!statusMessageEl) return;

    statusMessageEl.textContent = message;

    if (statusMessageTimeout) {
        clearTimeout(statusMessageTimeout);
    }

    statusMessageTimeout = setTimeout(() => {
        statusMessageEl.textContent = 'Ready';
    }, 3000);
}

// Auto-update workspace path in project location + live validation
document.getElementById('project-name')?.addEventListener('input', (e) => {
    const projectName = e.target.value;
    const locationInput = document.getElementById('project-location');
    const hint = document.getElementById('project-name-hint');
    const input = e.target;

    if (!locationInput.dataset.customPath) {
        locationInput.value = path.join(workspacePath, projectName);
    }

    // Live validation hint
    if (hint) {
        if (projectName.length === 0) {
            hint.textContent = '';
            input.style.borderColor = '';
        } else {
            const validation = validateProjectName(projectName);
            if (!validation.valid) {
                hint.textContent = validation.error;
                hint.style.color = '#f48771';
                input.style.borderColor = '#5c3030';
            } else {
                hint.textContent = '';
                input.style.borderColor = '';
            }
        }
    }
});

document.getElementById('project-location')?.addEventListener('input', (e) => {
    e.target.dataset.customPath = 'true';
});

// Clear recent projects
document.getElementById('clear-recent')?.addEventListener('click', async () => {
    if (confirm('Are you sure you want to clear all recent projects?')) {
        recentProjects = [];
        await ipcRenderer.invoke('save-recent-projects', []); // Clear the saved list
        displayRecentProjects();
        updateStatusProjectCounts(document.querySelectorAll('#all-projects-list .project-card-modern').length, 0);
        updateActivityStats();
        showNotification('Recent projects cleared', 'success');
    }
});

// Custom Template Dropdown
function initializeTemplateDropdown() {
    const dropdown = document.getElementById('np-template-dropdown');
    const trigger = document.getElementById('np-dropdown-trigger');
    const menu = document.getElementById('np-dropdown-menu');
    const hiddenInput = document.getElementById('project-type');

    if (!dropdown || !trigger || !menu || !hiddenInput) return;

    // Toggle menu on trigger click
    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.toggle('open');

        // Scroll selected item into view
        if (dropdown.classList.contains('open')) {
            const selected = menu.querySelector('.np-dropdown-item.selected');
            if (selected) {
                setTimeout(() => selected.scrollIntoView({ block: 'nearest' }), 50);
            }
        }
    });

    // Handle item selection
    menu.querySelectorAll('.np-dropdown-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            const value = item.dataset.value;
            const icon = item.querySelector('.np-tmpl-icon');
            const name = item.querySelector('.np-dropdown-item-name').textContent;

            // Set hidden input value
            hiddenInput.value = value;

            // Update trigger label with icon + name
            const label = document.getElementById('np-dropdown-label');
            const iconStyle = icon ? icon.getAttribute('style') : '';
            const iconClass = icon ? icon.className.replace('np-tmpl-icon', '').trim() : 'fas fa-layer-group';
            label.innerHTML = `<i class="${iconClass}" style="${iconStyle}"></i> ${name}`;
            trigger.classList.add('has-value');

            // Update selected state
            menu.querySelectorAll('.np-dropdown-item').forEach(i => i.classList.remove('selected'));
            item.classList.add('selected');

            // Close menu
            dropdown.classList.remove('open');
        });
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
        if (!dropdown.contains(e.target)) {
            dropdown.classList.remove('open');
        }
    });

    // Close on Escape
    dropdown.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            dropdown.classList.remove('open');
            trigger.focus();
        }
    });
}

// Reset the template dropdown to placeholder state
function resetTemplateDropdown() {
    const dropdown = document.getElementById('np-template-dropdown');
    const trigger = document.getElementById('np-dropdown-trigger');
    const label = document.getElementById('np-dropdown-label');
    const menu = document.getElementById('np-dropdown-menu');
    const hiddenInput = document.getElementById('project-type');

    if (hiddenInput) hiddenInput.value = '';
    if (label) label.innerHTML = '<i class="fas fa-layer-group np-dropdown-placeholder-icon"></i> Select a template...';
    if (trigger) trigger.classList.remove('has-value');
    if (menu) menu.querySelectorAll('.np-dropdown-item').forEach(i => i.classList.remove('selected'));
    if (dropdown) dropdown.classList.remove('open');
}

// Enhanced Projects View Logic
let projectSearchTimeout = null;

function initializeProjectsView() {
    // Project search with debounce for better performance
    document.getElementById('project-search')?.addEventListener('input', (e) => {
        if (projectSearchTimeout) clearTimeout(projectSearchTimeout);
        projectSearchTimeout = setTimeout(() => {
            filterProjects(e.target.value);
        }, 150);
    });

    // Project sorting
    document.getElementById('project-sort')?.addEventListener('change', (e) => {
        sortProjects(e.target.value);
    });

    // Filter tabs
    document.querySelectorAll('.filter-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            filterProjectsByType(tab.dataset.filter);
        });
    });

    // View toggle (grid/list)
    document.querySelectorAll('.view-toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.view-toggle-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            toggleProjectsView(btn.dataset.view);
        });
    });

    // Update stats when view loads
    updateProjectStats();
}

function filterProjects(query) {
    const projectCards = document.querySelectorAll('#all-projects-list .project-card-modern');
    const lowerQuery = query.toLowerCase();

    projectCards.forEach(card => {
        const name = card.querySelector('h3')?.textContent.toLowerCase() || '';
        const path = card.querySelector('.project-path-modern')?.textContent.toLowerCase() || '';

        if (name.includes(lowerQuery) || path.includes(lowerQuery)) {
            card.style.display = '';
        } else {
            card.style.display = 'none';
        }
    });
}

function sortProjects(sortBy, options = {}) {
    const projectsList = document.getElementById('all-projects-list');
    if (!projectsList) return;

    const projects = Array.from(projectsList.querySelectorAll('.project-card-modern'));

    projects.sort((a, b) => {
        const favoriteA = a.dataset.favorite === 'true' ? 1 : 0;
        const favoriteB = b.dataset.favorite === 'true' ? 1 : 0;
        if (favoriteA !== favoriteB) {
            return favoriteB - favoriteA;
        }

        switch(sortBy) {
            case 'name':
                const nameA = a.querySelector('h3')?.textContent || '';
                const nameB = b.querySelector('h3')?.textContent || '';
                return nameA.localeCompare(nameB);
            case 'date':
                const dateA = a.dataset.modified || '0';
                const dateB = b.dataset.modified || '0';
                return parseInt(dateB) - parseInt(dateA);
            case 'type':
                const typeA = a.dataset.type || '';
                const typeB = b.dataset.type || '';
                return typeA.localeCompare(typeB);
            default:
                return 0;
        }
    });

    projects.forEach(project => projectsList.appendChild(project));
    if (!options.silent) {
        showNotification(`Projects sorted by ${sortBy}`, 'info');
    }
}

function filterProjectsByType(type) {
    const projectCards = document.querySelectorAll('#all-projects-list .project-card-modern');
    const commonTypes = new Set(['web', 'node', 'nodejs', 'python', 'react']);

    projectCards.forEach(card => {
        const cardType = card.dataset.type || '';
        const matchesNode = type === 'node' && (cardType === 'node' || cardType === 'nodejs');
        const matchesOther = type === 'other' && !commonTypes.has(cardType);

        if (type === 'all' || cardType === type || matchesNode || matchesOther) {
            card.style.display = '';
        } else {
            card.style.display = 'none';
        }
    });

    showNotification(`Filtered by: ${type}`, 'info');
}

function toggleProjectsView(viewType) {
    const projectsList = document.getElementById('all-projects-list');

    if (viewType === 'list') {
        projectsList.classList.remove('grid-view');
        projectsList.classList.add('list-view');
    } else {
        projectsList.classList.remove('list-view');
        projectsList.classList.add('grid-view');
    }
}

async function updateProjectStats() {
    try {
        const projectCards = document.querySelectorAll('#all-projects-list .project-card-modern');
        const totalProjects = projectCards.length;

        // Count active projects (modified in last 7 days)
        const weekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
        let activeProjects = 0;
        let gitProjects = 0;

        projectCards.forEach(card => {
            const modified = parseInt(card.dataset.modified || '0');
            if (modified > weekAgo) activeProjects++;
            if (card.dataset.hasGit === 'true') gitProjects++;
        });

        // Update stat displays in projects view
        const totalProjectsEl = document.getElementById('total-projects');
        const activeProjectsEl = document.getElementById('active-projects');
        const gitProjectsEl = document.getElementById('git-projects');

        if (totalProjectsEl) totalProjectsEl.textContent = totalProjects;
        if (activeProjectsEl) activeProjectsEl.textContent = activeProjects;
        if (gitProjectsEl) gitProjectsEl.textContent = gitProjects;

        // Update hero section stats
        const heroTotalProjects = document.getElementById('hero-total-projects');
        if (heroTotalProjects) heroTotalProjects.textContent = totalProjects;
        updateStatusProjectCounts(totalProjects, recentProjects.length);

        // Calculate total size (mock data for now)
        const estimatedSize = totalProjects * 50; // Rough estimate
        const totalSizeEl = document.getElementById('total-size');
        if (totalSizeEl) {
            totalSizeEl.textContent = estimatedSize >= 1024
                ? `${(estimatedSize / 1024).toFixed(1)} GB`
                : `${estimatedSize} MB`;
        }

        // Fetch and update GitHub repositories count if user is authenticated
        await updateGitHubReposCount();
    } catch (error) {
        console.error('Error updating project stats:', error);
    }
}

// Fetch GitHub repositories count using stored token
async function updateGitHubReposCount() {
    try {
        const result = await ipcRenderer.invoke('github-get-user');
        if (result.success && result.user) {
            githubUserData = result.user;
            githubLastSyncedAt = new Date();
            const reposCount = result.user.public_repos || 0;

            const heroGitRepos = document.getElementById('hero-git-repos');
            if (heroGitRepos) {
                heroGitRepos.textContent = reposCount;
            }

            setStatusConnectionState(true);
            updateGitHubAvatar();
            updateGitHubSyncMeta();
            return;
        }

        if (result.error === 'No GitHub token found') {
            githubUserData = null;
            githubLastSyncedAt = null;
            setStatusConnectionState(false);
            updateGitHubAvatar();
            updateGitHubSyncMeta();
        }

        const heroGitRepos = document.getElementById('hero-git-repos');
        if (heroGitRepos) heroGitRepos.textContent = '0';
    } catch (error) {
        console.error('Error fetching GitHub repos count:', error);
        const heroGitRepos = document.getElementById('hero-git-repos');
        if (heroGitRepos) heroGitRepos.textContent = '0';
    }
}

// Enhanced Recent Activity View Logic
let activityLog = [];

function initializeRecentView() {
    // Activity filter
    document.getElementById('activity-filter')?.addEventListener('change', (e) => {
        filterActivities(e.target.value);
    });

    // Timeline period buttons
    document.querySelectorAll('.timeline-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.timeline-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            filterActivitiesByPeriod(btn.dataset.period);
        });
    });

    // Export activity
    document.getElementById('export-activity')?.addEventListener('click', () => {
        exportActivityLog();
    });

    // Load and display activities
    loadActivityLog();
    updateActivityStats();
}

function loadActivityLog() {
    // Initialize with some sample activities
    if (activityLog.length === 0) {
        activityLog = [
            {
                type: 'project',
                title: 'Opened Project',
                description: 'AppManager project opened in VS Code',
                timestamp: Date.now() - 1000 * 60 * 30, // 30 min ago
                meta: { project: 'AppManager' }
            },
            {
                type: 'git',
                title: 'Git Commit',
                description: 'Committed changes: "Enhanced UI components"',
                timestamp: Date.now() - 1000 * 60 * 60 * 2, // 2 hours ago
                meta: { files: 5 }
            },
            {
                type: 'extension',
                title: 'Extension Installed',
                description: 'Code Formatter extension installed',
                timestamp: Date.now() - 1000 * 60 * 60 * 4, // 4 hours ago
                meta: { extension: 'Code Formatter' }
            },
            {
                type: 'settings',
                title: 'Settings Changed',
                description: 'Updated theme and appearance settings',
                timestamp: Date.now() - 1000 * 60 * 60 * 24, // 1 day ago
                meta: { category: 'Appearance' }
            }
        ];
    }

    displayActivities(activityLog);
}

function displayActivities(activities) {
    const container = document.getElementById('recent-activity-list');
    if (!container) return;

    if (activities.length === 0) {
        container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 40px;">No activities to display</p>';
        return;
    }

    container.innerHTML = activities.map((activity, index) => {
        const safeType = ['project', 'git', 'extension', 'settings', 'github', 'error', 'ui'].includes(activity.type)
            ? activity.type
            : 'project';
        const timeAgo = formatTimeAgo(activity.timestamp);
        const icon = getActivityIcon(safeType);
        const safeTitle = escapeHtml(activity.title || 'Activity');
        const safeDescription = escapeHtml(activity.description || '');
        const connector = index < activities.length - 1 ? '<div class="timeline-connector"></div>' : '';

        return `
            <div class="timeline-item activity-type-${safeType}">
                <div class="timeline-icon">
                    <i class="fas fa-${icon}"></i>
                </div>
                <div class="timeline-content">
                    <div class="timeline-header">
                        <span class="timeline-title">${safeTitle}</span>
                        <span class="timeline-time">${timeAgo}</span>
                    </div>
                    <div class="timeline-description">${safeDescription}</div>
                    ${activity.meta ? `
                        <div class="timeline-meta">
                            ${Object.entries(activity.meta).map(([key, value]) =>
                                `<span><i class="fas fa-tag"></i> ${escapeHtml(String(key))}: ${escapeHtml(String(value))}</span>`
                            ).join('')}
                        </div>
                    ` : ''}
                </div>
            </div>
            ${connector}
        `;
    }).join('');
}

function getActivityIcon(type) {
    const icons = {
        project: 'folder-open',
        git: 'code-branch',
        extension: 'puzzle-piece',
        settings: 'cog'
    };
    return icons[type] || 'circle';
}

function formatTimeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);

    if (seconds < 60) return 'Just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
    if (seconds < 2592000) return `${Math.floor(seconds / 86400)} days ago`;
    return `${Math.floor(seconds / 2592000)} months ago`;
}

function filterActivities(type) {
    if (type === 'all') {
        displayActivities(activityLog);
    } else {
        const filtered = activityLog.filter(activity => activity.type === type);
        displayActivities(filtered);
    }
}

function filterActivitiesByPeriod(period) {
    const now = Date.now();
    let cutoff;

    switch(period) {
        case 'today':
            cutoff = now - (24 * 60 * 60 * 1000);
            break;
        case 'week':
            cutoff = now - (7 * 24 * 60 * 60 * 1000);
            break;
        case 'month':
            cutoff = now - (30 * 24 * 60 * 60 * 1000);
            break;
        case 'all':
        default:
            displayActivities(activityLog);
            return;
    }

    const filtered = activityLog.filter(activity => activity.timestamp >= cutoff);
    displayActivities(filtered);
    showNotification(`Showing activities from ${period}`, 'info');
}

function updateActivityStats() {
    const now = Date.now();
    const dayAgo = now - (24 * 60 * 60 * 1000);
    const weekAgo = now - (7 * 24 * 60 * 60 * 1000);

    const activitiesToday = activityLog.filter(a => a.timestamp >= dayAgo).length;
    const activitiesWeek = activityLog.filter(a => a.timestamp >= weekAgo).length;
    const projectsOpened = activityLog.filter(a => a.type === 'project').length;
    const gitOperations = activityLog.filter(a => a.type === 'git').length;

    document.getElementById('activities-today').textContent = activitiesToday;
    document.getElementById('activities-week').textContent = activitiesWeek;
    document.getElementById('projects-opened').textContent = projectsOpened;
    document.getElementById('git-operations').textContent = gitOperations;
}

function logActivity(type, title, description, meta = {}) {
    const activity = {
        type,
        title,
        description,
        timestamp: Date.now(),
        meta
    };

    activityLog.unshift(activity); // Add to beginning

    // Keep only last 100 activities
    if (activityLog.length > 100) {
        activityLog = activityLog.slice(0, 100);
    }

    // Update displays if on recent view
    if (currentView === 'recent') {
        displayActivities(activityLog);
        updateActivityStats();
    }
}

function exportActivityLog() {
    try {
        const exportData = {
            exported: new Date().toISOString(),
            totalActivities: activityLog.length,
            activities: activityLog
        };

        const dataStr = JSON.stringify(exportData, null, 2);
        const dataBlob = new Blob([dataStr], { type: 'application/json' });

        const link = document.createElement('a');
        link.href = URL.createObjectURL(dataBlob);
        link.download = `appmanager-activity-${Date.now()}.json`;
        link.click();

        showNotification('Activity log exported successfully', 'success');
    } catch (error) {
        console.error('Export failed:', error);
        showNotification('Failed to export activity log', 'error');
    }
}

// Delete Project Functionality
let projectToDelete = null;

function initializeDeleteProjectModal() {
    const deleteTypeRadios = document.querySelectorAll('input[name="delete-type"]');
    const confirmationSection = document.getElementById('delete-confirmation-section');
    const confirmInput = document.getElementById('delete-confirm-input');
    const confirmBtn = document.getElementById('confirm-delete-btn');
    const deleteBtnText = document.getElementById('delete-btn-text');

    // Handle delete type change
    deleteTypeRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            const deleteType = e.target.value;

            if (deleteType === 'delete') {
                // Show confirmation input for permanent deletion
                confirmationSection.style.display = 'block';
                deleteBtnText.textContent = 'Delete Permanently';
                confirmBtn.disabled = true;
                confirmInput.value = '';
            } else {
                // Hide confirmation for remove from app
                confirmationSection.style.display = 'none';
                deleteBtnText.textContent = 'Remove from App';
                confirmBtn.disabled = false;
            }
        });
    });

    // Handle confirmation input
    confirmInput?.addEventListener('input', (e) => {
        const deleteType = document.querySelector('input[name="delete-type"]:checked')?.value;

        if (deleteType === 'delete' && projectToDelete) {
            const inputValue = e.target.value.trim();
            const projectName = projectToDelete.name;

            // Enable button only if project name matches exactly
            confirmBtn.disabled = inputValue !== projectName;
        }
    });

    // Handle confirm delete button
    confirmBtn?.addEventListener('click', async () => {
        const deleteType = document.querySelector('input[name="delete-type"]:checked')?.value;

        if (!projectToDelete) {
            showNotification('No project selected for deletion', 'error');
            return;
        }

        if (deleteType === 'delete') {
            // Permanent deletion
            await deleteProjectPermanently(projectToDelete);
        } else {
            // Remove from app only
            await removeProjectFromApp(projectToDelete);
        }

        hideModal('delete-project-modal');
        resetDeleteModal();
    });
}

function showDeleteProjectModal(project) {
    const normalizedSettings = normalizeSettings(appSettings);
    if (!normalizedSettings.confirmDelete) {
        void removeProjectFromApp(project);
        return;
    }

    projectToDelete = project;

    // Populate project info
    document.getElementById('delete-project-name').textContent = project.name;
    document.getElementById('delete-project-path').textContent = project.path;

    // Set confirmation name
    const confirmNameEl = document.getElementById('delete-confirm-name');
    if (confirmNameEl) {
        confirmNameEl.textContent = project.name;
    }

    // Reset modal state
    resetDeleteModal();

    // Show modal
    showModal('delete-project-modal');
}

function resetDeleteModal() {
    // Reset radio buttons
    const removeRadio = document.querySelector('input[name="delete-type"][value="remove"]');
    if (removeRadio) removeRadio.checked = true;

    // Hide confirmation section
    document.getElementById('delete-confirmation-section').style.display = 'none';

    // Reset confirmation input
    document.getElementById('delete-confirm-input').value = '';

    // Reset button
    document.getElementById('confirm-delete-btn').disabled = false;
    document.getElementById('delete-btn-text').textContent = 'Remove from App';
}

async function removeProjectFromApp(project) {
    try {
        const removedKey = normalizeRecentProjectPath(project.path);

        // Remove from recent projects array
        recentProjects = recentProjects.filter(p => p.path !== project.path);

        // Save updated list
        await ipcRenderer.invoke('save-recent-projects', recentProjects);

        if (normalizeRecentProjectPath(currentProject?.path || '') === removedKey) {
            currentProject = null;
            updateStatusBarProject('No project selected');
            setSelectedProjectCardByPath('');
        }

        // Update UI
        displayRecentProjects();
        updateProjectStats();
        updateActivityStats();

        // Refresh all projects list if currently viewing projects
        if (currentView === 'projects') {
            await loadAllProjects();
        }

        // Log activity
        logActivity('project', 'Project Removed', `Removed ${project.name} from app`, {
            project: project.name
        });

        showNotification(`${project.name} removed from app`, 'success');
    } catch (error) {
        handleError(error, 'Remove Project');
    }
}

async function deleteProjectPermanently(project) {
    try {
        const deletedKey = normalizeRecentProjectPath(project.path);

        // Call IPC to delete files from disk
        const result = await ipcRenderer.invoke('delete-project-files', project.path);

        if (result.success) {
            setProjectFavorite(project.path, false);
            syncFavoriteStateAcrossCards(project.path);

            // Remove from recent projects
            recentProjects = recentProjects.filter(p => p.path !== project.path);
            await ipcRenderer.invoke('save-recent-projects', recentProjects);

            if (normalizeRecentProjectPath(currentProject?.path || '') === deletedKey) {
                currentProject = null;
                updateStatusBarProject('No project selected');
                setSelectedProjectCardByPath('');
            }

            // Update UI
            displayRecentProjects();
            updateProjectStats();
            updateActivityStats();

            // Refresh all projects list if currently viewing projects
            if (currentView === 'projects') {
                await loadAllProjects();
            }

            // Log activity
            logActivity('project', 'Project Deleted', `Permanently deleted ${project.name}`, {
                project: project.name,
                path: project.path
            });

            showNotification(`${project.name} permanently deleted`, 'success');
        } else {
            throw new Error(result.error || 'Failed to delete project files');
        }
    } catch (error) {
        handleError(error, 'Delete Project');
    }
}

// Enhanced error handling and validation
function validateProjectName(name) {
    if (!name || name.trim().length === 0) {
        return { valid: false, error: 'Project name cannot be empty' };
    }

    if (!/^[a-zA-Z0-9-_\s]+$/.test(name)) {
        return { valid: false, error: 'Project name contains invalid characters' };
    }

    if (name.length > 50) {
        return { valid: false, error: 'Project name is too long (max 50 characters)' };
    }

    return { valid: true };
}

function handleError(error, context = 'Operation') {
    console.error(`${context} error:`, error);

    const errorMessage = error.message || 'An unknown error occurred';
    showNotification(`${context} failed: ${errorMessage}`, 'error');

    // Log error activity
    logActivity('error', `${context} Failed`, errorMessage, {
        stack: error.stack?.split('\n')[0]
    });
}

// Wrap critical functions with error handling
const originalShowModal = showModal;
showModal = function(modalId) {
    try {
        originalShowModal(modalId);
        logActivity('ui', 'Modal Opened', `Opened ${modalId} modal`);
    } catch (error) {
        handleError(error, 'Show Modal');
    }
};

// IPC event listeners
ipcRenderer.on('theme-changed', (event, theme) => {
    applyTheme(theme);
});

ipcRenderer.on('show-command-palette', () => {
    showModal('command-palette-modal');
});

// =========================
// GitHub Authentication
// =========================
let githubUserData = null;
let githubLastSyncedAt = null;
const GITHUB_LOGIN_BUTTON_DEFAULT_HTML = `
    <span class="btn-icon">
        <i class="fab fa-github"></i>
    </span>
    <span class="btn-text">Connect Account</span>
    <span class="btn-shine"></span>
`;
const GITHUB_LOGIN_BUTTON_CONNECTED_HTML = `
    <span class="btn-icon">
        <i class="fas fa-check"></i>
    </span>
    <span class="btn-text">Connected</span>
    <span class="btn-shine"></span>
`;
const GITHUB_DASHBOARD_ACTION_BUTTON_IDS = ['view-profile-btn', 'sync-repos-btn', 'refresh-data-btn', 'github-disconnect-btn'];

function formatGitHubSyncTime(dateValue) {
    if (!(dateValue instanceof Date) || Number.isNaN(dateValue.getTime())) {
        return 'Last synced just now';
    }

    return `Last synced ${dateValue.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function updateGitHubSyncMeta() {
    const syncMetaEl = document.getElementById('github-sync-meta');
    if (!syncMetaEl) {
        return;
    }

    syncMetaEl.textContent = formatGitHubSyncTime(githubLastSyncedAt);
}

function setGitHubDashboardStatus(message = '', type = 'info') {
    const statusEl = document.getElementById('github-dashboard-status');
    if (!statusEl) {
        return;
    }

    if (!message) {
        statusEl.textContent = '';
        statusEl.className = 'github-dashboard-status';
        statusEl.style.display = 'none';
        return;
    }

    const iconMap = {
        success: 'fa-check-circle',
        error: 'fa-triangle-exclamation',
        loading: 'fa-spinner fa-spin',
        info: 'fa-circle-info'
    };
    const iconClass = iconMap[type] || iconMap.info;
    const safeMessage = escapeHtml(message);
    statusEl.className = `github-dashboard-status ${type}`;
    statusEl.innerHTML = `<i class="fas ${iconClass}"></i><span>${safeMessage}</span>`;
    statusEl.style.display = 'flex';
}

function setGitHubDashboardBusy(isBusy, activeButtonId = '', busyLabel = 'Working...') {
    GITHUB_DASHBOARD_ACTION_BUTTON_IDS.forEach((buttonId) => {
        const button = document.getElementById(buttonId);
        if (!button) {
            return;
        }

        if (isBusy && buttonId === activeButtonId) {
            if (!button.dataset.originalHtml) {
                button.dataset.originalHtml = button.innerHTML;
            }
            button.innerHTML = `<i class="fas fa-spinner fa-spin"></i><span>${escapeHtml(busyLabel)}</span>`;
            button.classList.add('is-busy');
            button.disabled = true;
            return;
        }

        if (!isBusy && button.dataset.originalHtml) {
            button.innerHTML = button.dataset.originalHtml;
            delete button.dataset.originalHtml;
        }

        button.classList.remove('is-busy');
        button.disabled = Boolean(isBusy);
    });
}

function normalizeDisplayUrl(urlInput) {
    if (typeof urlInput !== 'string') {
        return null;
    }

    const trimmedUrl = urlInput.trim();
    if (!trimmedUrl) {
        return null;
    }

    const withProtocol = /^https?:\/\//i.test(trimmedUrl) ? trimmedUrl : `https://${trimmedUrl}`;

    try {
        const parsedUrl = new URL(withProtocol);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            return null;
        }
        return parsedUrl.toString();
    } catch {
        return null;
    }
}

function updateGitHubLoginModalState() {
    const statusEl = document.getElementById('github-login-status');
    const connectBtn = document.getElementById('github-login-connect-btn');
    const tokenInput = document.getElementById('github-token-input');
    if (!statusEl || !connectBtn || !tokenInput) {
        return;
    }

    if (githubUserData && githubUserData.login) {
        const safeLogin = escapeHtml(githubUserData.login);
        const safeName = escapeHtml(githubUserData.name || githubUserData.login || 'GitHub user');
        statusEl.innerHTML = `
            <i class="fas fa-check-circle"></i>
            <span><strong>Connected</strong> as @${safeLogin} (${safeName})</span>
        `;
        statusEl.style.display = 'flex';
        connectBtn.classList.add('is-connected');
        connectBtn.innerHTML = GITHUB_LOGIN_BUTTON_CONNECTED_HTML;
        tokenInput.placeholder = 'Connected. Paste another token to switch account.';
        return;
    }

    statusEl.innerHTML = '';
    statusEl.style.display = 'none';
    connectBtn.classList.remove('is-connected');
    connectBtn.innerHTML = GITHUB_LOGIN_BUTTON_DEFAULT_HTML;
    tokenInput.placeholder = 'ghp_xxxxxxxxxxxxxxxxxxxx';
}

function openGitHubLoginModal() {
    showModal('github-login-modal');
    updateGitHubLoginModalState();

    const tokenInput = document.getElementById('github-token-input');
    if (tokenInput) {
        setTimeout(() => tokenInput.focus(), 40);
    }
}

// Load saved GitHub token on startup
async function loadGitHubToken() {
    try {
        const result = await ipcRenderer.invoke('github-get-user');
        if (result.success && result.user) {
            githubUserData = result.user;
            githubLastSyncedAt = new Date();
            setStatusConnectionState(true);
            updateGitHubAvatar();
            updateGitHubLoginModalState();
            updateGitHubSyncMeta();
            return;
        }

        githubUserData = null;
        githubLastSyncedAt = null;
        setStatusConnectionState(false);
        updateGitHubAvatar();
        updateGitHubLoginModalState();
        updateGitHubSyncMeta();
    } catch (error) {
        setStatusConnectionState(false);
        githubUserData = null;
        githubLastSyncedAt = null;
        updateGitHubAvatar();
        updateGitHubLoginModalState();
        updateGitHubSyncMeta();
        console.error('Failed to load GitHub token:', error);
    }
}

// GitHub account button click
document.getElementById('github-account-btn')?.addEventListener('click', () => {
    if (githubUserData) {
        // Show account info modal or context menu
        showGitHubAccountInfo();
    } else {
        openGitHubLoginModal();
    }
});

// Toggle token visibility
document.getElementById('toggle-token-visibility')?.addEventListener('click', function() {
    const tokenInput = document.getElementById('github-token-input');
    const icon = this.querySelector('i');

    if (tokenInput.type === 'password') {
        tokenInput.type = 'text';
        icon.classList.remove('fa-eye');
        icon.classList.add('fa-eye-slash');
    } else {
        tokenInput.type = 'password';
        icon.classList.remove('fa-eye-slash');
        icon.classList.add('fa-eye');
    }
});

async function submitGitHubLoginFromModal() {
    const token = document.getElementById('github-token-input').value.trim();

    if (!token) {
        if (githubUserData?.login) {
            showNotification(`Already connected as ${githubUserData.login}`, 'success');
            updateGitHubLoginModalState();
            return;
        }

        showNotification('Please enter your GitHub personal access token', 'error');
        return;
    }

    if (token.length < 20) {
        showNotification('Token appears too short. Please check and try again.', 'error');
        return;
    }

    await authenticateGitHub(token, true);
}

// GitHub login connect button
document.getElementById('github-login-connect-btn')?.addEventListener('click', async () => {
    await submitGitHubLoginFromModal();
});

document.getElementById('github-token-input')?.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter') {
        return;
    }

    event.preventDefault();
    await submitGitHubLoginFromModal();
});

document.getElementById('github-token-help')?.addEventListener('click', (event) => {
    event.preventDefault();
    ipcRenderer.invoke('open-external', 'https://github.com/settings/tokens');
});

// GitHub login cancel button
document.querySelector('#github-login-modal .btn-github-cancel')?.addEventListener('click', () => {
    hideModal('github-login-modal');
    document.getElementById('github-token-input').value = '';
});

// Authenticate with GitHub
async function authenticateGitHub(token, showMessages = true) {
    try {
        if (showMessages) {
            showNotification('Connecting to GitHub...', 'info');
        }

        const saveResult = await ipcRenderer.invoke('github-save-token', token);
        if (!saveResult || !saveResult.success) {
            throw new Error(saveResult?.error || 'Failed to save GitHub token');
        }

        let userData = saveResult.user;
        if (!userData) {
            const userResult = await ipcRenderer.invoke('github-get-user');
            if (!userResult.success || !userResult.user) {
                throw new Error(userResult.error || 'Failed to fetch GitHub user details');
            }
            userData = userResult.user;
        }

        // Save user data and token
        githubUserData = userData;
        githubLastSyncedAt = new Date();
        setStatusConnectionState(true);

        // Update UI
        updateGitHubAvatar();

        // Update welcome screen stats with GitHub repos count
        await updateGitHubReposCount();
        await updateGitHubStatus();

        const tokenInput = document.getElementById('github-token-input');
        if (tokenInput) {
            tokenInput.value = '';
        }
        updateGitHubLoginModalState();

        if (showMessages) {
            showNotification(`Connected as ${userData.login}`, 'success');
            logActivity('github', 'GitHub Connected', `Authenticated as ${userData.login}`, {
                username: userData.login,
                name: userData.name
            });
        }
    } catch (error) {
        console.error('GitHub authentication error:', error);

        // Clear saved data on error
        try {
            await ipcRenderer.invoke('github-disconnect');
        } catch (disconnectError) {
            console.error('Failed to clear GitHub token after auth failure:', disconnectError);
        }
        githubUserData = null;
        setStatusConnectionState(false);
        updateGitHubAvatar();
        updateGitHubLoginModalState();

        if (showMessages) {
            showNotification(error.message, 'error');
        }
    }
}

// Update GitHub avatar in sidebar
function createFallbackAvatarDataUrl(label = 'GH') {
    const safeLabel = String(label || 'GH').trim().slice(0, 2).toUpperCase() || 'GH';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#2a82d6"/><stop offset="100%" stop-color="#19b8ff"/></linearGradient></defs><rect width="96" height="96" rx="18" fill="url(#g)"/><text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" fill="#ffffff" font-family="Segoe UI, Arial, sans-serif" font-size="36" font-weight="700">${safeLabel}</text></svg>`;
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function buildHiResAvatarUrl(rawUrl, size = 192) {
    if (!rawUrl || typeof rawUrl !== 'string') {
        return '';
    }

    const safeSize = Math.max(96, Math.min(512, Number(size) || 192));
    try {
        const parsed = new URL(rawUrl);
        parsed.searchParams.set('s', String(safeSize));
        return parsed.toString();
    } catch (error) {
        return rawUrl;
    }
}

function updateGitHubAvatar() {
    const accountBtn = document.getElementById('github-account-btn');
    const avatar = document.getElementById('account-avatar');

    if (!accountBtn || !avatar) return;

    if (githubUserData && githubUserData.avatar_url) {
        accountBtn.classList.add('logged-in');
        avatar.textContent = '';

        const avatarImage = document.createElement('img');
        avatarImage.className = 'is-loading';
        avatarImage.referrerPolicy = 'no-referrer';
        avatarImage.loading = 'eager';
        avatarImage.decoding = 'async';
        avatarImage.fetchPriority = 'high';
        avatarImage.onload = async () => {
            try {
                if (typeof avatarImage.decode === 'function') {
                    await avatarImage.decode();
                }
            } catch (decodeError) {
                // Continue: decode can fail if image data is already consumed.
            }
            avatarImage.classList.remove('is-loading');
            avatarImage.classList.add('is-ready');
        };
        avatarImage.onerror = () => {
            avatarImage.onerror = null;
            avatarImage.src = createFallbackAvatarDataUrl(githubUserData.login || 'GH');
        };
        avatarImage.srcset = `${buildHiResAvatarUrl(githubUserData.avatar_url, 128)} 1x, ${buildHiResAvatarUrl(githubUserData.avatar_url, 256)} 2x`;
        avatarImage.sizes = '38px';
        avatarImage.src = buildHiResAvatarUrl(githubUserData.avatar_url, 192);
        avatarImage.alt = githubUserData.login || 'GitHub avatar';
        avatar.appendChild(avatarImage);

        if (avatarImage.complete) {
            avatarImage.classList.remove('is-loading');
            avatarImage.classList.add('is-ready');
        }

        // Update tooltip
        const tooltip = accountBtn.querySelector('.tooltip');
        if (tooltip) {
            const tooltipTitle = tooltip.querySelector('.tooltip-title');
            const tooltipDesc = tooltip.querySelector('.tooltip-desc');
            if (tooltipTitle) {
                tooltipTitle.textContent = githubUserData.login || 'GitHub Account';
            }
            if (tooltipDesc) {
                tooltipDesc.textContent = 'Connected account';
            }
        }
    } else {
        accountBtn.classList.remove('logged-in');
        avatar.textContent = '';

        const icon = document.createElement('i');
        icon.className = 'fab fa-github';
        avatar.appendChild(icon);

        // Reset tooltip
        const tooltip = accountBtn.querySelector('.tooltip');
        if (tooltip) {
            const tooltipTitle = tooltip.querySelector('.tooltip-title');
            const tooltipDesc = tooltip.querySelector('.tooltip-desc');
            if (tooltipTitle) {
                tooltipTitle.textContent = 'GitHub Account';
            }
            if (tooltipDesc) {
                tooltipDesc.textContent = 'Profile, sync and authentication';
            }
        }
    }

    updateSidebarItemAccessibility(accountBtn);
}

function setGitHubDetailLink(elementId, rawUrl, fallbackText = 'Not set') {
    const element = document.getElementById(elementId);
    if (!element) {
        return;
    }

    const normalizedUrl = normalizeDisplayUrl(rawUrl);
    if (!normalizedUrl) {
        element.textContent = fallbackText;
        element.removeAttribute('href');
        element.classList.add('is-empty');
        return;
    }

    element.href = normalizedUrl;
    element.textContent = normalizedUrl.replace(/^https?:\/\//i, '');
    element.classList.remove('is-empty');
}

// Show GitHub Account Dashboard
function showGitHubAccountInfo() {
    if (!githubUserData) return;

    const createdDate = githubUserData.created_at ? new Date(githubUserData.created_at) : null;
    const createdDisplay = createdDate && !Number.isNaN(createdDate.getTime())
        ? createdDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long' })
        : '-';

    // Populate profile
    document.getElementById('github-username-display').textContent = githubUserData.login || 'Username';
    document.getElementById('github-name-display').textContent = githubUserData.name || 'No public name';

    // Update avatar
    const avatarLarge = document.getElementById('github-avatar-large');
    if (avatarLarge) {
        const avatarImage = avatarLarge.querySelector('img');
        if (avatarImage) {
            avatarImage.referrerPolicy = 'no-referrer';
            avatarImage.onerror = () => {
                avatarImage.onerror = null;
                avatarImage.src = createFallbackAvatarDataUrl(githubUserData.login || 'GH');
            };
            avatarImage.src = githubUserData.avatar_url || createFallbackAvatarDataUrl(githubUserData.login || 'GH');
            avatarImage.alt = githubUserData.login || 'GitHub avatar';
        }
    }

    // Update stats (accurate labels and values)
    document.getElementById('github-repos-count').textContent = githubUserData.public_repos || 0;
    document.getElementById('github-followers-count').textContent = githubUserData.followers || 0;
    document.getElementById('github-following-count').textContent = githubUserData.following || 0;
    document.getElementById('github-gists-count').textContent = githubUserData.public_gists || 0;
    updateGitHubSyncMeta();

    // Update details
    document.getElementById('github-email-display').textContent = githubUserData.email || 'Not public';
    document.getElementById('github-company-display').textContent = githubUserData.company || '-';
    document.getElementById('github-location-display').textContent = githubUserData.location || '-';
    document.getElementById('github-created-display').textContent = createdDisplay;
    setGitHubDetailLink('github-blog-display', githubUserData.blog, 'Not set');
    setGitHubDetailLink('github-profile-link-display', githubUserData.html_url, 'Not available');

    // Show bio if available
    const bioSection = document.getElementById('github-bio-section');
    if (githubUserData.bio) {
        document.getElementById('github-bio-text').textContent = githubUserData.bio;
        bioSection.style.display = 'block';
    } else {
        bioSection.style.display = 'none';
    }

    setGitHubDashboardStatus('');

    // Setup action handlers
    document.getElementById('view-profile-btn').onclick = async () => {
        if (!githubUserData?.html_url) {
            setGitHubDashboardStatus('No public profile URL is available for this account.', 'error');
            return;
        }

        const openResult = await ipcRenderer.invoke('open-external', githubUserData.html_url);
        if (!openResult?.success) {
            setGitHubDashboardStatus(openResult?.error || 'Failed to open profile link.', 'error');
            return;
        }

        setGitHubDashboardStatus('Opened GitHub profile in your browser.', 'success');
    };

    document.getElementById('sync-repos-btn').onclick = async () => {
        setGitHubDashboardBusy(true, 'sync-repos-btn', 'Syncing...');
        setGitHubDashboardStatus('Syncing GitHub account and repository state...', 'loading');

        try {
            const result = await ipcRenderer.invoke('github-get-user');
            if (!result.success || !result.user) {
                throw new Error(result.error || 'Failed to sync GitHub account');
            }

            githubUserData = result.user;
            githubLastSyncedAt = new Date();
            await updateGitHubStatus();
            await updateGitHubReposCount();

            if (currentProject?.path) {
                await refreshGitStatus();
            }

            showGitHubAccountInfo();
            setGitHubDashboardStatus(`Synced @${result.user.login} successfully.`, 'success');
            showNotification('GitHub account synchronized', 'success');
        } catch (error) {
            setGitHubDashboardStatus(error.message || 'Failed to sync GitHub data.', 'error');
            showNotification(error.message || 'Failed to sync GitHub data.', 'error');
        } finally {
            setGitHubDashboardBusy(false);
        }
    };

    document.getElementById('refresh-data-btn').onclick = async () => {
        setGitHubDashboardBusy(true, 'refresh-data-btn', 'Refreshing...');
        setGitHubDashboardStatus('Refreshing account data from GitHub...', 'loading');

        try {
            const result = await ipcRenderer.invoke('github-get-user');
            if (!result.success || !result.user) {
                throw new Error(result.error || 'Failed to refresh GitHub account data');
            }

            githubUserData = result.user;
            githubLastSyncedAt = new Date();
            await updateGitHubStatus();
            await updateGitHubReposCount();
            showGitHubAccountInfo();
            setGitHubDashboardStatus('Account data refreshed successfully.', 'success');
        } catch (error) {
            setGitHubDashboardStatus(error.message || 'Failed to refresh GitHub data.', 'error');
            showNotification(error.message || 'Failed to refresh GitHub data.', 'error');
        } finally {
            setGitHubDashboardBusy(false);
        }
    };

    document.getElementById('github-disconnect-btn').onclick = async () => {
        const confirmed = await requestGitHubDisconnectDecision();
        if (!confirmed) {
            return;
        }

        setGitHubDashboardBusy(true, 'github-disconnect-btn', 'Disconnecting...');
        setGitHubDashboardStatus('Disconnecting GitHub account...', 'loading');

        try {
            await disconnectGitHub();
            await updateGitHubStatus();
            hideModal('github-account-modal');
        } finally {
            setGitHubDashboardBusy(false);
        }
    };

    showModal('github-account-modal');
}

// Disconnect GitHub account
async function disconnectGitHub() {
    try {
        await ipcRenderer.invoke('github-disconnect');
    } catch (error) {
        console.error('Failed to disconnect GitHub account:', error);
    }
    githubUserData = null;
    githubLastSyncedAt = null;
    setStatusConnectionState(false);
    updateGitHubAvatar();
    updateGitHubLoginModalState();
    updateGitHubSyncMeta();

    // Reset GitHub repos count in hero section
    const heroGitRepos = document.getElementById('hero-git-repos');
    if (heroGitRepos) heroGitRepos.textContent = '0';

    showNotification('Disconnected from GitHub', 'info');
    logActivity('github', 'GitHub Disconnected', 'User disconnected GitHub account');
}

// =========================
// Premium Delete Dialog
// =========================

// Initialize premium delete dialog interactions
function initializePremiumDeleteDialog() {
    const deleteModal = document.getElementById('delete-project-modal');
    const deleteTypeRadios = document.querySelectorAll('input[name="delete-type"]');
    const confirmationSection = document.getElementById('delete-confirmation-section');
    const confirmInput = document.getElementById('delete-confirm-input');
    const confirmBtn = document.getElementById('confirm-delete-btn');
    const cancelBtn = deleteModal?.querySelector('.btn-delete-cancel');
    const closeBtn = deleteModal?.querySelector('.delete-close-btn');

    // Handle delete type radio changes
    deleteTypeRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            if (e.target.value === 'delete') {
                confirmationSection.style.display = 'block';
                confirmBtn.disabled = true;
                confirmInput.value = '';
            } else {
                confirmationSection.style.display = 'none';
                confirmBtn.disabled = false;
            }
        });
    });

    // Handle confirmation input
    confirmInput?.addEventListener('input', (e) => {
        const deleteType = document.querySelector('input[name="delete-type"]:checked')?.value;
        if (deleteType === 'delete' && projectToDelete) {
            confirmBtn.disabled = e.target.value.trim() !== projectToDelete.name;
        }
    });

    // Cancel button
    cancelBtn?.addEventListener('click', () => {
        hideModal('delete-project-modal');
        resetDeleteDialog();
    });

    // Close button
    closeBtn?.addEventListener('click', () => {
        hideModal('delete-project-modal');
        resetDeleteDialog();
    });

    // Confirm delete button
    confirmBtn?.addEventListener('click', async () => {
        if (!projectToDelete) return;

        const deleteType = document.querySelector('input[name="delete-type"]:checked')?.value;

        if (deleteType === 'remove') {
            // Just remove from app
            removeProjectFromApp(projectToDelete);
        } else if (deleteType === 'delete') {
            // Permanently delete
            const confirmation = confirmInput.value.trim();
            if (confirmation !== projectToDelete.name) {
                showNotification('Project name does not match', 'error');
                return;
            }
            await deleteProjectPermanently(projectToDelete);
        }

        hideModal('delete-project-modal');
        resetDeleteDialog();
    });
}

// Reset delete dialog to default state
function resetDeleteDialog() {
    const removeRadio = document.getElementById('delete-type-remove');
    const confirmationSection = document.getElementById('delete-confirmation-section');
    const confirmInput = document.getElementById('delete-confirm-input');
    const confirmBtn = document.getElementById('confirm-delete-btn');

    if (removeRadio) removeRadio.checked = true;
    if (confirmationSection) confirmationSection.style.display = 'none';
    if (confirmInput) confirmInput.value = '';
    if (confirmBtn) confirmBtn.disabled = false;

    projectToDelete = null;
}

// Git staging and file operations
async function stageFile(filename) {
    if (!currentProject) return;

    try {
        const result = await ipcRenderer.invoke('run-command', `git add "${filename}"`, currentProject.path);
        if (result.success) {
            showNotification(`Staged ${filename}`, 'success');
            await refreshGitStatus();
        } else {
            showNotification(`Failed to stage file: ${result.error}`, 'error');
        }
    } catch (error) {
        showNotification(`Error staging file: ${error.message}`, 'error');
    }
}

async function unstageFile(filename) {
    if (!currentProject) return;

    try {
        const result = await ipcRenderer.invoke('run-command', `git reset HEAD "${filename}"`, currentProject.path);
        if (result.success) {
            showNotification(`Unstaged ${filename}`, 'success');
            await refreshGitStatus();
        } else {
            showNotification(`Failed to unstage file: ${result.error}`, 'error');
        }
    } catch (error) {
        showNotification(`Error unstaging file: ${error.message}`, 'error');
    }
}

async function discardFile(filename) {
    if (!currentProject) return;

    const confirmed = confirm(`Are you sure you want to discard changes to ${filename}? This cannot be undone.`);
    if (!confirmed) return;

    try {
        const result = await ipcRenderer.invoke('run-command', `git checkout -- "${filename}"`, currentProject.path);
        if (result.success) {
            showNotification(`Discarded changes to ${filename}`, 'success');
            await refreshGitStatus();
        } else {
            showNotification(`Failed to discard changes: ${result.error}`, 'error');
        }
    } catch (error) {
        showNotification(`Error discarding changes: ${error.message}`, 'error');
    }
}

async function stageAll() {
    if (!currentProject) return;

    try {
        const result = await ipcRenderer.invoke('run-command', 'git add .', currentProject.path);
        if (result.success) {
            showNotification('Staged all changes', 'success');
            await refreshGitStatus();
        } else {
            showNotification(`Failed to stage all: ${result.error}`, 'error');
        }
    } catch (error) {
        showNotification(`Error staging all: ${error.message}`, 'error');
    }
}

async function unstageAll() {
    if (!currentProject) return;

    try {
        const result = await ipcRenderer.invoke('run-command', 'git reset HEAD', currentProject.path);
        if (result.success) {
            showNotification('Unstaged all changes', 'success');
            await refreshGitStatus();
        } else {
            showNotification(`Failed to unstage all: ${result.error}`, 'error');
        }
    } catch (error) {
        showNotification(`Error unstaging all: ${error.message}`, 'error');
    }
}

async function discardAll() {
    if (!currentProject) return;

    try {
        const result = await ipcRenderer.invoke('run-command', 'git checkout -- .', currentProject.path);
        if (result.success) {
            showNotification('Discarded all changes', 'success');
            await refreshGitStatus();
        } else {
            showNotification(`Failed to discard all: ${result.error}`, 'error');
        }
    } catch (error) {
        showNotification(`Error discarding all: ${error.message}`, 'error');
    }
}

// Folder toggle function
function toggleFolder(folderId) {
    const folderContent = document.getElementById(folderId);
    const folderIcon = document.getElementById(`${folderId}-icon`);

    if (folderContent && folderIcon) {
        // Find the folder icon (not the chevron)
        const folderIconElement = folderIcon.parentElement.querySelector('.fa-folder, .fa-folder-open');

        // Check if currently visible (check both inline style and computed style)
        const computedDisplay = window.getComputedStyle(folderContent).display;
        const isVisible = computedDisplay !== 'none';

        if (isVisible) {
            // Collapse the folder
            folderContent.style.display = 'none';
            folderIcon.className = 'fas fa-chevron-right git-folder-icon';
            if (folderIconElement) {
                folderIconElement.className = 'fas fa-folder';
                folderIconElement.style.color = '#dcb67a';
            }
        } else {
            // Expand the folder
            folderContent.style.display = 'block';
            folderIcon.className = 'fas fa-chevron-down git-folder-icon';
            if (folderIconElement) {
                folderIconElement.className = 'fas fa-folder-open';
                folderIconElement.style.color = '#dcb67a';
            }
        }
    }
}

// Selection management functions
function toggleSelectAllStaged(checkbox) {
    const checkboxes = document.querySelectorAll('.staged-checkbox');
    checkboxes.forEach(cb => {
        cb.checked = checkbox.checked;
    });
    updateStagedSelectionState();
}

function toggleSelectAllUnstaged(checkbox) {
    const checkboxes = document.querySelectorAll('.unstaged-checkbox');
    checkboxes.forEach(cb => {
        cb.checked = checkbox.checked;
    });
    updateUnstagedSelectionState();
}

function toggleFolderSelection(folderId, type, checked) {
    // Get all checkboxes within this folder
    const folderElement = document.getElementById(folderId);
    if (!folderElement) return;

    const checkboxClass = type === 'staged' ? 'staged-checkbox' : 'unstaged-checkbox';
    const checkboxes = folderElement.querySelectorAll(`.${checkboxClass}`);

    checkboxes.forEach(cb => {
        cb.checked = checked;
    });

    // Update the overall selection state
    if (type === 'staged') {
        updateStagedSelectionState();
    } else {
        updateUnstagedSelectionState();
    }
}

function updateStagedSelectionState() {
    const checkboxes = document.querySelectorAll('.staged-checkbox');
    const selectAllCheckbox = document.querySelector('.git-changes-group:nth-child(1) .git-select-all');

    if (selectAllCheckbox) {
        const allChecked = Array.from(checkboxes).every(cb => cb.checked);
        const anyChecked = Array.from(checkboxes).some(cb => cb.checked);

        selectAllCheckbox.checked = allChecked;
        selectAllCheckbox.indeterminate = anyChecked && !allChecked;
    }
}

function updateUnstagedSelectionState() {
    const checkboxes = document.querySelectorAll('.unstaged-checkbox');
    const selectAllCheckbox = document.querySelector('.git-changes-group:nth-child(2) .git-select-all');

    if (selectAllCheckbox) {
        const allChecked = Array.from(checkboxes).every(cb => cb.checked);
        const anyChecked = Array.from(checkboxes).some(cb => cb.checked);

        selectAllCheckbox.checked = allChecked;
        selectAllCheckbox.indeterminate = anyChecked && !allChecked;
    }
}

function getSelectedFiles(checkboxClass) {
    const selectedFiles = [];
    const checkboxes = document.querySelectorAll(`.${checkboxClass}:checked`);

    checkboxes.forEach(checkbox => {
        const fileItem = checkbox.closest('.git-file-item');
        if (fileItem) {
            const filename = fileItem.getAttribute('data-filename');
            if (filename) {
                selectedFiles.push(filename);
            }
        }
    });

    return selectedFiles;
}

async function stageSelected() {
    const selectedFiles = getSelectedFiles('unstaged-checkbox');

    if (selectedFiles.length === 0) {
        showNotification('No files selected', 'warning');
        return;
    }

    if (!currentProject) return;

    try {
        let successCount = 0;
        let errorCount = 0;

        for (const filename of selectedFiles) {
            const result = await ipcRenderer.invoke('run-command', `git add "${filename}"`, currentProject.path);
            if (result.success) {
                successCount++;
            } else {
                errorCount++;
            }
        }

        if (successCount > 0) {
            showNotification(`Staged ${successCount} file(s)`, 'success');
        }
        if (errorCount > 0) {
            showNotification(`Failed to stage ${errorCount} file(s)`, 'error');
        }

        await refreshGitStatus();
    } catch (error) {
        showNotification(`Error staging files: ${error.message}`, 'error');
    }
}

async function unstageSelected() {
    const selectedFiles = getSelectedFiles('staged-checkbox');

    if (selectedFiles.length === 0) {
        showNotification('No files selected', 'warning');
        return;
    }

    if (!currentProject) return;

    try {
        let successCount = 0;
        let errorCount = 0;

        for (const filename of selectedFiles) {
            const result = await ipcRenderer.invoke('run-command', `git reset HEAD "${filename}"`, currentProject.path);
            if (result.success) {
                successCount++;
            } else {
                errorCount++;
            }
        }

        if (successCount > 0) {
            showNotification(`Unstaged ${successCount} file(s)`, 'success');
        }
        if (errorCount > 0) {
            showNotification(`Failed to unstage ${errorCount} file(s)`, 'error');
        }

        await refreshGitStatus();
    } catch (error) {
        showNotification(`Error unstaging files: ${error.message}`, 'error');
    }
}

async function viewFileDiff(filename) {
    if (!currentProject) {
        showNotification('No project selected', 'error');
        return;
    }

    try {
        const result = await ipcRenderer.invoke('git-diff', currentProject.path, filename);
        if (result.success) {
            showDiffModal(filename, result.output);
        } else {
            showNotification(`Failed to get diff: ${result.error}`, 'error');
        }
    } catch (error) {
        showNotification(`Diff error: ${error.message}`, 'error');
    }
}

// Show diff in a modal
function showDiffModal(filename, diffOutput) {
    const modal = document.getElementById('git-diff-modal');
    if (!modal) {
        createDiffModal();
        showDiffModal(filename, diffOutput);
        return;
    }

    document.getElementById('diff-filename').textContent = filename;
    const diffContent = document.getElementById('diff-content');

    // Parse and format diff output
    if (!diffOutput || diffOutput.trim() === '') {
        diffContent.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-secondary);">No changes to display</div>';
    } else {
        const lines = diffOutput.split('\n');
        let html = '<pre class="diff-pre">';
        lines.forEach(line => {
            let className = '';
            if (line.startsWith('+') && !line.startsWith('+++')) {
                className = 'diff-added';
            } else if (line.startsWith('-') && !line.startsWith('---')) {
                className = 'diff-removed';
            } else if (line.startsWith('@@')) {
                className = 'diff-info';
            }
            html += `<div class="${className}">${escapeHtml(line)}</div>`;
        });
        html += '</pre>';
        diffContent.innerHTML = html;
    }

    showModal('git-diff-modal');
}

// Create diff modal dynamically if it doesn't exist
function createDiffModal() {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'git-diff-modal';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 900px;">
            <div class="modal-header">
                <h2><i class="fas fa-code-branch"></i> File Diff: <span id="diff-filename"></span></h2>
                <button class="modal-close-btn" onclick="hideModal('git-diff-modal')">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="modal-body">
                <div id="diff-content" style="max-height: 600px; overflow-y: auto; background: var(--bg-tertiary); border-radius: 4px;"></div>
            </div>
            <div class="modal-footer">
                <button class="btn-secondary modal-close">Close</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

function createHunkModal() {
    if (document.getElementById('git-hunk-modal')) {
        return;
    }

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'git-hunk-modal';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 900px;">
            <div class="modal-header">
                <h2><i class="fas fa-grip-lines"></i> Partial Staging</h2>
                <button class="modal-close-btn" onclick="hideModal('git-hunk-modal')">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="modal-body">
                <p id="hunk-modal-subtitle" class="setting-description"></p>
                <div id="hunk-list" class="operation-queue-list"></div>
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" onclick="hideModal('git-hunk-modal')">Cancel</button>
                <button class="btn-primary" id="apply-hunks-btn" type="button">Apply Selected Hunks</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (event) => {
        if (event.target === modal) {
            hideModal('git-hunk-modal');
        }
    });
}

async function openHunkStageModal(filename, mode = 'unstaged') {
    if (!currentProject) {
        showNotification('Please select a project first', 'error');
        return;
    }

    createHunkModal();
    const normalizedMode = mode === 'staged' ? 'staged' : 'unstaged';
    const subtitle = document.getElementById('hunk-modal-subtitle');
    const hunkList = document.getElementById('hunk-list');
    const applyBtn = document.getElementById('apply-hunks-btn');
    if (!subtitle || !hunkList || !applyBtn) {
        return;
    }

    const verb = normalizedMode === 'staged' ? 'unstage' : 'stage';
    subtitle.textContent = `${verb.toUpperCase()} hunks for ${filename}`;
    hunkList.innerHTML = '<div class="settings-ext-empty"><p>Loading hunks...</p></div>';
    showModal('git-hunk-modal');

    const result = await ipcRenderer.invoke('git-diff-hunks', currentProject.path, filename, normalizedMode);
    if (!result?.success) {
        hunkList.innerHTML = '<div class="settings-ext-empty"><p>No hunks available for this file.</p></div>';
        showNotification(result?.error || 'Unable to load hunks', 'error');
        return;
    }

    const hunks = Array.isArray(result.hunks) ? result.hunks : [];
    if (hunks.length === 0) {
        hunkList.innerHTML = '<div class="settings-ext-empty"><p>No hunks available for this file.</p></div>';
        return;
    }

    hunkList.innerHTML = '';
    const fragment = document.createDocumentFragment();
    hunks.forEach((hunk) => {
        const row = document.createElement('div');
        row.className = 'queue-job-item';

        const main = document.createElement('div');
        main.className = 'queue-job-main';

        const title = document.createElement('label');
        title.className = 'queue-job-title';
        title.style.display = 'flex';
        title.style.alignItems = 'center';
        title.style.gap = '8px';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = true;
        checkbox.className = 'hunk-checkbox';
        checkbox.value = String(hunk.id);
        const titleText = document.createElement('span');
        titleText.textContent = hunk.header || `Hunk ${hunk.id}`;
        title.appendChild(checkbox);
        title.appendChild(titleText);

        const preview = document.createElement('pre');
        preview.className = 'diff-pre';
        preview.style.margin = '8px 0 0 0';
        preview.style.maxHeight = '160px';
        preview.style.overflow = 'auto';
        preview.textContent = Array.isArray(hunk.preview) && hunk.preview.length > 0
            ? hunk.preview.join('\n')
            : '(No preview lines)';

        main.appendChild(title);
        main.appendChild(preview);
        row.appendChild(main);
        fragment.appendChild(row);
    });
    hunkList.appendChild(fragment);

    applyBtn.textContent = normalizedMode === 'staged' ? 'Unstage Selected Hunks' : 'Stage Selected Hunks';
    applyBtn.onclick = async () => {
        const selectedIds = Array.from(hunkList.querySelectorAll('.hunk-checkbox:checked'))
            .map((input) => Number.parseInt(input.value, 10))
            .filter((id) => Number.isInteger(id) && id > 0);

        if (selectedIds.length === 0) {
            showNotification('Select at least one hunk', 'warning');
            return;
        }

        const applyResult = await ipcRenderer.invoke('git-apply-hunks', currentProject.path, filename, normalizedMode, selectedIds);
        if (!applyResult?.success) {
            showNotification(applyResult?.error || 'Failed to apply selected hunks', 'error');
            return;
        }

        const actionVerb = normalizedMode === 'staged' ? 'Unstaged' : 'Staged';
        showNotification(`${actionVerb} ${applyResult.appliedCount || selectedIds.length} hunk(s)`, 'success');
        hideModal('git-hunk-modal');
        await refreshGitStatus();
    };
}

function createConflictAssistantModal() {
    if (document.getElementById('git-conflict-modal')) {
        return;
    }

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'git-conflict-modal';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 980px;">
            <div class="modal-header">
                <h2><i class="fas fa-exclamation-triangle"></i> Merge Conflict Assistant</h2>
                <button class="modal-close-btn" onclick="hideModal('git-conflict-modal')">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="modal-body">
                <p id="git-conflict-summary" class="setting-description">Loading conflicts...</p>
                <div id="git-conflict-list" class="operation-queue-list"></div>
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" id="git-conflict-refresh-btn" type="button">Refresh</button>
                <button class="btn-secondary" id="git-conflict-abort-btn" type="button">Abort Merge</button>
                <button class="btn-primary" id="git-conflict-continue-btn" type="button">Continue Merge</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (event) => {
        if (event.target === modal) {
            hideModal('git-conflict-modal');
        }
    });

    document.getElementById('git-conflict-refresh-btn')?.addEventListener('click', () => {
        void renderConflictAssistantList();
    });
    document.getElementById('git-conflict-abort-btn')?.addEventListener('click', async () => {
        if (!currentProject) {
            return;
        }
        const result = await ipcRenderer.invoke('git-abort-merge', currentProject.path);
        if (!result?.success) {
            showNotification(result?.error || 'Failed to abort merge', 'error');
            return;
        }
        showNotification('Merge aborted', 'success');
        hideModal('git-conflict-modal');
        await refreshGitStatus();
    });
    document.getElementById('git-conflict-continue-btn')?.addEventListener('click', async () => {
        if (!currentProject) {
            return;
        }
        const result = await ipcRenderer.invoke('git-continue-merge', currentProject.path);
        if (!result?.success) {
            showNotification(result?.error || 'Cannot continue merge yet', 'error');
            return;
        }
        showNotification('Merge continued', 'success');
        hideModal('git-conflict-modal');
        await refreshGitStatus();
    });
}

async function resolveConflictEntry(filePath, strategy) {
    if (!currentProject) {
        return;
    }

    const result = await ipcRenderer.invoke('git-resolve-conflict', currentProject.path, filePath, strategy);
    if (!result?.success) {
        showNotification(result?.error || 'Failed to resolve conflict', 'error');
        return;
    }

    const strategyLabel = strategy === 'mark-resolved' ? 'Marked resolved' : `Applied ${strategy}`;
    showNotification(`${strategyLabel}: ${filePath}`, 'success');
    await refreshGitStatus();
    await renderConflictAssistantList();
}

async function renderConflictAssistantList() {
    const list = document.getElementById('git-conflict-list');
    const summary = document.getElementById('git-conflict-summary');
    if (!list || !summary || !currentProject) {
        return;
    }

    list.innerHTML = '<div class="settings-ext-empty"><p>Loading conflicts...</p></div>';
    const result = await ipcRenderer.invoke('git-list-conflicts', currentProject.path);
    if (!result?.success) {
        summary.textContent = result?.error || 'Failed to load conflicts';
        list.innerHTML = '<div class="settings-ext-empty"><p>Unable to read conflicts.</p></div>';
        return;
    }

    const conflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
    if (conflicts.length === 0) {
        summary.textContent = 'No merge conflicts detected.';
        list.innerHTML = '<div class="settings-ext-empty"><p>All conflicts are resolved. Continue or finish your merge.</p></div>';
        return;
    }

    summary.textContent = `${conflicts.length} conflicting file(s) detected. Resolve each file with a strategy.`;
    list.innerHTML = '';
    const fragment = document.createDocumentFragment();
    conflicts.forEach((conflict) => {
        const row = document.createElement('div');
        row.className = 'queue-job-item';

        const main = document.createElement('div');
        main.className = 'queue-job-main';
        const title = document.createElement('div');
        title.className = 'queue-job-title';
        title.textContent = conflict.file;
        const meta = document.createElement('div');
        meta.className = 'queue-job-meta';
        meta.textContent = `Conflict code: ${conflict.code}`;
        main.appendChild(title);
        main.appendChild(meta);

        const actions = document.createElement('div');
        actions.className = 'queue-job-actions';
        const strategies = [
            { label: 'Use Ours', value: 'ours' },
            { label: 'Use Theirs', value: 'theirs' },
            { label: 'Mark Resolved', value: 'mark-resolved' },
            { label: 'View Diff', value: 'view-diff' }
        ];

        strategies.forEach((strategy) => {
            const btn = document.createElement('button');
            btn.className = 'btn-secondary';
            btn.textContent = strategy.label;
            btn.addEventListener('click', () => {
                if (strategy.value === 'view-diff') {
                    void viewFileDiff(conflict.file);
                    return;
                }
                void resolveConflictEntry(conflict.file, strategy.value);
            });
            actions.appendChild(btn);
        });

        row.appendChild(main);
        row.appendChild(actions);
        fragment.appendChild(row);
    });
    list.appendChild(fragment);
}

async function openConflictAssistant() {
    if (!currentProject) {
        showNotification('Please select a project first', 'error');
        return false;
    }
    createConflictAssistantModal();
    showModal('git-conflict-modal');
    await renderConflictAssistantList();
    return true;
}

async function checkForMergeConflictsAndPrompt(contextLabel = 'operation') {
    if (!currentProject) {
        return false;
    }

    const result = await ipcRenderer.invoke('git-list-conflicts', currentProject.path);
    if (!result?.success) {
        return false;
    }

    const conflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
    if (conflicts.length === 0) {
        return false;
    }

    showNotification(`${conflicts.length} merge conflict(s) detected after ${contextLabel}`, 'warning');
    await openConflictAssistant();
    return true;
}

// Load branches for display
async function loadBranches() {
    if (!currentProject) {
        setStatusGitBranch('--');
        return;
    }

    const hasGitRepository = currentProject.hasGit === true || isGitRepositoryPath(currentProject.path);
    currentProject.hasGit = hasGitRepository;
    if (!hasGitRepository) {
        setStatusGitBranch('--');
        const branchList = document.getElementById('git-branch-list');
        if (branchList) {
            branchList.innerHTML = `
                <div class="git-changes-empty">
                    <i class="fab fa-git-alt"></i>
                    <p>Initialize Git to view branches</p>
                </div>
            `;
        }
        return;
    }

    let result;
    try {
        result = await ipcRenderer.invoke('git-branches', currentProject.path);
    } catch (error) {
        console.error('[GIT] Failed to load branches:', error);
        setStatusGitBranch('--');
        return;
    }
    if (!result.success) {
        setStatusGitBranch('--');
        return;
    }

    const branches = result.output.split('\n').filter(b => b.trim());
    const activeBranchLine = branches.find(branch => branch.trim().startsWith('*'));
    const activeBranchName = activeBranchLine ? activeBranchLine.replace('*', '').trim() : 'main';
    setStatusGitBranch(activeBranchName);
    const branchList = document.getElementById('git-branch-list');

    if (!branchList) return;

    let html = `
        <div class="git-card-header">
            <h3><i class="fas fa-code-branch"></i> Branches</h3>
            <button class="btn-icon" onclick="showCreateBranchModal()" title="New Branch">
                <i class="fas fa-plus"></i>
            </button>
        </div>
        <div class="git-card-body">
    `;

    branches.forEach(branch => {
        const isActive = branch.trim().startsWith('*');
        const branchName = branch.replace('*', '').trim().replace(/^remotes\//, '');
        const isRemote = branch.includes('remotes/');
        const encodedBranchName = encodeURIComponent(branchName);
        const safeBranchName = escapeHtml(branchName);

        html += `
            <div class="git-branch-item ${isActive ? 'active' : ''}" onclick="${!isActive && !isRemote ? `switchBranch(decodeURIComponent('${encodedBranchName}'))` : ''}">
                <i class="fas fa-code-branch" style="color: ${isActive ? 'var(--accent-primary)' : 'var(--text-secondary)'}"></i>
                <span style="flex: 1;">${safeBranchName}</span>
                ${isActive ? '<i class="fas fa-check" style="color: var(--success);"></i>' : ''}
                ${!isActive && !isRemote ? `<button class="btn-icon-small" onclick="event.stopPropagation(); deleteBranch(decodeURIComponent('${encodedBranchName}'))" title="Delete Branch"><i class="fas fa-trash"></i></button>` : ''}
            </div>
        `;
    });

    html += '</div>';
    branchList.innerHTML = html;
}

// Switch to a different branch
async function switchBranch(branchName) {
    if (!currentProject) {
        showNotification('No project selected', 'error');
        return;
    }

    await withGitLock(async () => {
        try {
            showNotification(`Switching to branch ${branchName}...`, 'info');
            const result = await ipcRenderer.invoke('git-checkout', currentProject.path, branchName);
            if (result.success) {
                showNotification(`Switched to branch ${branchName}`, 'success');
                await refreshGitStatus();
                await loadBranches();
            } else {
                showNotification(`Failed to switch branch: ${result.error}`, 'error');
            }
        } catch (error) {
            showNotification(`Switch branch error: ${error.message}`, 'error');
        }
    });
}

// Delete a branch
async function deleteBranch(branchName) {
    if (!currentProject) {
        showNotification('No project selected', 'error');
        return;
    }
    if (!confirm(`Are you sure you want to delete branch "${branchName}"?`)) {
        return;
    }

    try {
        const result = await ipcRenderer.invoke('git-delete-branch', currentProject.path, branchName);
        if (result.success) {
            showNotification(`Branch ${branchName} deleted`, 'success');
            await loadBranches();
        } else {
            showNotification(`Failed to delete branch: ${result.error}`, 'error');
        }
    } catch (error) {
        showNotification(`Delete branch error: ${error.message}`, 'error');
    }
}

// Show create branch modal
function showCreateBranchModal() {
    const branchName = prompt('Enter new branch name:');
    if (!branchName || !branchName.trim()) {
        return;
    }

    createBranch(branchName.trim());
}

// Create a new branch
async function createBranch(branchName) {
    if (!currentProject) {
        showNotification('No project selected', 'error');
        return;
    }

    await withGitLock(async () => {
        try {
            showNotification(`Creating branch ${branchName}...`, 'info');
            const result = await ipcRenderer.invoke('git-create-branch', currentProject.path, branchName);
            if (result.success) {
                showNotification(`Branch ${branchName} created and checked out`, 'success');
                await refreshGitStatus();
                await loadBranches();
            } else {
                showNotification(`Failed to create branch: ${result.error}`, 'error');
            }
        } catch (error) {
            showNotification(`Create branch error: ${error.message}`, 'error');
        }
    });
}

// Load branches for merge modal
async function loadBranchesForMerge() {
    if (!currentProject) return;

    const result = await ipcRenderer.invoke('git-branches', currentProject.path);
    if (!result.success) return;

    const branches = result.output.split('\n')
        .filter(b => b.trim() && !b.trim().startsWith('*'))
        .map(b => b.replace('*', '').trim().replace(/^remotes\//, ''));

    const select = document.getElementById('merge-branch-select');
    if (!select) return;

    select.innerHTML = branches.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
}

// Perform merge
async function performMerge() {
    const branchName = document.getElementById('merge-branch-select')?.value;
    if (!branchName) {
        showNotification('Please select a branch to merge', 'error');
        return;
    }

    if (!currentProject) {
        showNotification('No project selected', 'error');
        return;
    }

    showNotification(`Merging ${branchName}...`, 'info');
    const result = await ipcRenderer.invoke('git-merge', currentProject.path, branchName);

    if (result.success) {
        showNotification(`Successfully merged ${branchName}`, 'success');
        hideModal('git-merge-modal');
        await refreshGitStatus();
        await checkForMergeConflictsAndPrompt('merge');
    } else {
        showNotification(`Merge failed: ${result.error}`, 'error');
        await checkForMergeConflictsAndPrompt('merge');
    }
}

// Load commit history
async function loadCommitHistory() {
    if (!ensureProAccess('History')) {
        return;
    }

    if (!currentProject) {
        showNotification('Please select a project first', 'error');
        return;
    }

    try {
        const result = await ipcRenderer.invoke('git-log', currentProject.path, 50);
        if (!result.success) {
            showNotification('Failed to load commit history', 'error');
            return;
        }
        showCommitHistoryModal(result.output);
    } catch (error) {
        showNotification(`History error: ${error.message}`, 'error');
    }
}

// Show commit history in modal
function showCommitHistoryModal(logOutput) {
    const modal = document.getElementById('git-history-modal');
    if (!modal) {
        createHistoryModal();
        showCommitHistoryModal(logOutput);
        return;
    }

    const historyList = document.getElementById('commit-history-list');
    const commits = logOutput.split('\n').filter(line => line.trim());

    let html = '';
    commits.forEach(commit => {
        const [hash, author, email, date, ...messageParts] = commit.split('|');
        const message = messageParts.join('|');
        const shortHash = hash.substring(0, 7);
        const safeShortHash = escapeHtml(shortHash);
        const safeAuthor = escapeHtml(author || 'Unknown');
        const safeDate = escapeHtml(new Date(date).toLocaleDateString());

        html += `
            <div class="commit-item">
                <div class="commit-header">
                    <code class="commit-hash">${safeShortHash}</code>
                    <span class="commit-author">${safeAuthor}</span>
                    <span class="commit-date">${safeDate}</span>
                </div>
                <div class="commit-message">${escapeHtml(message)}</div>
            </div>
        `;
    });

    historyList.innerHTML = html;
    showModal('git-history-modal');
}

// Create history modal
function createHistoryModal() {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'git-history-modal';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 800px;">
            <div class="modal-header">
                <h2><i class="fas fa-history"></i> Commit History</h2>
                <button class="modal-close-btn" onclick="hideModal('git-history-modal')">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="modal-body">
                <div id="commit-history-list" style="max-height: 600px; overflow-y: auto;"></div>
            </div>
            <div class="modal-footer">
                <button class="btn-secondary modal-close">Close</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

// Create merge modal
function createMergeModal() {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'git-merge-modal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h2><i class="fas fa-code-merge"></i> Merge Branch</h2>
                <button class="modal-close-btn" onclick="hideModal('git-merge-modal')">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="modal-body">
                <div class="form-group">
                    <label for="merge-branch-select">Select branch to merge into current branch:</label>
                    <select id="merge-branch-select" class="input">
                        <option value="">-- Select a branch --</option>
                    </select>
                </div>
                <div class="git-info-box">
                    <i class="fas fa-info-circle"></i>
                    <span>This will merge the selected branch into your current branch</span>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn-secondary modal-close">Cancel</button>
                <button class="btn-primary" onclick="performMerge()">Merge</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

// Remote repository management
async function showRemotesModal() {
    if (!currentProject) {
        showNotification('No project selected', 'error');
        return;
    }

    const modal = document.getElementById('git-remotes-modal');
    if (!modal) {
        createRemotesModal();
        await showRemotesModal();
        return;
    }

    await loadRemotes();
    showModal('git-remotes-modal');
}

// Load and display remotes
async function loadRemotes() {
    if (!currentProject) return;

    const result = await ipcRenderer.invoke('git-remote-list', currentProject.path);
    const remotesList = document.getElementById('remotes-list');

    if (!result.success || !result.output.trim()) {
        remotesList.innerHTML = `
            <div class="git-changes-empty">
                <p>No remotes configured</p>
                <p style="font-size: 12px; margin-top: 8px;">Add a remote to push/pull from repositories</p>
            </div>
        `;
        return;
    }

    const remotes = result.output.split('\n').filter(line => line.trim());
    const remoteMap = {};

    // Parse remotes (format: name url (fetch/push))
    remotes.forEach(line => {
        const match = line.match(/^(\S+)\s+(\S+)\s+\((\w+)\)$/);
        if (match) {
            const [, name, url, type] = match;
            if (!remoteMap[name]) {
                remoteMap[name] = { name, url, fetch: '', push: '' };
            }
            if (type === 'fetch') {
                remoteMap[name].fetch = url;
            } else if (type === 'push') {
                remoteMap[name].push = url;
            }
        }
    });

    let html = '';
    Object.values(remoteMap).forEach(remote => {
        const encodedRemoteName = encodeURIComponent(remote.name);
        const safeRemoteName = escapeHtml(remote.name);
        const safeRemoteUrl = escapeHtml(remote.url);

        html += `
            <div class="remote-item">
                <div class="remote-header">
                    <i class="fas fa-globe"></i>
                    <span class="remote-name">${safeRemoteName}</span>
                    <button class="btn-icon-small" onclick="deleteRemote(decodeURIComponent('${encodedRemoteName}'))" title="Remove Remote">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
                <div class="remote-url">${safeRemoteUrl}</div>
            </div>
        `;
    });

    remotesList.innerHTML = html;
}

// Delete a remote
async function deleteRemote(remoteName) {
    if (!currentProject) {
        showNotification('No project selected', 'error');
        return;
    }
    if (!confirm(`Are you sure you want to remove remote "${remoteName}"?`)) {
        return;
    }

    try {
        const result = await ipcRenderer.invoke('git-remove-remote', currentProject.path, remoteName);
        if (result.success) {
            showNotification(`Remote ${remoteName} removed`, 'success');
            await loadRemotes();
        } else {
            showNotification(`Failed to remove remote: ${result.error}`, 'error');
        }
    } catch (error) {
        showNotification(`Remove remote error: ${error.message}`, 'error');
    }
}

// Add a new remote
async function addRemote() {
    const name = document.getElementById('remote-name-input')?.value?.trim();
    const url = document.getElementById('remote-url-input')?.value?.trim();

    if (!name || !url) {
        showNotification('Please enter both name and URL', 'error');
        return;
    }

    const result = await ipcRenderer.invoke('git-add-remote', currentProject.path, name, url);
    if (result.success) {
        showNotification(`Remote ${name} added successfully`, 'success');
        document.getElementById('remote-name-input').value = '';
        document.getElementById('remote-url-input').value = '';
        await loadRemotes();
    } else {
        showNotification(`Failed to add remote: ${result.error}`, 'error');
    }
}

// Create remotes modal
function createRemotesModal() {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'git-remotes-modal';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 700px;">
            <div class="modal-header">
                <h2><i class="fas fa-globe"></i> Manage Remotes</h2>
                <button class="modal-close-btn" onclick="hideModal('git-remotes-modal')">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="modal-body">
                <div class="form-group">
                    <label>Configured Remotes</label>
                    <div id="remotes-list" style="max-height: 300px; overflow-y: auto; margin-bottom: 20px;">
                        <!-- Remotes will be listed here -->
                    </div>
                </div>

                <div class="git-info-box">
                    <i class="fas fa-info-circle"></i>
                    <span>Add a new remote repository</span>
                </div>

                <div class="form-group">
                    <label for="remote-name-input">Remote Name</label>
                    <input type="text" id="remote-name-input" class="input" placeholder="origin" />
                </div>

                <div class="form-group">
                    <label for="remote-url-input">Remote URL</label>
                    <input type="text" id="remote-url-input" class="input"
                        placeholder="https://github.com/user/repo.git" />
                </div>

                <button class="btn-primary" onclick="addRemote()" style="width: 100%;">
                    <i class="fas fa-plus"></i> Add Remote
                </button>
            </div>
            <div class="modal-footer">
                <button class="btn-secondary modal-close">Close</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

// Helper function to escape HTML
function escapeHtml(text) {
    if (text === null || text === undefined) {
        return '';
    }

    const normalizedText = String(text);
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return normalizedText.replace(/[&<>"']/g, m => map[m]);
}

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        switchView,
        showNotification,
        formatProjectType,
        logActivity,
        validateProjectName,
        stageFile,
        unstageFile,
        discardFile,
        stageAll,
        unstageAll
    };
}

// ==========================================
// Tips & Resources Auto-Rotation
// ==========================================

const tipsDatabase = [
    {
        icon: 'fas fa-keyboard',
        title: 'Keyboard Shortcuts',
        description: 'Use Ctrl+N to create a new project quickly, or Ctrl+O to open an existing one'
    },
    {
        icon: 'fas fa-code-branch',
        title: 'Git Integration',
        description: 'Seamlessly manage your repositories with built-in Git support and visualization'
    },
    {
        icon: 'fab fa-github',
        title: 'GitHub Sync',
        description: 'Connect your GitHub account to create repositories and push changes directly from the app'
    },
    {
        icon: 'fas fa-history',
        title: 'Commit History',
        description: 'Track all your changes with detailed commit history and visual branch diagrams'
    },
    {
        icon: 'fas fa-folder-tree',
        title: 'Project Organization',
        description: 'Keep your projects organized with folders, tags, and custom metadata'
    },
    {
        icon: 'fas fa-file-code',
        title: 'File Changes',
        description: 'Review file changes with inline diffs and stage only the changes you need'
    },
    {
        icon: 'fas fa-save',
        title: 'Auto-Save',
        description: 'Your work is automatically saved - never lose your project configuration again'
    },
    {
        icon: 'fas fa-search',
        title: 'Quick Search',
        description: 'Use the search feature to quickly find projects, files, or commits across all repositories'
    },
    {
        icon: 'fas fa-palette',
        title: 'Customization',
        description: 'Personalize your workspace with themes and custom settings in the Settings view'
    },
    {
        icon: 'fas fa-cloud-upload-alt',
        title: 'Push & Pull',
        description: 'Keep your remote repositories in sync with one-click push and pull operations'
    },
    {
        icon: 'fas fa-undo',
        title: 'Undo Operations',
        description: 'Made a mistake? Use the Undo button in Git view to revert your last operation'
    },
    {
        icon: 'fas fa-layer-group',
        title: 'Batch Operations',
        description: 'Stage or unstage multiple files at once with the Select All feature'
    }
];

let tipsRotationInterval = null;
let currentTipsPage = 0;
let tipsPages = [];

// Create tip pages (groups of 3 tips)
function createTipsPages() {
    tipsPages = [];
    const tipsCopy = [...tipsDatabase];

    // Shuffle tips
    for (let i = tipsCopy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [tipsCopy[i], tipsCopy[j]] = [tipsCopy[j], tipsCopy[i]];
    }

    // Group into pages of 3
    for (let i = 0; i < tipsCopy.length; i += 3) {
        tipsPages.push(tipsCopy.slice(i, i + 3));
    }
}

function renderNavigationDots() {
    const navContainer = document.getElementById('tips-navigation');
    if (!navContainer || tipsPages.length === 0) return;

    // Check if dots already exist
    const existingDots = navContainer.querySelectorAll('.tip-dot');

    if (existingDots.length === 0) {
        // Initial render
        navContainer.innerHTML = tipsPages.map((_, index) => `
            <button class="tip-dot ${index === currentTipsPage ? 'active' : ''}"
                    data-page="${index}"
                    aria-label="View tips page ${index + 1}"></button>
        `).join('');

        // Add click handlers
        navContainer.querySelectorAll('.tip-dot').forEach(dot => {
            dot.addEventListener('click', () => {
                const page = parseInt(dot.getAttribute('data-page'));
                goToTipsPage(page);
            });
        });
    } else {
        // Update existing dots with smooth transition
        const previousActiveDot = navContainer.querySelector('.tip-dot.active');

        existingDots.forEach((dot, index) => {
            if (index === currentTipsPage) {
                // Add morphing class for smooth transition
                if (previousActiveDot && previousActiveDot !== dot) {
                    dot.classList.add('morphing-in');
                    previousActiveDot.classList.add('morphing-out');

                    // Clean up morphing classes after transition
                    setTimeout(() => {
                        dot.classList.remove('morphing-in');
                        if (previousActiveDot) {
                            previousActiveDot.classList.remove('morphing-out');
                        }
                    }, 600);
                }
                dot.classList.add('active');
            } else {
                dot.classList.remove('active', 'animating');
            }
        });
    }

    // Start progress animation on active dot
    setTimeout(() => {
        const activeDot = navContainer.querySelector('.tip-dot.active');
        if (activeDot) {
            // Force animation restart by removing and re-adding class
            activeDot.classList.remove('animating');
            void activeDot.offsetWidth; // Trigger reflow
            activeDot.classList.add('animating');
        }
    }, 50);
}

function renderTips(withAnimation = true) {
    const tipsContainer = document.getElementById('tips-container');
    if (!tipsContainer || tipsPages.length === 0) return;

    const tipsToShow = tipsPages[currentTipsPage];

    if (withAnimation) {
        // Animate out
        tipsContainer.classList.add('animating-out');

        setTimeout(() => {
            // Update content
            tipsContainer.innerHTML = tipsToShow.map(tip => `
                <div class="tip-card">
                    <div class="tip-icon">
                        <i class="${tip.icon}"></i>
                    </div>
                    <h4>${tip.title}</h4>
                    <p>${tip.description}</p>
                </div>
            `).join('');

            // Animate in
            tipsContainer.classList.remove('animating-out');
            tipsContainer.classList.add('animating-in');

            setTimeout(() => {
                tipsContainer.classList.remove('animating-in');
            }, 600);
        }, 300);
    } else {
        // No animation, just render
        tipsContainer.innerHTML = tipsToShow.map(tip => `
            <div class="tip-card">
                <div class="tip-icon">
                    <i class="${tip.icon}"></i>
                </div>
                <h4>${tip.title}</h4>
                <p>${tip.description}</p>
            </div>
        `).join('');
    }

    // Update navigation dots
    renderNavigationDots();
}

function goToTipsPage(pageIndex) {
    if (pageIndex < 0 || pageIndex >= tipsPages.length) return;

    currentTipsPage = pageIndex;
    renderTips(true);

    // Reset auto-rotation timer
    if (tipsRotationInterval) {
        clearInterval(tipsRotationInterval);
        startAutoRotation();
    }
}

function nextTipsPage() {
    currentTipsPage = (currentTipsPage + 1) % tipsPages.length;
    renderTips(true);
}

function startAutoRotation() {
    tipsRotationInterval = setInterval(() => {
        nextTipsPage();
    }, 30000); // 30 seconds
}

function startTipsRotation() {
    // Create pages
    createTipsPages();

    if (tipsPages.length === 0) return;

    // Render initial tips without animation
    currentTipsPage = 0;
    renderTips(false);

    // Start auto-rotation
    if (tipsRotationInterval) {
        clearInterval(tipsRotationInterval);
    }
    startAutoRotation();
}

// ============================================
// PREMIUM SCROLL EFFECTS
// ============================================

function initializePremiumScrollEffects() {
    // All scroll effects removed for basic scrolling experience
}

// Initialize tips after a short delay
setTimeout(() => {
    startTipsRotation();
}, 1000);








async function refreshStatusBranch() {
    if (!isProUnlocked()) {
        setStatusGitBranch('--');
        return;
    }

    if (!currentProject || !currentProject.path) {
        setStatusGitBranch('--');
        return;
    }

    const hasGitRepository = currentProject.hasGit === true || isGitRepositoryPath(currentProject.path);
    currentProject.hasGit = hasGitRepository;
    if (!hasGitRepository) {
        setStatusGitBranch('--');
        return;
    }

    try {
        const result = await ipcRenderer.invoke('git-branches', currentProject.path);
        if (!result.success || !result.output) {
            setStatusGitBranch('--');
            return;
        }

        const activeBranch = result.output
            .split('\n')
            .map((branch) => branch.trim())
            .find((branch) => branch.startsWith('*'));

        if (!activeBranch) {
            setStatusGitBranch('main');
            return;
        }

        const activeName = activeBranch.replace('*', '').trim();
        setStatusGitBranch(activeName || 'main');
    } catch {
        setStatusGitBranch('--');
    }
}
