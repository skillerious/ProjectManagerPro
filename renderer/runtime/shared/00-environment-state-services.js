/* Runtime module: shared/00-environment-state-services.js */
const bridge = window.AppBridge;
if (!bridge || !bridge.ipc || !bridge.process) {
    throw new Error('Secure preload bridge is unavailable. Renderer startup aborted.');
}

const ipcRenderer = bridge.ipc;
const process = bridge.process;
const rendererModules = window.AppRendererModules;
if (!rendererModules?.pathUtils || !rendererModules?.cacheUtils || !rendererModules?.versionUtils || !rendererModules?.asyncUtils) {
    throw new Error('Renderer shared modules are unavailable. Renderer startup aborted.');
}

const {
    WINDOWS_PATH_SEPARATOR,
    normalizePathInput,
    pathIsAbsolute,
    joinPath,
    basenamePath,
    dirnamePath,
    resolvePath,
    buildFileUrl
} = rendererModules.pathUtils;

const {
    getCachedBooleanValue,
    setCachedBooleanValue
} = rendererModules.cacheUtils;

const {
    parseVersionParts,
    compareVersionDescending
} = rendererModules.versionUtils;

const {
    createExpiringAsyncCache
} = rendererModules.asyncUtils;

const createLogViewerController = rendererModules?.logViewer?.createLogViewerController;

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
    displayVersion: 'v1.0.0',
    channel: 'stable'
};
let updateState = {
    supported: false,
    checking: false,
    available: false,
    downloaded: false,
    downloadProgress: 0,
    currentVersion: '',
    channel: 'stable',
    availableChannels: ['stable', 'beta', 'alpha'],
    rollbackSupported: false,
    latestVersion: '',
    releaseDate: '',
    releaseNotes: '',
    lastCheckedAt: null,
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
let updateDialogResolve = null;
let updateDialogKeyHandler = null;
let updateDialogMotionTimer = null;
let cloneSmartDialogInProgress = false;
let cloneSmartDialogClosingTimer = null;
let cloneSmartLastProgressPercent = 0;
let cloneSmartContext = null;
let mutedUpdateReminderVersion = '';
let startupUpdateCheckTriggered = false;
let startupUpdatePromptShown = false;
let isHandlingAppCloseRequest = false;
let documentationLastView = 'dashboard';
let documentationSearchIndex = [];
let docsSearchDebounceTimer = null;
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
let githubAvatarPreviewElements = null;
let githubAvatarPreviewHideTimer = null;
let settingsExtensionsUiInitialized = false;
let settingsExtensionsSearchQuery = '';
let settingsExtensionsFilter = 'all';
let settingsExtensionsSort = 'name-asc';
let operationQueueJobs = [];
const operationQueueStatusMap = new Map();
const operationQueueFollowups = new Map();
let allProjectsSnapshotSignature = '';
let allProjectsRefreshTimer = null;
let allProjectsRefreshInFlight = false;
let allProjectsRefreshQueued = false;
let allProjectsFocusRefreshBound = false;
let allProjectsRequestToken = 0;
let projectsAlphabetRefreshFrame = null;
let projectsAlphabetScrollBindingInstalled = false;
let searchModalDebounceTimer = null;
let searchQueryRequestId = 0;
let workspaceProjectsSnapshot = [];
let githubReposLastRefreshAt = 0;
let legacyInlineActionBridgeInstalled = false;
let logViewerController = null;
const rendererFaultRecentReports = new Map();
let rendererFaultReportingInitialized = false;

const SETTINGS_EXTENSION_UPDATE_INTERVALS = new Set(['hourly', 'daily', 'weekly', 'never']);
const SETTINGS_TERMINAL_APPS = new Set(['cmd', 'powershell', 'wt', 'bash']);
const SETTINGS_UPDATE_CHANNELS = new Set(['stable', 'beta', 'alpha']);
const SETTINGS_FORM_INPUT_SELECTOR = '#settings-view .setting-item input, #settings-view .setting-item select, #settings-view .setting-item textarea';
const SETTINGS_SMART_DIALOG_EXIT_MS = 180;
const UPDATE_SMART_DIALOG_EXIT_MS = 200;
const CLONE_SMART_DIALOG_EXIT_MS = 180;
const VIEW_HISTORY_LIMIT = 60;
const ALL_PROJECTS_SMART_REFRESH_MS = 2500;
const SEARCH_INPUT_DEBOUNCE_MS = 220;
const PROJECT_RENDER_CHUNK_SIZE = 80;
const PATH_EXISTS_CACHE_TTL_MS = 8000;
const GIT_REPO_CACHE_TTL_MS = 8000;
const EXTENSIONS_CACHE_TTL_MS = 5000;
const GIT_PROJECTS_DROPDOWN_CACHE_TTL_MS = 4000;
const SEARCH_RESULTS_CACHE_TTL_MS = 3000;
const GITHUB_REPOS_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const RENDERER_FAULT_REPORT_COOLDOWN_MS = 12000;
const RENDERER_FAULT_MAX_CACHE_ENTRIES = 200;
const DEFAULT_RELEASES_URL = 'https://github.com/skillerious/ProjectManagerPro/releases';
const GITHUB_REPO_NAME_MAX_LENGTH = 100;
const GITHUB_REPO_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const PROJECT_ALPHABET_KEYS = ['#', ...Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index))];
const CLONE_PROGRESS_STAGE_ORDER = ['prepare', 'counting', 'receiving', 'resolving', 'finalizing'];
const CLONE_STAGE_LABELS = {
    prepare: 'Preparing workspace',
    initializing: 'Preparing clone environment',
    connecting: 'Connecting to remote',
    counting: 'Counting objects',
    compressing: 'Compressing objects',
    receiving: 'Receiving objects',
    resolving: 'Resolving deltas',
    checkout: 'Checking out files',
    finalizing: 'Finalizing clone',
    complete: 'Clone complete',
    failed: 'Clone failed'
};
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
const pathExistsCache = new Map();
const gitRepositoryCache = new Map();
const gitProjectsDropdownCache = createExpiringAsyncCache({
    ttlMs: GIT_PROJECTS_DROPDOWN_CACHE_TTL_MS,
    maxEntries: 1
});
const projectSearchResultsCache = createExpiringAsyncCache({
    ttlMs: SEARCH_RESULTS_CACHE_TTL_MS,
    maxEntries: 160
});

