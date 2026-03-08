/* Runtime module: core/30-settings-model-ui.js */
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

    syncTitlebarUpdateControl();
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
    return pathIsAbsolute(value);
}

async function validateSettingsPayload(settings) {
    const normalized = normalizeSettings(settings);
    const errors = [];
    const warnings = [];

    if (!normalized.defaultProjectPath) {
        errors.push({ inputId: 'default-project-path', message: 'Project location is required' });
    } else if (!isAbsolutePathOrEmpty(normalized.defaultProjectPath)) {
        errors.push({ inputId: 'default-project-path', message: 'Use an absolute path' });
    } else if (!(await pathExistsOnDisk(normalized.defaultProjectPath))) {
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

    const pathChecks = [
        { id: 'editor-path', label: 'Editor path', value: normalized.editorPath },
        { id: 'terminal-path', label: 'Terminal path', value: normalized.terminalPath },
        { id: 'git-path', label: 'Git path', value: normalized.gitPath }
    ];

    for (const { id, label, value } of pathChecks) {
        if (!value) continue;
        if (!pathIsAbsolute(value)) {
            errors.push({ inputId: id, message: `${label} must be an absolute path` });
            continue;
        }
        if (!(await pathExistsOnDisk(value))) {
            warnings.push(`${label} does not exist on this machine.`);
        }
    }

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
            const imported = await ipcRenderer.invoke('import-settings-file', filePath);
            if (!imported || imported.success !== true || !imported.settings || typeof imported.settings !== 'object') {
                showNotification(imported?.error || 'Unable to import settings file', 'error');
                return;
            }

            // Validate and merge settings
            appSettings = { ...appSettings, ...imported.settings };

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
            const exported = await ipcRenderer.invoke('export-settings-file', filePath, appSettings);
            if (!exported || exported.success !== true) {
                showNotification(exported?.error || 'Unable to export settings file', 'error');
                return;
            }
            showNotification('Settings exported successfully', 'success');
        }
    } catch (error) {
        console.error('Failed to export settings:', error);
        showNotification('Failed to export settings', 'error');
    }
}

// Git functionality

