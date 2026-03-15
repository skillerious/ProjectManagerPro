/* Runtime module: shared/10-ui-shell-modal-toast.js */
function toggleSidebar() {
    const sidebar = document.querySelector('.sidebar');
    const contentArea = document.querySelector('.content-area');
    if (!sidebar || !contentArea) {
        return;
    }
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
    if (!statusBar) {
        return;
    }
    
    if (statusBar.style.display === 'none') {
        statusBar.style.display = 'flex';
        if (typeof scheduleStatusBarRefresh === 'function') {
            scheduleStatusBarRefresh({ immediate: true });
        }
        if (typeof updateStatusClockDisplay === 'function') {
            updateStatusClockDisplay();
        }
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
    if (currentProject?.name) {
        showNotification(`Settings for ${currentProject.name}`, 'success');
        return;
    }
    showNotification('Opened application settings', 'info');
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
            if (locationInput) {
                delete locationInput.dataset.customPath;
                updateProjectLocationPreview({
                    basePath: workspacePath || normalizedSettings.defaultProjectPath || ''
                });
            }
            if (hint) hint.textContent = '';
            if (initGitInput) initGitInput.checked = normalizedSettings.gitAutoInit;
            if (openInVsCodeInput) openInVsCodeInput.checked = normalizedSettings.openInVSCode;
            resetTemplateDropdown();
        }

        if (modalId === 'clone-modal') {
            const normalizedSettings = normalizeSettings(appSettings);
            const cloneLocationInput = document.getElementById('clone-location');
            const openAfterCloneInput = document.getElementById('open-after-clone');
            if (cloneLocationInput && !cloneLocationInput.value.trim()) {
                cloneLocationInput.value = workspacePath || normalizedSettings.defaultProjectPath || '';
            }
            if (openAfterCloneInput) {
                openAfterCloneInput.checked = normalizedSettings.openInVSCode;
            }
        }

        // Focus first input or the command palette input
        setTimeout(() => {
            const input = modal.querySelector('input[type="text"]:not([readonly]), textarea') ||
                          modal.querySelector('#command-palette-input');
            if (input) {
                input.focus();
                if (modalId === 'command-palette-modal') {
                    input.value = '';
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                } else if (modalId === 'search-modal') {
                    input.value = '';
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

    if (modalId === 'github-account-modal') {
        hideGitHubAvatarPreview(true);
    }
    return true;
}

// Notifications
let notificationTimeout = null;
let notificationSequence = 0;
let lastNotificationSignature = '';
let lastNotificationAt = 0;

function showNotification(message, type = 'success') {
    const toast = document.getElementById('toast');
    const toastMessage = document.getElementById('toast-message');
    if (!toast || !toastMessage) {
        return;
    }
    const toastIcon = toast.querySelector('i');
    if (!toastIcon) {
        return;
    }

    const statusBar = document.querySelector('.status-bar');
    const statusBarVisible = Boolean(
        statusBar &&
        getComputedStyle(statusBar).display !== 'none' &&
        getComputedStyle(statusBar).visibility !== 'hidden'
    );
    const nextSignature = `${type}:${String(message ?? '')}`;
    const now = Date.now();
    if (nextSignature === lastNotificationSignature && (now - lastNotificationAt) < 4000) {
        return;
    }
    lastNotificationSignature = nextSignature;
    lastNotificationAt = now;
    const sequenceId = ++notificationSequence;

    // Keep toast clear of the status bar and ensure right-side anchoring.
    toast.style.left = 'auto';
    toast.style.right = '14px';
    toast.style.bottom = statusBarVisible ? 'calc(var(--statusbar-height) + 12px)' : '12px';

    // Clear any existing timeout to prevent premature hiding
    if (notificationTimeout) {
        clearTimeout(notificationTimeout);
        notificationTimeout = null;
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

    // Restart toast animation reliably even for repeated messages.
    toast.classList.remove('show');
    void toast.offsetWidth;
    toast.classList.add('show');

    // Errors stay longer so the user can read them
    const duration = type === 'error' ? 5000 : 3000;
    notificationTimeout = setTimeout(() => {
        if (sequenceId !== notificationSequence) {
            return;
        }
        toast.classList.remove('show');
        notificationTimeout = null;
    }, duration);
}
