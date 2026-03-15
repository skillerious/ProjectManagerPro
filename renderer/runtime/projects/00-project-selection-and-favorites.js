/* Runtime module: projects/00-project-selection-and-favorites.js */
function normalizeRecentProjectPath(projectPath) {
    if (!projectPath || typeof projectPath !== 'string') {
        return null;
    }

    return resolvePath(projectPath)
        .toLowerCase()
        .replace(/\\/g, '/')
        .replace(/\/$/, '');
}

const PROJECT_ARTWORK_SELECTIONS_STORAGE_KEY = 'appmanager.projectArtworkSelections.v1';
const PROJECT_ARTWORK_SELECTION_AUTO = '__auto__';
const PROJECT_ARTWORK_SELECTION_DEFAULT = '__default__';
const PROJECT_ARTWORK_CACHE_TTL_MS = 2 * 60 * 1000;

let projectArtworkSelections = {};
const projectArtworkCache = new Map();
const projectArtworkLookupInFlight = new Map();
let activeProjectArtworkDialogCloser = null;

function normalizeProjectArtworkSelectionValue(value) {
    if (value === PROJECT_ARTWORK_SELECTION_DEFAULT) {
        return PROJECT_ARTWORK_SELECTION_DEFAULT;
    }

    if (value === PROJECT_ARTWORK_SELECTION_AUTO) {
        return PROJECT_ARTWORK_SELECTION_AUTO;
    }

    if (typeof value !== 'string') {
        return PROJECT_ARTWORK_SELECTION_AUTO;
    }

    const normalized = value.trim().replace(/\\/g, '/');
    if (!normalized || normalized.length > 320 || /[\0\r\n]/.test(normalized)) {
        return PROJECT_ARTWORK_SELECTION_AUTO;
    }

    return normalized;
}

function loadProjectArtworkSelectionState() {
    try {
        const raw = localStorage.getItem(PROJECT_ARTWORK_SELECTIONS_STORAGE_KEY);
        if (!raw) {
            projectArtworkSelections = {};
            return;
        }

        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            projectArtworkSelections = {};
            return;
        }

        const nextState = {};
        Object.entries(parsed).forEach(([key, value]) => {
            if (typeof key !== 'string' || !key.trim()) {
                return;
            }

            const normalizedValue = normalizeProjectArtworkSelectionValue(value);
            if (normalizedValue !== PROJECT_ARTWORK_SELECTION_AUTO) {
                nextState[key] = normalizedValue;
            }
        });

        projectArtworkSelections = nextState;
    } catch {
        projectArtworkSelections = {};
    }
}

function saveProjectArtworkSelectionState() {
    try {
        localStorage.setItem(PROJECT_ARTWORK_SELECTIONS_STORAGE_KEY, JSON.stringify(projectArtworkSelections));
    } catch (error) {
        console.warn('Unable to persist project artwork selections:', error);
    }
}

function getProjectArtworkSelection(projectPath) {
    const normalizedPath = normalizeRecentProjectPath(projectPath);
    if (!normalizedPath) {
        return PROJECT_ARTWORK_SELECTION_AUTO;
    }

    return normalizeProjectArtworkSelectionValue(projectArtworkSelections[normalizedPath]);
}

function setProjectArtworkSelection(projectPath, selection) {
    const normalizedPath = normalizeRecentProjectPath(projectPath);
    if (!normalizedPath) {
        return false;
    }

    const normalizedSelection = normalizeProjectArtworkSelectionValue(selection);
    if (normalizedSelection === PROJECT_ARTWORK_SELECTION_AUTO) {
        delete projectArtworkSelections[normalizedPath];
    } else {
        projectArtworkSelections[normalizedPath] = normalizedSelection;
    }

    saveProjectArtworkSelectionState();
    return true;
}

function moveProjectArtworkSelectionPath(oldPath, newPath) {
    const oldKey = normalizeRecentProjectPath(oldPath);
    const newKey = normalizeRecentProjectPath(newPath);

    if (!oldKey || !newKey || oldKey === newKey) {
        return;
    }

    const selection = projectArtworkSelections[oldKey];
    if (typeof selection !== 'string' || !selection) {
        return;
    }

    projectArtworkSelections[newKey] = selection;
    delete projectArtworkSelections[oldKey];
    saveProjectArtworkSelectionState();

    const oldCache = projectArtworkCache.get(oldKey);
    if (oldCache) {
        projectArtworkCache.set(newKey, oldCache);
        projectArtworkCache.delete(oldKey);
    }
}

function invalidateProjectArtworkCache(projectPath) {
    const normalizedPath = normalizeRecentProjectPath(projectPath);
    if (!normalizedPath) {
        return;
    }

    projectArtworkCache.delete(normalizedPath);
}

function sanitizeProjectArtworkCandidate(candidate) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        return null;
    }

    const relativePath = typeof candidate.relativePath === 'string'
        ? candidate.relativePath.trim().replace(/\\/g, '/')
        : '';
    const fileUrl = typeof candidate.fileUrl === 'string'
        ? candidate.fileUrl.trim()
        : '';
    const fileName = typeof candidate.fileName === 'string'
        ? candidate.fileName.trim()
        : '';
    const extension = typeof candidate.extension === 'string'
        ? candidate.extension.trim().toLowerCase()
        : '';
    const width = Number.isFinite(candidate?.width)
        ? Math.max(0, Math.floor(Number(candidate.width)))
        : 0;
    const height = Number.isFinite(candidate?.height)
        ? Math.max(0, Math.floor(Number(candidate.height)))
        : 0;
    const fileSizeBytes = Number.isFinite(candidate?.fileSizeBytes)
        ? Math.max(0, Math.floor(Number(candidate.fileSizeBytes)))
        : 0;
    const score = Number.isFinite(candidate?.score)
        ? Number(candidate.score)
        : 0;

    if (!relativePath || !fileUrl || !fileUrl.startsWith('file:')) {
        return null;
    }

    return {
        relativePath,
        fileName: fileName || basenamePath(relativePath) || relativePath,
        extension,
        width,
        height,
        fileSizeBytes,
        score,
        fileUrl
    };
}

function normalizeProjectArtworkScanResponse(response) {
    const candidates = Array.isArray(response?.candidates)
        ? response.candidates.map(sanitizeProjectArtworkCandidate).filter(Boolean)
        : [];

    return {
        success: response?.success === true,
        candidates,
        scannedAssetsFolders: Number.isFinite(response?.scannedAssetsFolders)
            ? Math.max(0, Math.floor(Number(response.scannedAssetsFolders)))
            : 0,
        scannedArtworkDirectories: Number.isFinite(response?.scannedArtworkDirectories)
            ? Math.max(0, Math.floor(Number(response.scannedArtworkDirectories)))
            : 0,
        error: typeof response?.error === 'string' ? response.error : ''
    };
}

function getCachedProjectArtworkScan(projectPath, options = {}) {
    const normalizedPath = normalizeRecentProjectPath(projectPath);
    if (!normalizedPath) {
        return null;
    }

    const cached = projectArtworkCache.get(normalizedPath);
    if (!cached || !cached.data) {
        return null;
    }

    const allowStale = options.allowStale === true;
    if (!allowStale && (Date.now() - cached.ts) > PROJECT_ARTWORK_CACHE_TTL_MS) {
        projectArtworkCache.delete(normalizedPath);
        return null;
    }

    return cached.data;
}

