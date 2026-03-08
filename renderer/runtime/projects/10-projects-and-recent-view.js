/* Runtime module: projects/10-projects-and-recent-view.js */
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
    void query;
    applyProjectsVisibility();
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
    scheduleProjectsAlphabetRefresh();
    if (!options.silent) {
        showNotification(`Projects sorted by ${sortBy}`, 'info');
    }
}

function filterProjectsByType(type, options = {}) {
    void type;
    applyProjectsVisibility();

    if (!options.silent) {
        showNotification(`Filtered by: ${getActiveProjectTypeFilter()}`, 'info');
    }
}

function toggleProjectsView(viewType) {
    const projectsList = document.getElementById('all-projects-list');
    if (!projectsList) {
        return;
    }

    if (viewType === 'list') {
        projectsList.classList.remove('grid-view');
        projectsList.classList.add('list-view');
    } else {
        projectsList.classList.remove('list-view');
        projectsList.classList.add('grid-view');
    }

    scheduleProjectsAlphabetRefresh();
}

function buildProjectStatsSummary(projects = []) {
    const normalizedProjects = Array.isArray(projects) ? projects : [];
    const weekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);

    let activeProjects = 0;
    let gitProjects = 0;

    normalizedProjects.forEach((project) => {
        const modified = project?.lastModified
            ? new Date(project.lastModified).getTime()
            : 0;
        if (Number.isFinite(modified) && modified > weekAgo) {
            activeProjects += 1;
        }
        if (project?.isGitRepo === true || project?.hasGit === true) {
            gitProjects += 1;
        }
    });

    return {
        totalProjects: normalizedProjects.length,
        activeProjects,
        gitProjects
    };
}

async function updateProjectStats(projectsInput = null) {
    try {
        const sourceProjects = Array.isArray(projectsInput) ? projectsInput : workspaceProjectsSnapshot;
        const { totalProjects, activeProjects, gitProjects } = buildProjectStatsSummary(sourceProjects);

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
        await updateGitHubReposCount({ force: false });
    } catch (error) {
        console.error('Error updating project stats:', error);
    }
}

// Fetch GitHub repositories count using stored token
async function updateGitHubReposCount(options = {}) {
    try {
        const forceRefresh = options?.force === true;
        if (!forceRefresh && githubReposLastRefreshAt > 0) {
            const elapsed = Date.now() - githubReposLastRefreshAt;
            if (elapsed < GITHUB_REPOS_REFRESH_INTERVAL_MS) {
                return;
            }
        }

        const result = await ipcRenderer.invoke('github-get-user');
        if (result.success && result.user) {
            githubUserData = result.user;
            githubLastSyncedAt = new Date();
            githubReposLastRefreshAt = Date.now();
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
            githubReposLastRefreshAt = Date.now();
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

async function showDeleteProjectModal(project) {
    const decision = await requestProjectDeleteDecision(project, { allowRemove: true });
    if (decision === 'delete') {
        await deleteProjectPermanently(project);
    } else if (decision === 'remove') {
        await removeProjectFromApp(project);
    }
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

        await loadAllProjects({ force: true, showLoading: false });

        // Log activity
        logActivity('project', 'Project Removed from Recent', `Removed ${project.name} from recent projects`, {
            project: project.name
        });

        showNotification(`${project.name} removed from recent projects`, 'success');
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

            await loadAllProjects({ force: true, showLoading: false });

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


