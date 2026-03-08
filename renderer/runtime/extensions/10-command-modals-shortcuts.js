/* Runtime module: extensions/10-command-modals-shortcuts.js */
function initializeCommandPalette() {
    const input = document.getElementById('command-palette-input');
    const commandList = document.getElementById('command-list');
    const resultCount = document.getElementById('command-palette-result-count');
    const emptyState = document.getElementById('command-palette-empty');

    if (!input || !commandList) {
        return;
    }

    let activeIndex = -1;

    const getAllItems = () => Array.from(commandList.querySelectorAll('.command-item'));
    const getVisibleItems = () => getAllItems().filter((item) => item.style.display !== 'none');

    const updateResultMeta = (count, query) => {
        if (resultCount) {
            if (count === 0) {
                resultCount.textContent = query ? 'No matches' : 'No commands';
            } else {
                resultCount.textContent = `${count} command${count === 1 ? '' : 's'}`;
            }
        }

        if (emptyState) {
            emptyState.hidden = count !== 0;
        }
    };

    const setActiveCommand = (nextIndex, options = {}) => {
        const { scrollIntoView = true } = options;
        const visibleItems = getVisibleItems();

        visibleItems.forEach((item) => {
            item.classList.remove('active');
        });

        if (visibleItems.length === 0) {
            activeIndex = -1;
            return;
        }

        if (nextIndex < 0) {
            nextIndex = visibleItems.length - 1;
        } else if (nextIndex >= visibleItems.length) {
            nextIndex = 0;
        }

        activeIndex = nextIndex;
        const activeItem = visibleItems[activeIndex];
        activeItem.classList.add('active');

        if (scrollIntoView) {
            activeItem.scrollIntoView({ block: 'nearest' });
        }
    };

    const filterCommands = (queryRaw = '') => {
        const query = String(queryRaw).trim().toLowerCase();
        const items = getAllItems();

        items.forEach((item) => {
            const searchableText = `${item.dataset.search || ''} ${item.textContent || ''}`.toLowerCase();
            const matches = query.length === 0 || searchableText.includes(query);
            item.style.display = matches ? 'flex' : 'none';
            if (!matches) {
                item.classList.remove('active');
            }
        });

        const visibleItems = getVisibleItems();
        setActiveCommand(visibleItems.length > 0 ? 0 : -1, { scrollIntoView: false });
        updateResultMeta(visibleItems.length, query);
    };

    const runActiveCommand = () => {
        const visibleItems = getVisibleItems();
        if (visibleItems.length === 0) {
            return;
        }

        const selectedItem = visibleItems[activeIndex] || visibleItems[0];
        const command = selectedItem?.dataset.command;
        if (!command) {
            return;
        }

        executeCommand(command);
        hideModal('command-palette-modal');
    };

    input.addEventListener('input', (event) => {
        filterCommands(event.target.value);
    });

    input.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActiveCommand(activeIndex + 1);
            return;
        }

        if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveCommand(activeIndex - 1);
            return;
        }

        if (event.key === 'Enter') {
            event.preventDefault();
            runActiveCommand();
            return;
        }

        if (event.key === 'Escape') {
            event.preventDefault();
            hideModal('command-palette-modal');
        }
    });

    getAllItems().forEach((item) => {
        item.addEventListener('click', () => {
            const command = item.dataset.command;
            if (!command) {
                return;
            }

            executeCommand(command);
            hideModal('command-palette-modal');
        });

        item.addEventListener('mouseenter', () => {
            const visibleItems = getVisibleItems();
            const hoveredIndex = visibleItems.indexOf(item);
            if (hoveredIndex !== -1) {
                setActiveCommand(hoveredIndex, { scrollIntoView: false });
            }
        });
    });

    filterCommands('');
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
        case 'clone-repository':
            document.getElementById('clone-repository-menu').click();
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
            updateProjectLocationPreview({ basePath: selectedPath, markCustom: true });
        }
    });

    // Custom template dropdown
    initializeTemplateDropdown();
    
    // Search modal
    document.getElementById('search-input')?.addEventListener('input', async (e) => {
        const query = typeof e.target.value === 'string' ? e.target.value : '';
        if (searchModalDebounceTimer) {
            clearTimeout(searchModalDebounceTimer);
        }

        searchModalDebounceTimer = setTimeout(() => {
            void searchProjects(query);
        }, SEARCH_INPUT_DEBOUNCE_MS);
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

    document.getElementById('dashboard-view-all-projects-btn')?.addEventListener('click', () => {
        switchView('projects');
    });

    document.getElementById('dashboard-create-first-project-btn')?.addEventListener('click', () => {
        document.getElementById('new-project-btn')?.click();
    });
    
    document.getElementById('change-workspace')?.addEventListener('click', async () => {
        const selectedPath = await ipcRenderer.invoke('select-folder');
        if (selectedPath) {
            workspacePath = selectedPath;
            markIndexedSearchStale(workspacePath);
            markGitProjectsDropdownCacheStale();
            document.getElementById('workspace-path').textContent = selectedPath;
            const locationInput = document.getElementById('project-location');
            if (locationInput && locationInput.dataset.customPath !== 'true') {
                updateProjectLocationPreview({ basePath: selectedPath });
            }
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
    let shortcutChordPrefix = '';
    let shortcutChordTimer = null;

    const clearShortcutChord = () => {
        shortcutChordPrefix = '';
        if (shortcutChordTimer) {
            clearTimeout(shortcutChordTimer);
            shortcutChordTimer = null;
        }
    };

    const armShortcutChord = (prefix) => {
        shortcutChordPrefix = prefix;
        if (shortcutChordTimer) {
            clearTimeout(shortcutChordTimer);
        }
        shortcutChordTimer = setTimeout(() => {
            clearShortcutChord();
        }, 1200);
    };

    const triggerMenuItem = (menuItemId) => {
        const menuItem = document.getElementById(menuItemId);
        if (!menuItem) {
            return false;
        }
        menuItem.click();
        return true;
    };

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
        const normalizedKey = typeof e.key === 'string' ? e.key.toLowerCase() : '';

        // Ctrl+K Ctrl+S - Keyboard shortcuts modal
        if (shortcutChordPrefix === 'ctrl+k') {
            const isModifierOnlyKey = normalizedKey === 'control' || normalizedKey === 'shift' || normalizedKey === 'alt' || normalizedKey === 'meta';
            if (!isModifierOnlyKey) {
                const isShortcutChordMatch = e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && normalizedKey === 's';
                clearShortcutChord();
                if (isShortcutChordMatch) {
                    e.preventDefault();
                    triggerMenuItem('keyboard-shortcuts-menu');
                    return;
                }
            }
        }

        if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && normalizedKey === 'k') {
            e.preventDefault();
            armShortcutChord('ctrl+k');
            return;
        }

        // Ctrl+N - New project
        if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && normalizedKey === 'n') {
            e.preventDefault();
            showModal('new-project-modal');
        }
        
        // Ctrl+O - Open project
        if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && normalizedKey === 'o') {
            e.preventDefault();
            document.getElementById('open-project-menu').click();
        }
        
        // Ctrl+F - Find projects
        if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && normalizedKey === 'f') {
            e.preventDefault();
            const settingsView = document.getElementById('settings-view');
            const documentationView = document.getElementById('documentation-view');
            const diagnosticsView = document.getElementById('diagnostics-view');
            if (settingsView && settingsView.classList.contains('active')) {
                document.getElementById('settings-search')?.focus();
            } else if (documentationView && documentationView.classList.contains('active')) {
                document.getElementById('docs-search')?.focus();
            } else if (diagnosticsView && diagnosticsView.classList.contains('active')) {
                document.getElementById('log-viewer-search-input')?.focus();
            } else {
                showModal('search-modal');
            }
        }
        
        // Ctrl+S - Save workspace or settings
        if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && normalizedKey === 's') {
            e.preventDefault();
            const settingsView = document.getElementById('settings-view');
            if (settingsView && settingsView.classList.contains('active')) {
                await saveSettings();
            } else {
                await saveWorkspace();
            }
        }
        
        // Ctrl+, - Settings
        if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && normalizedKey === ',') {
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

            if (normalizedKey === 'g') {
                e.preventDefault();
                document.getElementById('github-account-btn')?.click();
                document.getElementById('github-account-btn')?.focus();
            }
        }
        
        // Ctrl+B - Toggle sidebar
        if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && normalizedKey === 'b') {
            e.preventDefault();
            toggleSidebar();
        }

        // Ctrl+Shift+B - Build project
        if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && normalizedKey === 'b') {
            e.preventDefault();
            triggerMenuItem('build-project-menu');
        }
        
        // Ctrl+Shift+P - Command palette
        if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && normalizedKey === 'p') {
            e.preventDefault();
            showModal('command-palette-modal');
        }

        // Ctrl+Shift+E - Export project
        if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && normalizedKey === 'e') {
            e.preventDefault();
            triggerMenuItem('export-project-menu');
        }

        // Ctrl+Shift+G - Clone repository
        if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && normalizedKey === 'g') {
            e.preventDefault();
            triggerMenuItem('clone-repository-menu');
        }

        // Ctrl+Shift+Del - Delete project
        if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && normalizedKey === 'delete') {
            e.preventDefault();
            triggerMenuItem('delete-project-menu');
        }
        
        // Ctrl+` - Terminal
        if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && normalizedKey === '`') {
            e.preventDefault();
            document.getElementById('terminal-menu').click();
        }

        // Ctrl+Alt+S - Toggle status bar
        if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && normalizedKey === 's') {
            e.preventDefault();
            triggerMenuItem('toggle-statusbar-menu');
        }

        // Ctrl+Alt+T - Theme settings
        if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && normalizedKey === 't') {
            e.preventDefault();
            triggerMenuItem('theme-menu');
        }

        // Ctrl+Alt+D - Install dependencies
        if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && normalizedKey === 'd') {
            e.preventDefault();
            triggerMenuItem('install-deps-menu');
        }

        // Ctrl+Alt+U - Update dependencies
        if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && normalizedKey === 'u') {
            e.preventDefault();
            triggerMenuItem('update-deps-menu');
        }

        // Ctrl+Alt+, - Project settings
        if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && normalizedKey === ',') {
            e.preventDefault();
            triggerMenuItem('project-settings-menu');
        }

        // Ctrl+Alt+G - Initialize Git
        if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && normalizedKey === 'g') {
            e.preventDefault();
            triggerMenuItem('git-init-menu');
        }

        // Ctrl+Alt+C - Git commit
        if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && normalizedKey === 'c') {
            e.preventDefault();
            triggerMenuItem('git-commit-menu');
        }

        // Ctrl+Alt+P - Git push
        if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && normalizedKey === 'p') {
            e.preventDefault();
            triggerMenuItem('git-push-menu');
        }

        // Ctrl+Alt+N - NPM install
        if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && normalizedKey === 'n') {
            e.preventDefault();
            triggerMenuItem('npm-install-menu');
        }

        // Ctrl+Alt+I - PIP install
        if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && normalizedKey === 'i') {
            e.preventDefault();
            triggerMenuItem('pip-install-menu');
        }

        // Ctrl+Alt+X - Extensions
        if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && normalizedKey === 'x') {
            e.preventDefault();
            triggerMenuItem('extensions-menu');
        }

        // Ctrl+Alt+L - Check for updates
        if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && normalizedKey === 'l') {
            e.preventDefault();
            triggerMenuItem('check-updates-menu');
        }

        // Ctrl+Alt+H - Diagnostics log viewer
        if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && normalizedKey === 'h') {
            e.preventDefault();
            triggerMenuItem('log-viewer-menu');
        }

        // Ctrl+Alt+R - Report issue
        if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && normalizedKey === 'r') {
            e.preventDefault();
            triggerMenuItem('report-issue-menu');
        }

        // Ctrl+Alt+K - Register product
        if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && normalizedKey === 'k') {
            e.preventDefault();
            triggerMenuItem('register-product-menu');
        }

        // Ctrl+Alt+A - About
        if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && normalizedKey === 'a') {
            e.preventDefault();
            triggerMenuItem('about-menu');
        }
        
        // F5 - Run project
        if (e.key === 'F5') {
            e.preventDefault();
            await runProject();
        }

        // F9 - Debug project
        if (e.key === 'F9') {
            e.preventDefault();
            triggerMenuItem('debug-project-menu');
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
function updateProjectLocationPreview(options = {}) {
    const locationInput = document.getElementById('project-location');
    if (!locationInput) {
        return;
    }

    const { basePath, markCustom = false } = options;
    const fallbackBasePath = normalizeSettings(appSettings).defaultProjectPath || '';
    const resolvedBasePath = typeof basePath === 'string' && basePath.trim()
        ? basePath.trim()
        : locationInput.dataset.basePath || workspacePath || fallbackBasePath;
    const projectName = document.getElementById('project-name')?.value?.trim() || '';

    if (resolvedBasePath) {
        locationInput.dataset.basePath = resolvedBasePath;
    }
    if (markCustom) {
        locationInput.dataset.customPath = 'true';
    }

    locationInput.value = projectName && resolvedBasePath
        ? joinPath(resolvedBasePath, projectName)
        : resolvedBasePath;
}

async function createProject() {
    const name = document.getElementById('project-name').value.trim();
    const type = document.getElementById('project-type').value;
    const description = document.getElementById('project-description').value.trim();
    const locationInput = document.getElementById('project-location');
    const locationBasePath = locationInput?.dataset?.basePath?.trim() || '';
    const locationPreview = locationInput?.value?.trim() || '';
    const location = locationBasePath || locationPreview || workspacePath || normalizeSettings(appSettings).defaultProjectPath;
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
                pathMode: 'base',
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
                pathMode: 'base',
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
            if (locationInput) {
                delete locationInput.dataset.customPath;
            }
            updateProjectLocationPreview({ basePath: workspacePath || normalizeSettings(appSettings).defaultProjectPath || '' });

            // Reload recent projects
            await loadRecentProjects();

            // Set as current project
            currentProject = project;

            // Reload projects dropdown
            markGitProjectsDropdownCacheStale();
            await loadProjectsIntoDropdown({ force: true });
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
    const { normalized, errors, warnings } = await validateSettingsPayload(candidateSettings);

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
    allProjectsSnapshotSignature = '';
    markIndexedSearchStale(workspacePath);
    document.getElementById('workspace-path').textContent = workspacePath;
    const locationInput = document.getElementById('project-location');
    if (locationInput && locationInput.dataset.customPath !== 'true') {
        updateProjectLocationPreview({ basePath: workspacePath });
    }
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