async function fetchProjectArtworkScan(projectPath, options = {}) {
    const normalizedPath = normalizeRecentProjectPath(projectPath);
    if (!normalizedPath) {
        return normalizeProjectArtworkScanResponse(null);
    }

    const force = options.force === true;
    if (!force) {
        const cached = getCachedProjectArtworkScan(projectPath);
        if (cached) {
            return cached;
        }
    }

    const inFlight = projectArtworkLookupInFlight.get(normalizedPath);
    if (inFlight) {
        return inFlight;
    }

    const ARTWORK_LOOKUP_TIMEOUT_MS = 30000;

    const request = (async () => {
        try {
            const responsePromise = ipcRenderer.invoke('get-project-artwork-candidates', projectPath);
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Artwork lookup timed out')), ARTWORK_LOOKUP_TIMEOUT_MS);
            });
            const response = await Promise.race([responsePromise, timeoutPromise]);
            const normalizedResponse = normalizeProjectArtworkScanResponse(response);
            projectArtworkCache.set(normalizedPath, {
                ts: Date.now(),
                data: normalizedResponse
            });
            return normalizedResponse;
        } catch (error) {
            console.warn('Failed to fetch project artwork candidates:', error);
            const fallback = normalizeProjectArtworkScanResponse({
                success: false,
                error: error?.message || 'Failed to fetch project artwork candidates',
                candidates: [],
                scannedAssetsFolders: 0,
                scannedArtworkDirectories: 0
            });
            projectArtworkCache.set(normalizedPath, {
                ts: Date.now(),
                data: fallback
            });
            return fallback;
        } finally {
            projectArtworkLookupInFlight.delete(normalizedPath);
        }
    })();

    projectArtworkLookupInFlight.set(normalizedPath, request);
    return request;
}

function resolveProjectArtworkSelection(candidates, selection) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
        return null;
    }

    if (selection === PROJECT_ARTWORK_SELECTION_DEFAULT) {
        return null;
    }

    if (selection && selection !== PROJECT_ARTWORK_SELECTION_AUTO) {
        const normalizedSelection = selection.toLowerCase();
        const matched = candidates.find((candidate) => candidate.relativePath.toLowerCase() === normalizedSelection);
        if (matched) {
            return matched;
        }
    }

    return candidates[0];
}

function buildProjectArtworkInfo(projectPath, scanResponse = null) {
    const normalizedScan = scanResponse && typeof scanResponse === 'object'
        ? scanResponse
        : normalizeProjectArtworkScanResponse(null);
    const candidates = Array.isArray(normalizedScan.candidates) ? normalizedScan.candidates : [];
    let selection = getProjectArtworkSelection(projectPath);
    let activeCandidate = resolveProjectArtworkSelection(candidates, selection);

    if (selection !== PROJECT_ARTWORK_SELECTION_AUTO && selection !== PROJECT_ARTWORK_SELECTION_DEFAULT && !activeCandidate) {
        selection = PROJECT_ARTWORK_SELECTION_AUTO;
        setProjectArtworkSelection(projectPath, PROJECT_ARTWORK_SELECTION_AUTO);
        activeCandidate = resolveProjectArtworkSelection(candidates, selection);
    }

    return {
        selection,
        activeCandidate: activeCandidate || null,
        candidates,
        hasArtwork: Boolean(activeCandidate),
        hasCandidates: candidates.length > 0,
        hasMultipleCandidates: candidates.length > 1,
        scannedAssetsFolders: Number.isFinite(normalizedScan.scannedAssetsFolders)
            ? normalizedScan.scannedAssetsFolders
            : 0,
        scannedArtworkDirectories: Number.isFinite(normalizedScan.scannedArtworkDirectories)
            ? normalizedScan.scannedArtworkDirectories
            : 0,
        error: typeof normalizedScan.error === 'string' ? normalizedScan.error : ''
    };
}

function getCachedProjectArtworkInfo(projectPath, options = {}) {
    const scanResponse = getCachedProjectArtworkScan(projectPath, options);
    if (!scanResponse) {
        return null;
    }

    return buildProjectArtworkInfo(projectPath, scanResponse);
}

async function getProjectArtworkInfo(projectPath, options = {}) {
    const scanResponse = await fetchProjectArtworkScan(projectPath, options);
    return buildProjectArtworkInfo(projectPath, scanResponse);
}

function buildProjectCardIconMarkup(config = {}, artworkCandidate = null) {
    const accentColor = typeof config.color === 'string' && config.color
        ? config.color
        : '#dcb67a';
    const iconClass = escapeHtml(config.icon || 'fas fa-folder');
    const safeProjectName = escapeHtml(config.projectName || 'Project');

    if (artworkCandidate && artworkCandidate.fileUrl) {
        return `
            <div class="project-icon-modern project-icon-artwork" data-project-icon-slot style="--project-artwork-accent: ${accentColor}">
                <span class="project-icon-artwork-glow"></span>
                <img src="${escapeHtml(artworkCandidate.fileUrl)}" alt="${safeProjectName} artwork" loading="lazy">
            </div>
        `;
    }

    return `
        <div class="project-icon-modern" data-project-icon-slot style="background: ${accentColor}15; color: ${accentColor}">
            <i class="${iconClass}"></i>
        </div>
    `;
}

function buildProjectCardIconConfigFromCard(card) {
    return {
        color: card?.dataset?.projectAccentColor || '#dcb67a',
        icon: card?.dataset?.projectTypeIcon || 'fas fa-folder',
        projectName: card?.dataset?.projectName || 'Project'
    };
}

function applyProjectArtworkStateToCard(card, artworkInfo) {
    if (!card || !artworkInfo || typeof artworkInfo !== 'object') {
        return;
    }

    const iconSlot = card.querySelector('[data-project-icon-slot]');
    if (!iconSlot) {
        return;
    }

    const normalizedCardPath = normalizeRecentProjectPath(card.dataset.projectPath || '');
    if (!normalizedCardPath) {
        return;
    }

    const activeCandidate = artworkInfo.activeCandidate || null;
    const nextSignature = activeCandidate
        ? `art:${activeCandidate.relativePath}`
        : `icon:${artworkInfo.selection || PROJECT_ARTWORK_SELECTION_AUTO}`;
    if (card.dataset.projectArtworkSignature === nextSignature) {
        return;
    }

    iconSlot.outerHTML = buildProjectCardIconMarkup(buildProjectCardIconConfigFromCard(card), activeCandidate);
    card.dataset.projectArtworkSignature = nextSignature;

    if (activeCandidate) {
        card.classList.add('has-project-artwork');
        card.dataset.projectArtworkPath = activeCandidate.relativePath;
    } else {
        card.classList.remove('has-project-artwork');
        delete card.dataset.projectArtworkPath;
    }

    const nextIconSlot = card.querySelector('[data-project-icon-slot]');
    if (!nextIconSlot || !activeCandidate) {
        return;
    }

    const artworkImage = nextIconSlot.querySelector('img');
    artworkImage?.addEventListener('error', () => {
        invalidateProjectArtworkCache(card.dataset.projectPath || '');
        card.dataset.projectArtworkSignature = '';
        applyProjectArtworkStateToCard(card, {
            ...artworkInfo,
            activeCandidate: null,
            hasArtwork: false
        });
    }, { once: true });
}

async function refreshProjectCardArtwork(card, projectPath, options = {}) {
    if (!card) {
        return;
    }

    const targetPath = typeof projectPath === 'string' && projectPath.trim()
        ? projectPath
        : card.dataset.projectPath || '';
    const normalizedTargetPath = normalizeRecentProjectPath(targetPath);
    if (!normalizedTargetPath) {
        return;
    }

    const cachedInfo = getCachedProjectArtworkInfo(targetPath);
    if (cachedInfo) {
        applyProjectArtworkStateToCard(card, cachedInfo);
    }

    const info = await getProjectArtworkInfo(targetPath, { force: options.force === true });
    if (!document.body.contains(card)) {
        return;
    }

    if (normalizeRecentProjectPath(card.dataset.projectPath || '') !== normalizedTargetPath) {
        return;
    }

    applyProjectArtworkStateToCard(card, info);
}

function syncProjectArtworkAcrossCards(projectPath, options = {}) {
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

        void refreshProjectCardArtwork(card, projectPath, options);
    });
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