function markGitProjectsDropdownCacheStale() {
    gitProjectsDropdownCache.clear();
}

function clearProjectSearchResultsCache() {
    projectSearchResultsCache.clear();
}

async function pathExistsOnDisk(targetPath) {
    if (typeof targetPath !== 'string' || !targetPath.trim()) {
        return false;
    }

    const cacheKey = resolvePath(targetPath).toLowerCase();
    const cached = getCachedBooleanValue(pathExistsCache, cacheKey, PATH_EXISTS_CACHE_TTL_MS);
    if (cached.hit) {
        return cached.value;
    }

    try {
        const exists = Boolean(await ipcRenderer.invoke('path-exists', targetPath));
        setCachedBooleanValue(pathExistsCache, cacheKey, exists);
        return exists;
    } catch {
        return false;
    }
}

async function isGitRepositoryOnDisk(targetPath) {
    if (typeof targetPath !== 'string' || !targetPath.trim()) {
        return false;
    }

    const cacheKey = resolvePath(targetPath).toLowerCase();
    const cached = getCachedBooleanValue(gitRepositoryCache, cacheKey, GIT_REPO_CACHE_TTL_MS);
    if (cached.hit) {
        return cached.value;
    }

    try {
        const hasGit = Boolean(await ipcRenderer.invoke('is-git-repository', targetPath));
        setCachedBooleanValue(gitRepositoryCache, cacheKey, hasGit);
        return hasGit;
    } catch {
        return false;
    }
}