async function isGitRepositoryPath(projectPath) {
    return isGitRepositoryOnDisk(projectPath);
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
        hasGit: project.isGitRepo === true || project.hasGit === true
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
    displayRecentProjects();
    setSelectedProjectCardByPath(currentProject?.path || '');
    scheduleProjectsAlphabetRefresh();

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
    moveProjectArtworkSelectionPath(project.path, renamedProject.path);
    invalidateProjectArtworkCache(project.path);
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

function haveRecentProjectsChanged(nextProjects) {
    if (!Array.isArray(nextProjects) || nextProjects.length !== recentProjects.length) {
        return true;
    }

    for (let i = 0; i < nextProjects.length; i += 1) {
        const currentKey = normalizeRecentProjectPath(recentProjects[i]?.path || '');
        const nextKey = normalizeRecentProjectPath(nextProjects[i]?.path || '');
        if (currentKey !== nextKey) {
            return true;
        }
    }

    return false;
}

async function reconcileRecentProjectsWithDisk() {
    const seenPaths = new Set();
    const validProjects = [];
    let selectedProjectWasRemoved = false;
    const selectedProjectKey = normalizeRecentProjectPath(currentProject?.path || '');

    for (const project of recentProjects) {
        if (!project || !project.path) {
            continue;
        }

        const normalizedPath = normalizeRecentProjectPath(project.path);
        if (!normalizedPath) {
            continue;
        }

        if (seenPaths.has(normalizedPath)) {
            continue;
        }

        if (!(await pathExistsOnDisk(project.path))) {
            if (selectedProjectKey && selectedProjectKey === normalizedPath) {
                selectedProjectWasRemoved = true;
            }
            continue;
        }

        seenPaths.add(normalizedPath);
        validProjects.push({
            ...project,
            lastAccessed: project.lastAccessed || Date.now()
        });
    }

    validProjects.sort(compareProjectsForDisplay);
    const recentLimit = getRecentProjectsLimitSetting();
    const limitedProjects = validProjects.slice(0, recentLimit);

    if (!haveRecentProjectsChanged(limitedProjects)) {
        return false;
    }

    recentProjects = limitedProjects;
    await ipcRenderer.invoke('save-recent-projects', recentProjects);

    if (selectedProjectWasRemoved) {
        currentProject = null;
        updateStatusBarProject('No project selected');
        setSelectedProjectCardByPath('');
    }

    displayRecentProjects();
    updateStatusProjectCounts(document.querySelectorAll('#all-projects-list .project-card-modern').length, recentProjects.length);
    return true;
}

async function loadRecentProjects() {
    const storedProjects = await ipcRenderer.invoke('get-recent-projects');
    recentProjects = Array.isArray(storedProjects) ? storedProjects : [];
    const changed = await reconcileRecentProjectsWithDisk();
    if (!changed) {
        displayRecentProjects();
        updateStatusProjectCounts(document.querySelectorAll('#all-projects-list .project-card-modern').length, recentProjects.length);
    }
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
    const hasGit = project.isGitRepo === true || project.hasGit === true;
    const isFavorite = isFavoriteProject(project.path);
    const modifiedTimestamp = project.lastModified
        ? new Date(project.lastModified).getTime()
        : (project.lastAccessed || Date.now());

    card.dataset.type = project.type || 'unknown';
    card.dataset.modified = String(Number.isFinite(modifiedTimestamp) ? modifiedTimestamp : Date.now());
    card.dataset.hasGit = String(Boolean(hasGit || project.isGitRepo === true));
    card.dataset.projectPath = project.path || '';
    card.dataset.searchText = `${String(project.name || '')} ${String(project.path || '')}`.toLowerCase();
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
    card.style.setProperty('--project-accent', config.color);
    const safeProjectName = escapeHtml(project.name || 'Untitled Project');
    const safeProjectPath = escapeHtml(project.path || '');
    const safeTruncatedProjectPath = escapeHtml(truncatePath(project.path || '', 56));
    const projectParentPath = dirnamePath(project.path || '') || '';
    const parentFolderName = basenamePath(projectParentPath) || projectParentPath || 'Workspace';
    const safeParentFolderName = escapeHtml(parentFolderName);
    const safeProjectParentPath = escapeHtml(projectParentPath);
    const alphaKey = deriveProjectAlphaKey(project.name || parentFolderName || project.path || '');
    card.dataset.alphaKey = alphaKey;
    card.dataset.projectAccentColor = config.color;
    card.dataset.projectTypeIcon = config.icon;
    card.dataset.projectName = String(project.name || 'Untitled Project');

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
                <div class="project-identity">
                    ${buildProjectCardIconMarkup({ ...config, projectName: project.name || 'Untitled Project' })}
                    <div class="project-headline">
                        <h3 class="project-name" title="${safeProjectName}">${safeProjectName}</h3>
                        <p class="project-subpath" title="${safeProjectParentPath}">${safeParentFolderName}</p>
                    </div>
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
                <div class="project-meta">
                    <span class="project-type-badge" style="background: ${config.color}20; color: ${config.color}">
                        ${config.label}
                    </span>
                    <span class="project-inline-pill ${hasGit ? 'git' : 'local'}">
                        <i class="fas ${hasGit ? 'fa-code-branch' : 'fa-box'}"></i>
                        ${hasGit ? 'Git' : 'Local'}
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
        void showDeleteProjectModal(safeProject);
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

    void refreshProjectCardArtwork(card, project.path);

    return card;
}

function setProjectArtworkContextMenuItemState(menuItem, options = {}) {
    if (!menuItem) {
        return;
    }

    const label = typeof options.label === 'string' && options.label.trim()
        ? options.label.trim()
        : 'Project Artwork';
    const disabled = options.disabled === true;
    const loading = options.loading === true;
    const hint = typeof options.hint === 'string' ? options.hint.trim() : '';

    const labelEl = menuItem.querySelector('span');
    if (labelEl) {
        labelEl.textContent = label;
    }

    menuItem.classList.toggle('is-disabled', disabled);
    menuItem.classList.toggle('is-loading', loading);
    menuItem.dataset.disabled = String(disabled);
    menuItem.title = hint;
}

async function hydrateProjectArtworkContextMenuItem(menu, project) {
    const menuItem = menu?.querySelector('.context-menu-item[data-action="change-artwork"]');
    if (!menuItem || !project?.path) {
        return;
    }

    const cachedInfo = getCachedProjectArtworkInfo(project.path, { allowStale: true });
    if (cachedInfo) {
        if (cachedInfo.hasMultipleCandidates) {
            setProjectArtworkContextMenuItemState(menuItem, {
                label: 'Change Project Artwork',
                disabled: false,
                loading: false,
                hint: `${cachedInfo.candidates.length} artwork files found`
            });
        } else if (cachedInfo.hasCandidates) {
            setProjectArtworkContextMenuItemState(menuItem, {
                label: 'Project Artwork Options',
                disabled: false,
                loading: false,
                hint: 'Select auto artwork or the default icon'
            });
        } else {
            setProjectArtworkContextMenuItemState(menuItem, {
                label: 'No Project Artwork Found',
                disabled: true,
                loading: false,
                hint: (cachedInfo.scannedArtworkDirectories > 0 || cachedInfo.scannedAssetsFolders > 0)
                    ? 'No logo/icon files found in artwork folders'
                    : 'No artwork folder discovered'
            });
        }
    } else {
        setProjectArtworkContextMenuItemState(menuItem, {
            label: 'Scanning Project Artwork...',
            disabled: true,
            loading: true,
            hint: 'Scanning artwork folders for logo files'
        });
    }

    const info = await getProjectArtworkInfo(project.path, { force: false });
    if (!document.body.contains(menu) || !menuItem.isConnected) {
        return;
    }

    if (info.hasMultipleCandidates) {
        setProjectArtworkContextMenuItemState(menuItem, {
            label: 'Change Project Artwork',
            disabled: false,
            loading: false,
            hint: `${info.candidates.length} artwork files available`
        });
        return;
    }

    if (info.hasCandidates) {
        setProjectArtworkContextMenuItemState(menuItem, {
            label: 'Project Artwork Options',
            disabled: false,
            loading: false,
            hint: 'Choose auto artwork or fallback icon'
        });
        return;
    }

    setProjectArtworkContextMenuItemState(menuItem, {
        label: 'No Project Artwork Found',
        disabled: true,
        loading: false,
        hint: (info.scannedArtworkDirectories > 0 || info.scannedAssetsFolders > 0)
            ? 'No logo/icon files found in artwork folders'
            : 'No artwork folder discovered for this project'
    });
}

function formatProjectArtworkFileSize(bytes) {
    const value = Number(bytes) || 0;
    if (value <= 0) {
        return '';
    }

    const units = ['B', 'KB', 'MB', 'GB'];
    let scaled = value;
    let unitIndex = 0;
    while (scaled >= 1024 && unitIndex < units.length - 1) {
        scaled /= 1024;
        unitIndex += 1;
    }
    const precision = scaled >= 10 || unitIndex === 0 ? 0 : 1;
    return `${scaled.toFixed(precision)} ${units[unitIndex]}`;
}

function formatProjectArtworkDimensions(candidate) {
    const width = Number(candidate?.width) || 0;
    const height = Number(candidate?.height) || 0;
    if (width <= 0 || height <= 0) {
        return '';
    }

    return `${width}x${height}`;
}

function buildProjectArtworkPickerOptions(artworkInfo = null) {
    const info = artworkInfo && typeof artworkInfo === 'object'
        ? artworkInfo
        : { candidates: [] };
    const candidates = Array.isArray(info.candidates) ? info.candidates : [];
    const autoCandidate = candidates[0] || null;
    const autoMetaParts = [];
    const autoDimensions = formatProjectArtworkDimensions(autoCandidate);
    const autoSize = formatProjectArtworkFileSize(autoCandidate?.fileSizeBytes || 0);
    if (autoDimensions) autoMetaParts.push(autoDimensions);
    if (autoSize) autoMetaParts.push(autoSize);

    const options = [
        {
            value: PROJECT_ARTWORK_SELECTION_AUTO,
            label: 'Auto Pick',
            description: autoCandidate
                ? `Best match: ${autoCandidate.fileName || autoCandidate.relativePath}`
                : 'No detected artwork available',
            pathHint: autoCandidate?.relativePath || '',
            badge: autoCandidate ? 'Recommended' : '',
            iconClass: 'fas fa-magic',
            candidate: autoCandidate,
            sortScore: Number(autoCandidate?.score) || Number.MAX_SAFE_INTEGER,
            sortBytes: Number(autoCandidate?.fileSizeBytes) || 0,
            sortArea: (Number(autoCandidate?.width) || 0) * (Number(autoCandidate?.height) || 0),
            isSystemOption: true,
            systemOrder: 0,
            searchText: `auto recommended ${autoCandidate?.fileName || ''} ${autoCandidate?.relativePath || ''} ${autoMetaParts.join(' ')}`
        },
        {
            value: PROJECT_ARTWORK_SELECTION_DEFAULT,
            label: 'Type Icon',
            description: 'Use the project-type icon on the card',
            pathHint: '',
            badge: '',
            iconClass: 'fas fa-layer-group',
            candidate: null,
            sortScore: Number.MIN_SAFE_INTEGER,
            sortBytes: 0,
            sortArea: 0,
            isSystemOption: true,
            systemOrder: 1,
            searchText: 'default icon type fallback'
        }
    ];

    candidates.forEach((candidate, index) => {
        const dimensions = formatProjectArtworkDimensions(candidate);
        const fileSize = formatProjectArtworkFileSize(candidate.fileSizeBytes);
        const metaParts = [];
        if (dimensions) metaParts.push(dimensions);
        if (fileSize) metaParts.push(fileSize);

        options.push({
            value: candidate.relativePath,
            label: candidate.fileName || `Artwork ${index + 1}`,
            description: metaParts.length > 0 ? metaParts.join(' • ') : 'Artwork file',
            pathHint: candidate.relativePath,
            badge: index === 0 ? 'Top Match' : '',
            iconClass: 'fas fa-image',
            candidate,
            sortScore: Number(candidate.score) || 0,
            sortBytes: Number(candidate.fileSizeBytes) || 0,
            sortArea: (Number(candidate.width) || 0) * (Number(candidate.height) || 0),
            isSystemOption: false,
            systemOrder: 99,
            searchText: `${candidate.fileName || ''} ${candidate.relativePath || ''} ${metaParts.join(' ')}`
        });
    });

    return options;
}

function createProjectArtworkPickerOptionElement(option, selectedValue) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'project-artwork-option';
    button.dataset.selectionValue = option.value;
    button.setAttribute('aria-pressed', String(option.value === selectedValue));
    button.classList.toggle('is-selected', option.value === selectedValue);

    const hasImagePreview = Boolean(option?.candidate?.fileUrl);
    const safeImageUrl = hasImagePreview ? escapeHtml(option.candidate.fileUrl) : '';
    const safeLabel = escapeHtml(option.label || 'Artwork');
    const safeDescription = escapeHtml(option.description || '');
    const safePathHint = escapeHtml(option.pathHint || '');
    const safeBadge = escapeHtml(option.badge || '');
    const safeIconClass = escapeHtml(option.iconClass || 'fas fa-image');

    button.innerHTML = `
        <span class="project-artwork-option-check"><i class="fas fa-check"></i></span>
        ${safeBadge ? `<span class="project-artwork-option-badge">${safeBadge}</span>` : ''}
        <span class="project-artwork-thumb ${hasImagePreview ? '' : 'project-artwork-thumb-placeholder'}">
            ${hasImagePreview
                ? `<img src="${safeImageUrl}" alt="${safeLabel} preview" loading="lazy">`
                : `<i class="${safeIconClass}"></i>`}
        </span>
        <span class="project-artwork-option-label">${safeLabel}</span>
        <span class="project-artwork-option-desc">${safeDescription}</span>
        ${safePathHint ? `<span class="project-artwork-option-path" title="${safePathHint}">${safePathHint}</span>` : ''}
    `;
    button.title = option.pathHint || option.description || option.label || '';

    return button;
}

async function showProjectArtworkPickerDialog(project, artworkInfo) {
    const overlay = document.getElementById('project-artwork-overlay');
    const titleEl = document.getElementById('project-artwork-title');
    const subtitleEl = document.getElementById('project-artwork-subtitle');
    const metaEl = document.getElementById('project-artwork-meta');
    const searchInput = document.getElementById('project-artwork-search');
    const sortSelect = document.getElementById('project-artwork-sort');
    const rescanBtn = document.getElementById('project-artwork-rescan');
    const gridEl = document.getElementById('project-artwork-grid');
    const applyBtn = document.getElementById('project-artwork-apply');
    const cancelBtn = document.getElementById('project-artwork-cancel');
    const closeBtn = document.getElementById('project-artwork-close');

    if (!overlay || !titleEl || !subtitleEl || !metaEl || !searchInput || !sortSelect || !rescanBtn || !gridEl || !applyBtn || !cancelBtn || !closeBtn) {
        return null;
    }

    if (typeof activeProjectArtworkDialogCloser === 'function') {
        activeProjectArtworkDialogCloser(null);
    }

    let info = artworkInfo && typeof artworkInfo === 'object' ? artworkInfo : await getProjectArtworkInfo(project.path);
    let options = buildProjectArtworkPickerOptions(info);
    const currentSelection = typeof info.selection === 'string' ? info.selection : PROJECT_ARTWORK_SELECTION_AUTO;
    const matchedSelectionOption = options.find((option) => {
        if (typeof option.value !== 'string') {
            return false;
        }
        return option.value.toLowerCase() === currentSelection.toLowerCase();
    });
    let selectedValue = matchedSelectionOption
        ? matchedSelectionOption.value
        : PROJECT_ARTWORK_SELECTION_AUTO;

    const projectLabel = project?.name || basenamePath(project?.path || '') || 'Project';
    titleEl.textContent = 'Project Artwork';
    subtitleEl.textContent = `Choose how ${projectLabel} is displayed in All Projects.`;
    searchInput.value = '';
    sortSelect.value = sortSelect.value || 'score';

    let optionButtons = [];

    const updateMetaText = () => {
        if (info.candidates.length > 0) {
            const directoryCount = info.scannedArtworkDirectories > 0
                ? info.scannedArtworkDirectories
                : info.scannedAssetsFolders;
            metaEl.textContent = directoryCount > 0
                ? `${info.candidates.length} artwork file${info.candidates.length === 1 ? '' : 's'} detected across ${directoryCount} artwork folder${directoryCount === 1 ? '' : 's'}`
                : `${info.candidates.length} artwork file${info.candidates.length === 1 ? '' : 's'} detected`;
            return;
        }

        metaEl.textContent = 'No artwork files detected. Try Rescan after adding logos.';
    };

    const getVisibleOptions = () => {
        const query = searchInput.value.trim().toLowerCase();
        const systemOptions = options
            .filter((option) => option.isSystemOption)
            .sort((a, b) => a.systemOrder - b.systemOrder);
        let candidateOptions = options.filter((option) => !option.isSystemOption);

        if (query) {
            candidateOptions = candidateOptions.filter((option) => {
                const searchText = `${option.searchText || ''} ${option.label || ''} ${option.pathHint || ''}`.toLowerCase();
                return searchText.includes(query);
            });
        }

        const sortMode = sortSelect.value || 'score';
        candidateOptions.sort((left, right) => {
            if (sortMode === 'name') {
                return String(left.label || '').localeCompare(String(right.label || ''), undefined, { sensitivity: 'base', numeric: true });
            }
            if (sortMode === 'size') {
                if (right.sortBytes !== left.sortBytes) {
                    return right.sortBytes - left.sortBytes;
                }
            } else if (sortMode === 'dimensions') {
                if (right.sortArea !== left.sortArea) {
                    return right.sortArea - left.sortArea;
                }
            } else {
                if (right.sortScore !== left.sortScore) {
                    return right.sortScore - left.sortScore;
                }
            }

            if (right.sortScore !== left.sortScore) {
                return right.sortScore - left.sortScore;
            }
            return String(left.pathHint || left.label || '').localeCompare(String(right.pathHint || right.label || ''), undefined, {
                sensitivity: 'base',
                numeric: true
            });
        });

        return [...systemOptions, ...candidateOptions];
    };

    const renderOptions = () => {
        const visibleOptions = getVisibleOptions();
        const selectionStillVisible = visibleOptions.some((option) => option.value === selectedValue);
        if (!selectionStillVisible) {
            selectedValue = PROJECT_ARTWORK_SELECTION_AUTO;
        }

        gridEl.innerHTML = '';
        optionButtons = [];

        if (visibleOptions.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'project-artwork-empty';
            empty.innerHTML = '<i class="fas fa-magnifying-glass"></i><span>No artwork matched your filter.</span>';
            gridEl.appendChild(empty);
            return;
        }

        visibleOptions.forEach((option) => {
            const button = createProjectArtworkPickerOptionElement(option, selectedValue);
            button.addEventListener('click', () => {
                selectedValue = option.value;
                optionButtons.forEach((item) => {
                    const selected = item.dataset.selectionValue === selectedValue;
                    item.classList.toggle('is-selected', selected);
                    item.setAttribute('aria-pressed', String(selected));
                });
                applyBtn.disabled = false;
            });
            gridEl.appendChild(button);
            optionButtons.push(button);
        });
    };

    const setRescanBusy = (busy) => {
        const isBusy = busy === true;
        rescanBtn.disabled = isBusy;
        rescanBtn.classList.toggle('is-busy', isBusy);
    };

    updateMetaText();
    renderOptions();
    setRescanBusy(false);

    overlay.classList.add('active');
    overlay.setAttribute('aria-hidden', 'false');
    applyBtn.disabled = false;

    return new Promise((resolve) => {
        let closed = false;

        const closeDialog = (result = null) => {
            if (closed) {
                return;
            }

            closed = true;
            overlay.classList.remove('active');
            overlay.setAttribute('aria-hidden', 'true');

            overlay.removeEventListener('mousedown', handleOverlayMouseDown);
            document.removeEventListener('keydown', handleKeyDown, true);
            cancelBtn.removeEventListener('click', handleCancel);
            closeBtn.removeEventListener('click', handleCancel);
            applyBtn.removeEventListener('click', handleApply);
            searchInput.removeEventListener('input', handleSearchInput);
            sortSelect.removeEventListener('change', handleSortChange);
            rescanBtn.removeEventListener('click', handleRescan);

            if (activeProjectArtworkDialogCloser === closeDialog) {
                activeProjectArtworkDialogCloser = null;
            }

            resolve(result);
        };

        const handleCancel = () => {
            closeDialog(null);
        };

        const handleApply = () => {
            closeDialog(selectedValue);
        };

        const handleSearchInput = () => {
            renderOptions();
        };

        const handleSortChange = () => {
            renderOptions();
        };

        const handleRescan = async () => {
            setRescanBusy(true);
            metaEl.textContent = 'Rescanning artwork folders...';
            try {
                invalidateProjectArtworkCache(project.path);
                info = await getProjectArtworkInfo(project.path, { force: true });
                options = buildProjectArtworkPickerOptions(info);
                updateMetaText();
                renderOptions();
            } catch (error) {
                console.warn('Project artwork rescan failed:', error);
                showNotification('Unable to rescan artwork right now', 'warning');
                updateMetaText();
            } finally {
                setRescanBusy(false);
            }
        };

        const handleOverlayMouseDown = (event) => {
            if (event.target === overlay) {
                closeDialog(null);
            }
        };

        const handleKeyDown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                closeDialog(null);
                return;
            }

            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                closeDialog(selectedValue);
            }
        };

        activeProjectArtworkDialogCloser = closeDialog;

        overlay.addEventListener('mousedown', handleOverlayMouseDown);
        document.addEventListener('keydown', handleKeyDown, true);
        cancelBtn.addEventListener('click', handleCancel);
        closeBtn.addEventListener('click', handleCancel);
        applyBtn.addEventListener('click', handleApply);
        searchInput.addEventListener('input', handleSearchInput);
        sortSelect.addEventListener('change', handleSortChange);
        rescanBtn.addEventListener('click', handleRescan);

        requestAnimationFrame(() => {
            const selectedBtn = optionButtons.find((button) => button.dataset.selectionValue === selectedValue);
            (selectedBtn || optionButtons[0] || searchInput).focus({ preventScroll: true });
        });
    });
}

async function changeProjectArtworkFromContext(project) {
    if (!project?.path) {
        return;
    }

    const artworkInfo = await getProjectArtworkInfo(project.path, { force: true });
    if (!artworkInfo.hasCandidates) {
        showNotification(
            (artworkInfo.scannedArtworkDirectories > 0 || artworkInfo.scannedAssetsFolders > 0)
                ? 'No logo or icon artwork found in scanned artwork folders.'
                : 'No artwork folders were found for this project.',
            'info'
        );
        return;
    }

    const selectedValue = await showProjectArtworkPickerDialog(project, artworkInfo);
    if (selectedValue === null || selectedValue === undefined) {
        return;
    }

    const normalizedSelectedValue = normalizeProjectArtworkSelectionValue(selectedValue);
    const previousSelection = getProjectArtworkSelection(project.path);
    if (normalizedSelectedValue === previousSelection) {
        return;
    }

    const projectLabel = project.name || basenamePath(project.path) || 'project';
    setProjectArtworkSelection(project.path, normalizedSelectedValue);
    syncProjectArtworkAcrossCards(project.path, { force: false });

    if (normalizedSelectedValue === PROJECT_ARTWORK_SELECTION_DEFAULT) {
        showNotification(`Using default icon for ${projectLabel}`, 'success');
        return;
    }

    if (normalizedSelectedValue === PROJECT_ARTWORK_SELECTION_AUTO) {
        showNotification(`Artwork auto-selection restored for ${projectLabel}`, 'success');
        return;
    }

    const latestArtworkInfo = getCachedProjectArtworkInfo(project.path, { allowStale: true }) || artworkInfo;
    const pickedCandidate = latestArtworkInfo.candidates.find(
        (candidate) => candidate.relativePath.toLowerCase() === normalizedSelectedValue.toLowerCase()
    );
    const artworkName = pickedCandidate?.fileName || normalizedSelectedValue;
    showNotification(`Artwork set to ${artworkName}`, 'success');
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
        <div class="context-menu-item is-disabled is-loading" data-action="change-artwork" data-disabled="true">
            <i class="fas fa-image"></i>
            <span>Scanning Project Artwork...</span>
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

    void hydrateProjectArtworkContextMenuItem(menu, project);

    // Handle menu item clicks
    menu.querySelectorAll('.context-menu-item').forEach(item => {
        item.addEventListener('click', async () => {
            if (item.dataset.disabled === 'true' || item.classList.contains('is-disabled')) {
                return;
            }
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
        case 'change-artwork':
            await changeProjectArtworkFromContext(project);
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
            await showDeleteProjectModal(project);
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

    const separator = fullPath.includes(WINDOWS_PATH_SEPARATOR) ? WINDOWS_PATH_SEPARATOR : '/';
    const parts = fullPath.split(/[\\/]/);
    if (parts.length <= 2) return fullPath;

    return '...' + separator + parts.slice(-2).join(separator);
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

function buildAllProjectsSignature(projects = []) {
    return projects
        .map((project) => {
            const normalizedPath = normalizeRecentProjectPath(project.path || '') || '';
            const modifiedTimestamp = project.lastModified
                ? new Date(project.lastModified).getTime()
                : 0;
            const safeModified = Number.isFinite(modifiedTimestamp) ? modifiedTimestamp : 0;
            return `${normalizedPath}|${project.type || 'unknown'}|${safeModified}`;
        })
        .sort()
        .join('||');
}

function normalizeWorkspaceProjects(projects = []) {
    const seen = new Set();
    const normalized = [];

    for (const project of projects) {
        if (!project || typeof project.path !== 'string' || !project.path.trim()) {
            continue;
        }

        const projectPath = project.path.trim();
        const projectKey = normalizeRecentProjectPath(projectPath);
        if (!projectKey || seen.has(projectKey)) {
            continue;
        }

        seen.add(projectKey);
        normalized.push({
            ...project,
            name: project.name || basenamePath(projectPath),
            path: projectPath,
            type: project.type || 'unknown'
        });
    }

    return normalized;
}

function getActiveProjectTypeFilter() {
    return document.querySelector('.filter-tab.active')?.dataset.filter || 'all';
}

function projectMatchesTypeFilter(projectType, typeFilter) {
    if (!typeFilter || typeFilter === 'all') {
        return true;
    }

    const normalizedType = typeof projectType === 'string' ? projectType.toLowerCase() : '';
    if (typeFilter === 'node') {
        return normalizedType === 'node' || normalizedType === 'nodejs';
    }

    if (typeFilter === 'other') {
        const commonTypes = new Set(['web', 'node', 'nodejs', 'python', 'react']);
        return !commonTypes.has(normalizedType);
    }

    return normalizedType === typeFilter;
}

function ensureProjectsAlphabetButtons() {
    const gutter = document.getElementById('projects-alpha-gutter');
    if (!gutter || gutter.dataset.initialized === 'true') {
        return;
    }

    gutter.dataset.initialized = 'true';
    gutter.innerHTML = PROJECT_ALPHABET_KEYS.map((key) => (
        `<button class="projects-alpha-btn" type="button" data-alpha-key="${key}" aria-label="Jump to ${key === '#' ? 'symbols' : key}">${key}</button>`
    )).join('');

    let scrubActive = false;
    let lastScrubKey = '';

    const getKeyFromPointer = (clientX, clientY) => {
        const elementAtPoint = document.elementFromPoint(clientX, clientY);
        const button = elementAtPoint?.closest?.('.projects-alpha-btn');
        return button?.dataset?.alphaKey || '';
    };

    const applyScrubJump = (targetKey) => {
        const normalizedKey = String(targetKey || '').trim().toUpperCase();
        if (!normalizedKey || normalizedKey === lastScrubKey) {
            return;
        }
        lastScrubKey = normalizedKey;
        jumpToProjectsAlphabet(normalizedKey, { smooth: false, preferNearest: true });
    };

    gutter.addEventListener('click', (event) => {
        const button = event.target.closest('.projects-alpha-btn');
        if (!button) {
            return;
        }
        const targetKey = button.dataset.alphaKey || '';
        jumpToProjectsAlphabet(targetKey, { smooth: true, preferNearest: true });
    });

    gutter.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) {
            return;
        }

        const button = event.target.closest('.projects-alpha-btn');
        if (!button) {
            return;
        }

        event.preventDefault();
        scrubActive = true;
        lastScrubKey = '';
        gutter.setPointerCapture?.(event.pointerId);
        applyScrubJump(button.dataset.alphaKey || '');
    });

    gutter.addEventListener('pointermove', (event) => {
        if (!scrubActive) {
            return;
        }
        applyScrubJump(getKeyFromPointer(event.clientX, event.clientY));
    });

    const stopScrub = (event) => {
        if (!scrubActive) {
            return;
        }

        scrubActive = false;
        lastScrubKey = '';
        if (typeof event?.pointerId === 'number' && gutter.hasPointerCapture?.(event.pointerId)) {
            gutter.releasePointerCapture(event.pointerId);
        }
        scheduleProjectsAlphabetRefresh();
    };

    gutter.addEventListener('pointerup', stopScrub);
    gutter.addEventListener('pointercancel', stopScrub);
    gutter.addEventListener('lostpointercapture', () => {
        scrubActive = false;
        lastScrubKey = '';
    });
}

function getVisibleProjectCards() {
    return Array.from(document.querySelectorAll('#all-projects-list .project-card-modern'))
        .filter((card) => card.style.display !== 'none');
}

function getCurrentProjectsAlphabetKey(visibleCards = []) {
    const projectsList = document.getElementById('all-projects-list');
    const projectsView = document.getElementById('projects-view');
    if (!projectsList || visibleCards.length === 0) {
        return '#';
    }

    const viewRect = projectsView?.getBoundingClientRect();
    const topAnchor = (viewRect ? viewRect.top : 0) + 12;
    const epsilon = 3;

    const measuredCards = visibleCards.map((card) => ({
        card,
        rect: card.getBoundingClientRect(),
        key: card.dataset.alphaKey || deriveProjectAlphaKey(card.querySelector('.project-name')?.textContent || '')
    }));

    // Primary strategy: find the row crossing the anchor line and pick the left-most card in that row.
    let candidateRow = measuredCards.filter((entry) => (
        entry.rect.top <= topAnchor + epsilon &&
        entry.rect.bottom >= topAnchor - epsilon
    ));

    // Fallback 1: nearest row above anchor.
    if (candidateRow.length === 0) {
        let nearestAboveTop = Number.NEGATIVE_INFINITY;
        for (const entry of measuredCards) {
            if (entry.rect.top <= topAnchor + epsilon && entry.rect.top > nearestAboveTop) {
                nearestAboveTop = entry.rect.top;
            }
        }

        if (nearestAboveTop > Number.NEGATIVE_INFINITY) {
            candidateRow = measuredCards.filter((entry) => Math.abs(entry.rect.top - nearestAboveTop) <= epsilon);
        }
    }

    // Fallback 2: nearest row below anchor.
    if (candidateRow.length === 0) {
        let nearestBelowTop = Number.POSITIVE_INFINITY;
        for (const entry of measuredCards) {
            if (entry.rect.top > topAnchor - epsilon && entry.rect.top < nearestBelowTop) {
                nearestBelowTop = entry.rect.top;
            }
        }

        if (nearestBelowTop < Number.POSITIVE_INFINITY) {
            candidateRow = measuredCards.filter((entry) => Math.abs(entry.rect.top - nearestBelowTop) <= epsilon);
        }
    }

    if (candidateRow.length === 0) {
        return measuredCards[0]?.key || '#';
    }

    candidateRow.sort((a, b) => (
        (a.rect.left - b.rect.left) ||
        (a.rect.top - b.rect.top)
    ));

    return candidateRow[0]?.key || '#';
}

function refreshProjectsAlphabetGutter() {
    ensureProjectsAlphabetButtons();

    const gutter = document.getElementById('projects-alpha-gutter');
    if (!gutter) {
        return;
    }

    const visibleCards = getVisibleProjectCards();
    const alphaMap = new Map();
    visibleCards.forEach((card) => {
        const alphaKey = card.dataset.alphaKey || deriveProjectAlphaKey(card.querySelector('.project-name')?.textContent || '');
        if (!alphaMap.has(alphaKey)) {
            alphaMap.set(alphaKey, card);
        }
    });

    const activeKey = getCurrentProjectsAlphabetKey(visibleCards);
    gutter.classList.toggle('is-hidden', visibleCards.length === 0);

    gutter.querySelectorAll('.projects-alpha-btn').forEach((button) => {
        const key = button.dataset.alphaKey || '';
        const hasProjectsForKey = alphaMap.has(key);
        button.classList.toggle('is-unavailable', !hasProjectsForKey);
        button.classList.toggle('is-active', key === activeKey);
        button.setAttribute('aria-disabled', hasProjectsForKey ? 'false' : 'true');
    });
}

function scheduleProjectsAlphabetRefresh() {
    return;
}

function jumpToProjectsAlphabet(targetKey = '', options = {}) {
    const normalizedTarget = String(targetKey || '').trim().toUpperCase();
    if (!normalizedTarget) {
        return;
    }

    const smooth = options?.smooth !== false;
    const preferNearest = options?.preferNearest !== false;

    const visibleCards = getVisibleProjectCards();
    if (visibleCards.length === 0) {
        return;
    }

    const firstCardByKey = new Map();
    for (const card of visibleCards) {
        const key = card.dataset.alphaKey || deriveProjectAlphaKey(card.querySelector('.project-name')?.textContent || '');
        if (!firstCardByKey.has(key)) {
            firstCardByKey.set(key, card);
        }
    }

    let targetCard = firstCardByKey.get(normalizedTarget) || null;
    if (!targetCard && preferNearest) {
        const requestedIndex = PROJECT_ALPHABET_KEYS.indexOf(normalizedTarget);
        if (requestedIndex !== -1) {
            let nearestKey = '';
            let nearestDistance = Number.POSITIVE_INFINITY;

            firstCardByKey.forEach((_card, key) => {
                const keyIndex = PROJECT_ALPHABET_KEYS.indexOf(key);
                if (keyIndex === -1) {
                    return;
                }

                const distance = Math.abs(keyIndex - requestedIndex);
                if (distance < nearestDistance) {
                    nearestDistance = distance;
                    nearestKey = key;
                    return;
                }

                if (distance === nearestDistance && nearestKey) {
                    const currentNearestIndex = PROJECT_ALPHABET_KEYS.indexOf(nearestKey);
                    // Tie-break: favor lower key index for deterministic behavior.
                    if (keyIndex < currentNearestIndex) {
                        nearestKey = key;
                    }
                }
            });

            if (nearestKey) {
                targetCard = firstCardByKey.get(nearestKey) || null;
            }
        }
    }

    if (!targetCard) {
        return;
    }

    targetCard.scrollIntoView({
        behavior: smooth ? 'smooth' : 'auto',
        block: 'start'
    });

    if (smooth) {
        setTimeout(() => {
            refreshProjectsAlphabetGutter();
        }, 180);
    } else {
        scheduleProjectsAlphabetRefresh();
    }
}

function initializeProjectsAlphabetGutter() {
    return;
}

function applyProjectsVisibility() {
    const query = (document.getElementById('project-search')?.value || '').trim().toLowerCase();
    const activeTypeFilter = getActiveProjectTypeFilter();
    const projectCards = document.querySelectorAll('#all-projects-list .project-card-modern');

    projectCards.forEach((card) => {
        const cardSearchText = card.dataset.searchText || '';
        const cardType = (card.dataset.type || '').toLowerCase();

        const matchesQuery = !query || cardSearchText.includes(query);
        const matchesType = projectMatchesTypeFilter(cardType, activeTypeFilter);
        card.style.display = matchesQuery && matchesType ? '' : 'none';
    });

    scheduleProjectsAlphabetRefresh();
}

async function renderProjectCardsInBatches(container, projects = []) {
    let fragment = document.createDocumentFragment();
    for (let index = 0; index < projects.length; index += 1) {
        const card = createProjectCard(projects[index], index);
        fragment.appendChild(card);

        if ((index + 1) % PROJECT_RENDER_CHUNK_SIZE === 0) {
            container.appendChild(fragment);
            fragment = document.createDocumentFragment();
            await new Promise((resolve) => {
                if (typeof requestAnimationFrame === 'function') {
                    requestAnimationFrame(() => resolve());
                    return;
                }
                setTimeout(resolve, 0);
            });
        }
    }

    if (fragment.childNodes.length > 0) {
        container.appendChild(fragment);
    }
}

// Load all projects
async function loadAllProjects(options = {}) {
    if (allProjectsRefreshInFlight) {
        allProjectsRefreshQueued = true;
        return;
    }

    allProjectsRefreshInFlight = true;
    const requestToken = ++allProjectsRequestToken;
    const requestedWorkspacePath = workspacePath || '';
    const projectsList = document.getElementById('all-projects-list');
    if (!projectsList) {
        allProjectsRefreshInFlight = false;
        return;
    }

    const force = options.force !== false;
    const showLoading = options.showLoading !== false;
    if (force) {
        pathExistsCache.clear();
        gitRepositoryCache.clear();
        projectArtworkCache.clear();
    }

    try {
        const useListView = projectsList.classList.contains('list-view');
        const hasRenderedProjects = projectsList.querySelector('.project-card-modern') !== null;
        const shouldShowLoading = showLoading && (!hasRenderedProjects || force);

        if (shouldShowLoading) {
            projectsList.setAttribute('aria-busy', 'true');
            projectsList.innerHTML = '<div class="loading"><span class="spinner"></span><span class="loading-text">Loading projects...</span></div>';
        }

        const projectsResponse = await ipcRenderer.invoke('search-projects', requestedWorkspacePath, '');
        if (requestToken !== allProjectsRequestToken || requestedWorkspacePath !== (workspacePath || '')) {
            return;
        }

        const projects = normalizeWorkspaceProjects(Array.isArray(projectsResponse) ? projectsResponse : []);
        workspaceProjectsSnapshot = projects;
        const nextSignature = buildAllProjectsSignature(projects);
        const hasChanged = nextSignature !== allProjectsSnapshotSignature;

        if (!force && !hasChanged) {
            await reconcileRecentProjectsWithDisk();
            return;
        }

        allProjectsSnapshotSignature = nextSignature;
        markGitProjectsDropdownCacheStale();
        markIndexedSearchStale(requestedWorkspacePath);

        projectsList.removeAttribute('aria-busy');
        if (projects.length === 0) {
            projectsList.innerHTML = `
                <div style="text-align: center; padding: 40px; color: var(--text-secondary);">
                    <i class="fas fa-folder-open" style="font-size: 48px; margin-bottom: 10px;"></i>
                    <p>No projects found in workspace</p>
                    <p style="font-size: 12px; margin-top: 10px;">Create a new project or change workspace location</p>
                </div>
            `;
            scheduleProjectsAlphabetRefresh();
        } else {
            projectsList.innerHTML = '';
            projectsList.className = useListView ? 'projects-list list-view' : 'projects-list grid-view';
            await renderProjectCardsInBatches(projectsList, projects);

            const selectedSort = document.getElementById('project-sort')?.value || 'name';
            sortProjects(selectedSort, { silent: true });
            applyProjectsVisibility();
        }

        const currentProjectKey = normalizeRecentProjectPath(currentProject?.path || '');
        if (currentProjectKey) {
            const selectionExists = projects.some((project) => normalizeRecentProjectPath(project.path || '') === currentProjectKey);
            if (!selectionExists) {
                currentProject = null;
                updateStatusBarProject('No project selected');
                setSelectedProjectCardByPath('');
            }
        }

        await reconcileRecentProjectsWithDisk();
        await updateProjectStats(projects);
        setSelectedProjectCardByPath(currentProject?.path || '');
    } catch (error) {
        console.error('Failed to load projects:', error);
        if (showLoading) {
            projectsList.innerHTML = `
                <div style="text-align: center; padding: 40px; color: var(--danger);">
                    <i class="fas fa-triangle-exclamation" style="font-size: 32px; margin-bottom: 10px;"></i>
                    <p>Unable to refresh projects right now.</p>
                </div>
            `;
        }
    } finally {
        allProjectsRefreshInFlight = false;
        if (allProjectsRefreshQueued) {
            allProjectsRefreshQueued = false;
            void loadAllProjects({ force: false, showLoading: false });
        }
    }
}

// Search projects
async function searchProjects(query) {
    const resultsContainer = document.getElementById('search-results');
    if (!resultsContainer) {
        return;
    }

    const requestId = ++searchQueryRequestId;
    const normalizedQuery = typeof query === 'string' ? query.trim() : '';
    if (normalizedQuery.length < 2) {
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

    if (requestId !== searchQueryRequestId) {
        return;
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
                title.textContent = item.label || basenamePath(item.projectPath || '') || 'Project';
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

    const searchWorkspace = workspacePath || '';
    const normalizedWorkspaceKey = normalizeRecentProjectPath(searchWorkspace) || searchWorkspace.toLowerCase();
    const cacheKey = `${normalizedWorkspaceKey}|${normalizedQuery.toLowerCase()}`;
    let projects = [];
    try {
        projects = await projectSearchResultsCache.get(cacheKey, async () => {
            const value = await ipcRenderer.invoke('search-projects', searchWorkspace, normalizedQuery);
            return Array.isArray(value) ? value : [];
        });
    } catch {
        projects = [];
    }

    if (requestId !== searchQueryRequestId) {
        return;
    }
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
let _gitBusyNoticeAt = 0;
async function withGitLock(fn) {
    if (_gitOpLock) {
        const now = Date.now();
        if ((now - _gitBusyNoticeAt) > 1200) {
            _gitBusyNoticeAt = now;
            showNotification('A Git operation is already running. Please wait.', 'info');
        }
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
let _gitRefreshQueued = false;
let _gitRefreshRequestToken = 0;

function finishGitStatusRefresh() {
    _isRefreshing = false;
    if (_gitRefreshQueued) {
        _gitRefreshQueued = false;
        void refreshGitStatusNow();
    }
}

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
        void refreshGitStatusNow();
    }, 150);
}

async function refreshGitStatusNow() {
    // Prevent concurrent refresh calls
    if (_isRefreshing) {
        _gitRefreshQueued = true;
        return;
    }

    _isRefreshing = true;
    gitStatusNeedsRefresh = false;
    const refreshRequestToken = ++_gitRefreshRequestToken;
    const refreshProjectPath = currentProject?.path || '';
    const isStaleRefresh = () => refreshRequestToken !== _gitRefreshRequestToken
        || refreshProjectPath !== (currentProject?.path || '');

    const statusContainer = document.getElementById('git-status');

    if (!statusContainer) {
        console.error('[GIT] git-status element not found in DOM');
        finishGitStatusRefresh();
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
        finishGitStatusRefresh();
        return;
    }

    let result;
    try {
        result = await ipcRenderer.invoke('git-status', refreshProjectPath);
    } catch (error) {
        console.error('[GIT] Failed to fetch git status:', error);
        finishGitStatusRefresh();
        return;
    }

    if (isStaleRefresh()) {
        finishGitStatusRefresh();
        return;
    }

    if (!result.success) {
        statusContainer.innerHTML = `
            <div class="git-not-initialized">
                <i class="fab fa-git-alt" style="font-size: 48px; color: var(--warning); opacity: 0.5;"></i>
                <p style="color: var(--text-primary); margin: 16px 0 8px 0; font-weight: 500;">Not a git repository</p>
                <p style="color: var(--text-secondary); font-size: 13px; margin-bottom: 16px;">Initialize git to start version control</p>
                <button class="btn-primary" id="git-inline-initialize-btn">
                    <i class="fas fa-play"></i> Initialize Git
                </button>
            </div>
        `;
        document.getElementById('git-inline-initialize-btn')?.addEventListener('click', () => {
            void initializeGit();
        }, { once: true });
        finishGitStatusRefresh();
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
        finishGitStatusRefresh();
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
        if (isStaleRefresh()) {
            return;
        }

        statusContainer.innerHTML = html;

        // Update modified files count
        const modifiedEl = document.getElementById('git-modified');
        if (modifiedEl) {
            modifiedEl.textContent = files.length;
        }
    });

    // Load branches asynchronously
    void loadBranches();
    finishGitStatusRefresh();
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
                const indexFileUrl = buildFileUrl(joinPath(currentProject.path, 'index.html'));
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

async function requestProjectDeleteDecision(project, options = {}) {
    if (!project || !project.path) {
        return 'cancel';
    }

    const normalizedSettings = normalizeSettings(appSettings);
    const allowRemove = options.allowRemove !== false;
    const displayName = project.name || basenamePath(project.path) || 'this project';

    if (!normalizedSettings.confirmDelete) {
        return 'delete';
    }

    const actions = [
        { label: 'Delete Files', value: 'delete', variant: 'danger', icon: 'fa-trash' }
    ];

    if (allowRemove) {
        actions.push({ label: 'Remove from Recent', value: 'remove', variant: 'primary', icon: 'fa-unlink' });
    }

    actions.push({ label: 'Cancel', value: 'cancel', variant: 'secondary', icon: 'fa-times' });

    const firstChoice = await showSettingsSmartDialog({
        mode: 'warning',
        title: 'Delete Project',
        subtitle: `Choose what to do with "${displayName}".`,
        detail: allowRemove
            ? 'Delete Files permanently removes the project folder from disk. Remove from Recent keeps files and removes this entry from your recent list.'
            : 'This action permanently removes the project folder from disk.',
        iconHtml: '<i class="fas fa-trash-alt"></i>',
        actions
    });

    if (firstChoice !== 'delete') {
        return firstChoice;
    }

    const confirmedDelete = await showSettingsSmartDialog({
        mode: 'warning',
        title: 'Confirm Permanent Delete',
        subtitle: `Delete "${displayName}" from disk?`,
        detail: 'This cannot be undone. All files in the project folder will be removed.',
        iconHtml: '<i class="fas fa-exclamation-triangle"></i>',
        actions: [
            { label: 'Delete Permanently', value: 'delete', variant: 'danger', icon: 'fa-trash' },
            { label: 'Cancel', value: 'cancel', variant: 'secondary', icon: 'fa-times' }
        ]
    });

    return confirmedDelete === 'delete' ? 'delete' : 'cancel';
}

async function showDeleteConfirmation(project) {
    const decision = await requestProjectDeleteDecision(project, { allowRemove: false });
    if (decision === 'delete') {
        await deleteProjectPermanently(project);
    }
}

async function deleteProjectFiles(project) {
    await deleteProjectPermanently(project);
}

// Utility functions
// ==========================================
// GitHub Upload Progress UI
// ==========================================

const GH_STEPS = ['create-repo', 'init-git', 'add-remote', 'stage-files', 'commit', 'push'];
const GH_STEP_WEIGHTS = { 'create-repo': 20, 'init-git': 10, 'add-remote': 10, 'stage-files': 15, 'commit': 15, 'push': 30 };

function getGitHubUploadProgressMode() {
    const overlay = document.getElementById('gh-upload-progress');
    const modeFromOverlay = overlay?.dataset?.uploadMode;
    if (modeFromOverlay === 'existing' || modeFromOverlay === 'new') {
        return modeFromOverlay;
    }

    if (typeof getGitHubUploadMode === 'function') {
        return getGitHubUploadMode();
    }
    return 'new';
}

function updateGitHubUploadProgressStepLabels(mode = 'new') {
    const createStepLabel = document.querySelector('.gh-step[data-step="create-repo"] .gh-step-label');
    if (createStepLabel) {
        createStepLabel.textContent = mode === 'existing' ? 'Verify repository' : 'Create repository';
    }
}

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
    const uploadMode = getGitHubUploadProgressMode();
    overlay.dataset.uploadMode = uploadMode;
    updateGitHubUploadProgressStepLabels(uploadMode);

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
    document.getElementById('gh-progress-title').textContent = uploadMode === 'existing'
        ? 'Updating GitHub Repository'
        : 'Uploading to GitHub';
    document.getElementById('gh-progress-subtitle').textContent = uploadMode === 'existing'
        ? 'Preparing selected changes...'
        : 'Preparing your project...';
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
    const uploadMode = getGitHubUploadProgressMode();

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
            ? (uploadMode === 'existing'
                ? `Repository "${repo?.full_name || repo?.name || 'target repository'}" updated successfully.`
                : `Repository "${repo?.name || 'new repository'}" created and uploaded successfully.`)
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

    const mode = typeof getGitHubUploadMode === 'function' ? getGitHubUploadMode() : 'new';
    if (mode === 'existing') {
        document.getElementById('github-existing-repo-target')?.focus();
    } else {
        document.getElementById('github-repo-name')?.focus();
    }
    updateGitHubUploadSubmitState();
});

// Update status message
function updateStatusMessage(message, options = {}) {
    if (typeof setStatusTransientMessage === 'function') {
        setStatusTransientMessage(message, options);
        return;
    }

    const statusMessageEl = document.getElementById('status-message');
    if (!statusMessageEl) {
        return;
    }

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
    const hint = document.getElementById('project-name-hint');
    const input = e.target;

    updateProjectLocationPreview();

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
