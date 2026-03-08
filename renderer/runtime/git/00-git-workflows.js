/* Runtime module: git/00-git-workflows.js */
let gitSmartCommitSnapshot = null;
let gitSmartCommitRefreshToken = 0;

function gitSmartEscape(value) {
    if (typeof escapeHtml === 'function') {
        return escapeHtml(value);
    }
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function parseGitStatusPorcelain(output) {
    const lines = String(output || '')
        .split(/\r?\n/)
        .filter(line => line.trim());
    const staged = [];
    const unstaged = [];
    const untracked = [];

    const addItem = (target, path, status, code) => {
        target.push({ path, status, code });
    };

    lines.forEach((line) => {
        const rawCode = line.slice(0, 2);
        const path = line.slice(3).trim();
        if (!path) {
            return;
        }

        if (rawCode === '??') {
            addItem(untracked, path, 'Untracked', rawCode);
            return;
        }

        const stagedCode = rawCode[0];
        const unstagedCode = rawCode[1];
        const mapStatus = (code) => {
            if (code === 'A') return 'Added';
            if (code === 'M') return 'Modified';
            if (code === 'D') return 'Deleted';
            if (code === 'R') return 'Renamed';
            if (code === 'C') return 'Copied';
            if (code === 'U') return 'Conflicted';
            return 'Changed';
        };

        if (stagedCode && stagedCode !== ' ') {
            addItem(staged, path, mapStatus(stagedCode), rawCode);
        }
        if (unstagedCode && unstagedCode !== ' ') {
            addItem(unstaged, path, mapStatus(unstagedCode), rawCode);
        }
    });

    return {
        staged,
        unstaged,
        untracked,
        hasChanges: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
    };
}

function parseCurrentBranchName(output) {
    const lines = String(output || '').split(/\r?\n/);
    const current = lines.find(line => line.trim().startsWith('* '));
    if (!current) {
        return '--';
    }
    return current.replace('*', '').trim().replace(/^remotes\//, '') || '--';
}

function getCommitMessageQuality(message) {
    const normalized = String(message || '').trim();
    if (!normalized) {
        return { level: 'error', text: 'Commit message is required.' };
    }
    if (normalized.length < 8) {
        return { level: 'warning', text: 'Message is short. Aim for at least 8 characters.' };
    }
    if (normalized.length > 72) {
        return { level: 'warning', text: `Summary is ${normalized.length} chars. Prefer 72 or fewer.` };
    }
    return { level: 'valid', text: 'Message looks good.' };
}

function getGitCommitModalElements() {
    return {
        modal: document.getElementById('git-commit-modal'),
        messageInput: document.getElementById('commit-message'),
        messageHint: document.getElementById('git-commit-message-hint'),
        warningEl: document.getElementById('git-commit-warning'),
        stageAllInput: document.getElementById('git-commit-stage-all'),
        autoPushInput: document.getElementById('git-commit-auto-push'),
        stagedCountEl: document.getElementById('git-commit-staged-count'),
        unstagedCountEl: document.getElementById('git-commit-unstaged-count'),
        untrackedCountEl: document.getElementById('git-commit-untracked-count'),
        branchNameEl: document.getElementById('git-commit-branch-name'),
        changedFilesEl: document.getElementById('changed-files-list'),
        confirmBtn: document.getElementById('confirm-commit-btn')
    };
}

function renderCommitModalFiles(snapshot) {
    const { changedFilesEl } = getGitCommitModalElements();
    if (!changedFilesEl) {
        return;
    }

    const rows = [
        ...snapshot.staged.map(item => ({ ...item, group: 'Staged' })),
        ...snapshot.unstaged.map(item => ({ ...item, group: 'Unstaged' })),
        ...snapshot.untracked.map(item => ({ ...item, group: 'Untracked' }))
    ];

    if (rows.length === 0) {
        changedFilesEl.innerHTML = '<div class="changed-file-item">No pending changes detected.</div>';
        return;
    }

    changedFilesEl.innerHTML = rows.map((row) => `
        <div class="changed-file-item">
            <span class="git-smart-file-name">${gitSmartEscape(row.path)}</span>
            <span class="git-smart-file-status" title="${gitSmartEscape(row.group)}">${gitSmartEscape(row.status)}</span>
        </div>
    `).join('');
}

function updateCommitModalMessageHint() {
    const { messageInput, messageHint } = getGitCommitModalElements();
    if (!messageInput || !messageHint) {
        return;
    }

    const quality = getCommitMessageQuality(messageInput.value);
    messageHint.classList.remove('is-valid', 'is-warning', 'is-error');
    messageHint.textContent = quality.text;
    if (quality.level === 'valid') {
        messageHint.classList.add('is-valid');
    } else if (quality.level === 'warning') {
        messageHint.classList.add('is-warning');
    } else {
        messageHint.classList.add('is-error');
    }
}

function updateCommitModalActionState() {
    const { messageInput, warningEl, stageAllInput, confirmBtn } = getGitCommitModalElements();
    if (!messageInput || !warningEl || !confirmBtn) {
        return;
    }

    const snapshot = gitSmartCommitSnapshot || { staged: [], unstaged: [], untracked: [], hasChanges: false };
    const shouldStageAll = Boolean(stageAllInput?.checked);
    const messageQuality = getCommitMessageQuality(messageInput.value);
    const hasStaged = snapshot.staged.length > 0;
    const canCommitViaStageAll = shouldStageAll && (snapshot.unstaged.length > 0 || snapshot.untracked.length > 0);
    const canCommit = messageQuality.level !== 'error' && (hasStaged || canCommitViaStageAll);

    let warning = '';
    if (!snapshot.hasChanges) {
        warning = 'No changes found in this repository.';
    } else if (!hasStaged && !canCommitViaStageAll) {
        warning = 'No staged files available. Stage files first or enable "Stage all".';
    }

    warningEl.hidden = !warning;
    warningEl.textContent = warning;
    confirmBtn.disabled = !canCommit;
}

async function refreshSmartCommitModalContext() {
    const { stagedCountEl, unstagedCountEl, untrackedCountEl, branchNameEl } = getGitCommitModalElements();

    if (!currentProject?.path) {
        return;
    }

    const requestToken = ++gitSmartCommitRefreshToken;
    const [statusResult, branchesResult] = await Promise.all([
        ipcRenderer.invoke('git-status', currentProject.path),
        ipcRenderer.invoke('git-branches', currentProject.path)
    ]);
    if (requestToken !== gitSmartCommitRefreshToken) {
        return;
    }

    if (!statusResult?.success) {
        gitSmartCommitSnapshot = { staged: [], unstaged: [], untracked: [], hasChanges: false };
        renderCommitModalFiles(gitSmartCommitSnapshot);
        updateCommitModalActionState();
        return;
    }

    gitSmartCommitSnapshot = parseGitStatusPorcelain(statusResult.output);
    renderCommitModalFiles(gitSmartCommitSnapshot);

    if (stagedCountEl) stagedCountEl.textContent = String(gitSmartCommitSnapshot.staged.length);
    if (unstagedCountEl) unstagedCountEl.textContent = String(gitSmartCommitSnapshot.unstaged.length);
    if (untrackedCountEl) untrackedCountEl.textContent = String(gitSmartCommitSnapshot.untracked.length);
    if (branchNameEl) {
        branchNameEl.textContent = branchesResult?.success
            ? parseCurrentBranchName(branchesResult.output)
            : '--';
    }

    updateCommitModalMessageHint();
    updateCommitModalActionState();
}

function isPushRejectedByRemote(result) {
    const text = `${result?.error || ''}\n${result?.stderr || ''}`.toLowerCase();
    return text.includes('fetch first')
        || text.includes('non-fast-forward')
        || text.includes('failed to push some refs')
        || text.includes('push rejected');
}

async function requestGitSmartConfirmation(options = {}) {
    const {
        title = 'Confirm Git Action',
        subtitle = '',
        detail = '',
        confirmLabel = 'Confirm',
        cancelLabel = 'Cancel',
        mode = 'warning',
        icon = 'fa-circle-exclamation',
        confirmVariant = mode === 'danger' ? 'danger' : 'primary',
        notes = []
    } = options;

    if (typeof showUpdateSmartDialog === 'function') {
        const result = await showUpdateSmartDialog({
            mode,
            title,
            subtitle,
            detail,
            iconHtml: `<i class="fas ${icon}"></i>`,
            version: currentProject?.name || 'Git',
            channel: 'Git',
            checkedAt: new Date().toISOString(),
            notes,
            dismissOnBackdrop: true,
            actions: [
                { label: confirmLabel, value: 'confirm', variant: confirmVariant, icon: 'fa-check' },
                { label: cancelLabel, value: 'cancel', variant: 'secondary', icon: 'fa-times' }
            ]
        });
        return result === 'confirm';
    }

    return confirm([title, subtitle, detail].filter(Boolean).join('\n\n'));
}

function ensureGitSmartInputModal() {
    if (document.getElementById('git-smart-input-modal')) {
        return;
    }

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'git-smart-input-modal';
    modal.innerHTML = `
        <div class="modal-content git-smart-modal" style="max-width: 560px;">
            <div class="git-smart-accent-bar"></div>
            <div class="git-smart-header">
                <div class="git-smart-header-left">
                    <div class="git-smart-header-icon">
                        <i class="fas fa-pen"></i>
                    </div>
                    <div>
                        <h2 id="git-smart-input-title">Git Action</h2>
                        <p class="git-smart-subtitle" id="git-smart-input-subtitle"></p>
                    </div>
                </div>
                <button class="git-smart-close" id="git-smart-input-close" type="button" aria-label="Close git input dialog">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="modal-body">
                <p class="setting-description" id="git-smart-input-detail"></p>
                <div class="form-group">
                    <label for="git-smart-input-field" id="git-smart-input-label">Value</label>
                    <input type="text" id="git-smart-input-field" />
                </div>
                <small id="git-smart-input-error" class="git-commit-message-hint is-error" hidden></small>
            </div>
            <div class="modal-footer git-smart-footer">
                <button class="btn-secondary" id="git-smart-input-cancel" type="button">Cancel</button>
                <button class="btn-primary" id="git-smart-input-confirm" type="button">
                    <i class="fas fa-check"></i> Confirm
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

async function showGitSmartInputDialog(options = {}) {
    ensureGitSmartInputModal();

    const modal = document.getElementById('git-smart-input-modal');
    const titleEl = document.getElementById('git-smart-input-title');
    const subtitleEl = document.getElementById('git-smart-input-subtitle');
    const detailEl = document.getElementById('git-smart-input-detail');
    const labelEl = document.getElementById('git-smart-input-label');
    const inputEl = document.getElementById('git-smart-input-field');
    const errorEl = document.getElementById('git-smart-input-error');
    const confirmBtn = document.getElementById('git-smart-input-confirm');
    const cancelBtn = document.getElementById('git-smart-input-cancel');
    const closeBtn = document.getElementById('git-smart-input-close');

    if (!modal || !titleEl || !subtitleEl || !detailEl || !labelEl || !inputEl || !errorEl || !confirmBtn || !cancelBtn || !closeBtn) {
        return null;
    }

    titleEl.textContent = options.title || 'Git Input';
    subtitleEl.textContent = options.subtitle || '';
    detailEl.textContent = options.detail || '';
    labelEl.textContent = options.label || 'Value';
    inputEl.placeholder = options.placeholder || '';
    inputEl.value = options.value || '';
    errorEl.hidden = true;
    errorEl.textContent = '';
    confirmBtn.innerHTML = `<i class="fas ${options.confirmIcon || 'fa-check'}"></i> ${gitSmartEscape(options.confirmLabel || 'Confirm')}`;

    const required = options.required !== false;
    const validate = typeof options.validate === 'function' ? options.validate : null;

    return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            cleanup();
            hideModal('git-smart-input-modal');
            resolve(value);
        };

        const runValidation = () => {
            const raw = String(inputEl.value || '');
            const normalized = options.trim === false ? raw : raw.trim();

            if (required && !normalized) {
                errorEl.textContent = 'This value is required.';
                errorEl.hidden = false;
                return null;
            }

            if (validate) {
                const validationError = validate(normalized);
                if (validationError) {
                    errorEl.textContent = String(validationError);
                    errorEl.hidden = false;
                    return null;
                }
            }

            errorEl.hidden = true;
            errorEl.textContent = '';
            return normalized;
        };

        const onConfirm = () => {
            const value = runValidation();
            if (value === null) {
                return;
            }
            finish(value);
        };

        const onCancel = () => finish(null);
        const onBackdrop = (event) => {
            if (event.target === modal) {
                finish(null);
            }
        };
        const onKeyDown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                finish(null);
                return;
            }
            if (event.key === 'Enter') {
                event.preventDefault();
                onConfirm();
            }
        };

        const cleanup = () => {
            confirmBtn.removeEventListener('click', onConfirm);
            cancelBtn.removeEventListener('click', onCancel);
            closeBtn.removeEventListener('click', onCancel);
            modal.removeEventListener('click', onBackdrop);
            inputEl.removeEventListener('keydown', onKeyDown);
        };

        confirmBtn.addEventListener('click', onConfirm);
        cancelBtn.addEventListener('click', onCancel);
        closeBtn.addEventListener('click', onCancel);
        modal.addEventListener('click', onBackdrop);
        inputEl.addEventListener('keydown', onKeyDown);
        showModal('git-smart-input-modal');
        requestAnimationFrame(() => inputEl.focus({ preventScroll: true }));
    });
}

async function handlePushRejectionGuidance(pushResult, contextLabel = 'push') {
    if (!isPushRejectedByRemote(pushResult) || !currentProject || typeof showUpdateSmartDialog !== 'function') {
        return false;
    }

    const decision = await showUpdateSmartDialog({
        mode: 'warning',
        title: 'Push Rejected',
        subtitle: 'Remote contains commits that are not in your local branch.',
        detail: 'Pull latest changes, resolve conflicts if needed, then retry push.',
        iconHtml: '<i class="fas fa-code-branch"></i>',
        version: currentProject.name || 'Repository',
        channel: 'Git',
        checkedAt: new Date().toISOString(),
        notes: [
            'Recommended: Pull latest changes first.',
            'If a merge conflict appears, resolve it before retrying push.',
            'Your local commit is safe and still available.'
        ],
        actions: [
            { label: 'Pull Latest', value: 'pull', variant: 'primary', icon: 'fa-download' },
            { label: 'View History', value: 'history', variant: 'secondary', icon: 'fa-clock-rotate-left' },
            { label: 'Close', value: 'close', variant: 'secondary', icon: 'fa-times' }
        ]
    });

    if (decision === 'history') {
        await loadCommitHistory();
        return true;
    }

    if (decision !== 'pull') {
        return true;
    }

    showNotification('Pulling latest changes before retry...', 'info');
    const pullResult = await ipcRenderer.invoke('git-pull', currentProject.path);
    if (!pullResult.success) {
        showNotification(`Pull failed: ${pullResult.error}`, 'error');
        if (typeof checkForMergeConflictsAndPrompt === 'function') {
            await checkForMergeConflictsAndPrompt(contextLabel);
        }
        return true;
    }

    showNotification('Pull completed. Retrying push...', 'info');
    const retryResult = await ipcRenderer.invoke('git-push', currentProject.path);
    if (retryResult.success) {
        showNotification('Push completed successfully', 'success');
        await refreshGitStatus();
        return true;
    }

    showNotification(`Push failed: ${retryResult.error}`, 'error');
    return true;
}

async function runSmartCommitFromModal() {
    const { messageInput, stageAllInput, autoPushInput } = getGitCommitModalElements();
    const message = messageInput?.value?.trim() || '';
    if (!message) {
        showNotification('Please enter a commit message', 'error');
        updateCommitModalActionState();
        return;
    }

    if (!currentProject) {
        showNotification('Please select a project first', 'error');
        return;
    }

    await withGitLock(async () => {
        try {
            const shouldStageAll = Boolean(stageAllInput?.checked);
            const shouldAutoPush = Boolean(autoPushInput?.checked);

            if (shouldStageAll) {
                const stageResult = await ipcRenderer.invoke('run-command', 'git add .', currentProject.path);
                if (!stageResult.success) {
                    showNotification(`Stage all failed: ${stageResult.error}`, 'error');
                    return;
                }
            }

            const commitResult = await ipcRenderer.invoke('git-commit', currentProject.path, message);
            if (!commitResult.success) {
                showNotification(`Commit failed: ${commitResult.error}`, 'error');
                await refreshSmartCommitModalContext();
                return;
            }

            showNotification('Changes committed successfully', 'success');
            if (messageInput) {
                messageInput.value = '';
            }
            hideModal('git-commit-modal');
            await refreshGitStatus();

            if (shouldAutoPush) {
                const pushResult = await ipcRenderer.invoke('git-push', currentProject.path);
                if (pushResult.success) {
                    showNotification('Push completed successfully', 'success');
                    await refreshGitStatus();
                } else {
                    showNotification(`Push failed: ${pushResult.error}`, 'error');
                    await handlePushRejectionGuidance(pushResult, 'push');
                }
            }
        } catch (error) {
            showNotification(`Commit error: ${error.message}`, 'error');
        }
    });
}

async function openSmartCommitModal() {
    if (!currentProject) {
        showNotification('Please select a project first', 'error');
        return false;
    }

    showModal('git-commit-modal');
    await refreshSmartCommitModalContext();
    const { messageInput } = getGitCommitModalElements();
    messageInput?.focus({ preventScroll: true });
    return true;
}
function initializeGitView() {
    // Initialize Git Tabs
    initializeGitTabs();

    document.getElementById('clone-repo')?.addEventListener('click', () => {
        showModal('clone-modal');
    });

    document.getElementById('git-refresh')?.addEventListener('click', async () => {
        await refreshGitStatus();
    });

    document.getElementById('git-history-btn')?.addEventListener('click', async () => {
        await loadCommitHistory();
    });

    document.getElementById('git-remotes-btn')?.addEventListener('click', async () => {
        await showRemotesModal();
    });

    document.getElementById('git-pull-overview-btn')?.addEventListener('click', () => {
        document.getElementById('git-pull-btn')?.click();
    });

    document.getElementById('git-push-overview-btn')?.addEventListener('click', () => {
        document.getElementById('git-push-btn')?.click();
    });

    document.getElementById('git-sync-overview-btn')?.addEventListener('click', () => {
        document.getElementById('git-sync-btn')?.click();
    });

    document.getElementById('git-stage-all')?.addEventListener('click', async () => {
        await stageAll();
    });

    document.getElementById('git-discard-all')?.addEventListener('click', async () => {
        const confirmed = await requestGitSmartConfirmation({
            title: 'Discard All Changes',
            subtitle: 'This action will remove all unstaged changes in the working tree.',
            detail: 'This cannot be undone.',
            mode: 'danger',
            icon: 'fa-triangle-exclamation',
            confirmLabel: 'Discard All',
            confirmVariant: 'danger'
        });
        if (confirmed) {
            await discardAll();
        }
    });

    document.getElementById('git-select-repo')?.addEventListener('click', async () => {
        const selectedPath = await ipcRenderer.invoke('select-folder');
        if (selectedPath) {
            // Check if it's a valid project
            const projectName = basenamePath(selectedPath);
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

    document.getElementById('git-commit-btn')?.addEventListener('click', async () => {
        await openSmartCommitModal();
    });

    document.getElementById('commit-message')?.addEventListener('input', () => {
        updateCommitModalMessageHint();
        updateCommitModalActionState();
    });
    document.getElementById('git-commit-stage-all')?.addEventListener('change', () => {
        updateCommitModalActionState();
    });
    document.getElementById('confirm-commit-btn')?.addEventListener('click', async () => {
        await runSmartCommitFromModal();
    });
    
    // Clone repository
    document.getElementById('clone-btn')?.addEventListener('click', async () => {
        const repoUrl = document.getElementById('clone-repo-url').value.trim();
        const cloneLocation = document.getElementById('clone-location').value;
        const cloneButton = document.getElementById('clone-btn');

        if (cloneSmartDialogInProgress) {
            showNotification('A clone operation is already running', 'warning');
            return;
        }

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

        const shouldOpenAfterClone = Boolean(document.getElementById('open-after-clone')?.checked);
        await executeCloneRepositoryFlow({
            repoUrl,
            targetPath,
            shouldOpenAfterClone,
            cloneButton,
            reopenSourceModal: true
        });
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
                    await handlePushRejectionGuidance(result, 'push');
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
        const message = await showGitSmartInputDialog({
            title: 'Create Stash',
            subtitle: 'Save current changes without committing.',
            detail: 'You can apply this stash later from the stash list.',
            label: 'Stash Message (optional)',
            placeholder: 'WIP: brief context',
            required: false,
            confirmLabel: 'Create Stash',
            confirmIcon: 'fa-box-archive'
        });
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
                        await handlePushRejectionGuidance(pushResult, 'push');
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
            void loadProjectsIntoDropdown({ force: false });
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

    const existingRepoTargetInput = document.getElementById('github-existing-repo-target');
    existingRepoTargetInput?.addEventListener('input', () => {
        updateGitHubUploadSubmitState();
    });
    existingRepoTargetInput?.addEventListener('blur', () => {
        const validation = validateGitHubExistingRepoTargetInput(existingRepoTargetInput.value);
        if (validation.valid && existingRepoTargetInput.value !== validation.normalized) {
            existingRepoTargetInput.value = validation.normalized;
        }
        updateGitHubUploadSubmitState();
    });

    document.querySelectorAll('.gh-target-mode-option').forEach((option) => {
        option.addEventListener('click', () => {
            const targetMode = option.dataset.mode === 'existing' ? 'existing' : 'new';
            setGitHubUploadMode(targetMode);
        });
    });
    document.querySelectorAll('input[name="github-upload-mode"]').forEach((input) => {
        input.addEventListener('change', () => {
            const targetMode = input.value === 'existing' ? 'existing' : 'new';
            setGitHubUploadMode(targetMode);
        });
    });

    document.getElementById('github-existing-force-push')?.addEventListener('change', () => {
        updateGitHubExistingSafetyNote();
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
        if (!currentProject) {
            showNotification('No project selected', 'error');
            updateGitHubUploadSubmitState();
            return;
        }

        const readiness = getGitHubUploadSubmitReadiness();
        if (!readiness.canSubmit) {
            if (readiness.mode === 'existing') {
                updateGitHubExistingRepoHint(readiness.existingValidation, { forceError: true });
            } else {
                updateGitHubRepoNameHint(readiness.validation, { forceError: true });
            }
            updateGitHubUploadSubmitState();
            showNotification(readiness.reason || 'Complete all required fields before uploading', 'error');
            if (readiness.mode === 'existing') {
                const existingRepoTarget = document.getElementById('github-existing-repo-target');
                existingRepoTarget?.focus();
            } else {
                const repoNameInput = document.getElementById('github-repo-name');
                repoNameInput?.focus();
            }
            return;
        }

        const selectedPaths = collectGitHubUploadPathspecs();
        if (selectedPaths.length === 0) {
            showNotification('Select at least one file or folder to upload', 'error');
            updateGitHubUploadSubmitState();
            return;
        }

        const uploadMode = readiness.mode;
        const forcePush = uploadMode === 'existing' && Boolean(document.getElementById('github-existing-force-push')?.checked);
        if (forcePush) {
            const forceConfirmed = await requestGitSmartConfirmation({
                title: 'Force Push Existing Repository',
                subtitle: 'This will overwrite the remote branch history.',
                detail: 'Only continue when you intentionally want to replace remote commits with your selected files.',
                mode: 'danger',
                icon: 'fa-triangle-exclamation',
                confirmLabel: 'Force Push',
                confirmVariant: 'danger',
                notes: [
                    'A backup branch on GitHub is recommended before force pushing.',
                    'Collaborators will need to re-sync local clones after history rewrite.'
                ]
            });
            if (!forceConfirmed) {
                return;
            }
        }

        let repoData;
        if (uploadMode === 'existing') {
            repoData = {
                mode: 'existing',
                existingRepoTarget: readiness.existingValidation.normalized,
                forcePush,
                selectedPaths
            };
        } else {
            const description = document.getElementById('github-repo-description')?.value || '';
            const isPrivate = document.querySelector('input[name="github-visibility"]:checked')?.value === 'private';
            const addReadme = Boolean(document.getElementById('github-add-readme')?.checked);
            const addGitignore = Boolean(document.getElementById('github-add-gitignore')?.checked);
            const addLicense = Boolean(document.getElementById('github-add-license')?.checked);
            repoData = {
                mode: 'create',
                name: readiness.validation.normalized,
                description,
                isPrivate,
                addReadme,
                addGitignore,
                addLicense,
                selectedPaths
            };
        }

        githubUploadInProgress = true;
        updateGitHubUploadSubmitState();
        ghUploadProgressShow();

        try {
            await enqueueOperation('github-upload-project', {
                projectPath: currentProject.path,
                repoData
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
                    await handlePushRejectionGuidance(result, 'push');
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
            const confirmed = await requestGitSmartConfirmation({
                title: 'Hard Reset Branch',
                subtitle: 'This will permanently discard staged and unstaged changes.',
                detail: 'Use this only when you are certain you want to lose local modifications.',
                mode: 'danger',
                icon: 'fa-rotate-left',
                confirmLabel: 'Hard Reset',
                confirmVariant: 'danger'
            });
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
        const commitHash = await showGitSmartInputDialog({
            title: 'Revert Commit',
            subtitle: 'Create a new commit that undoes a specific commit.',
            detail: 'Enter the hash of the commit to revert (short or full hash).',
            label: 'Commit Hash',
            placeholder: 'e.g. a1b2c3d',
            confirmLabel: 'Revert Commit',
            confirmIcon: 'fa-rotate-left'
        });
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

        const confirmed = await requestGitSmartConfirmation({
            title: 'Clean Repository',
            subtitle: 'Remove all untracked files and folders.',
            detail: 'Ignored files can also be removed depending on git clean options.',
            mode: 'danger',
            icon: 'fa-trash',
            confirmLabel: 'Clean Repository',
            confirmVariant: 'danger'
        });
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

    setGitHubUploadMode('new');
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

    const existingRepoTargetInput = document.getElementById('github-existing-repo-target');
    if (existingRepoTargetInput) {
        existingRepoTargetInput.value = '';
        existingRepoTargetInput.classList.remove('gh-repo-valid', 'gh-repo-invalid');
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

    updateGitHubExistingSafetyNote();
    updateGitHubUploadSubmitState();
    await loadGitHubUploadCandidates(currentProject.path);
    await prefillGitHubExistingRepoTarget();

    if (repoNameInput && document.activeElement === document.body) {
        repoNameInput.focus({ preventScroll: true });
        const cursorPosition = repoNameInput.value.length;
        repoNameInput.setSelectionRange(cursorPosition, cursorPosition);
    }
    return true;
}

function getGitHubUploadMode() {
    const selectedMode = document.querySelector('input[name="github-upload-mode"]:checked')?.value;
    return selectedMode === 'existing' ? 'existing' : 'new';
}

function setGitHubUploadMode(mode = 'new') {
    const normalizedMode = mode === 'existing' ? 'existing' : 'new';
    document.querySelectorAll('.gh-target-mode-option').forEach((option) => {
        const optionMode = option.dataset.mode === 'existing' ? 'existing' : 'new';
        const isActive = optionMode === normalizedMode;
        option.classList.toggle('selected', isActive);
        const input = option.querySelector('input[type="radio"]');
        if (input) {
            input.checked = isActive;
        }
    });

    const showNewRepoFields = normalizedMode === 'new';
    ['gh-new-repo-name-field', 'gh-new-repo-description-field', 'gh-new-repo-visibility-field', 'gh-new-repo-options']
        .forEach((elementId) => {
            const element = document.getElementById(elementId);
            if (element) {
                element.style.display = showNewRepoFields ? '' : 'none';
            }
        });

    ['gh-existing-repo-field', 'gh-existing-options-field'].forEach((elementId) => {
        const element = document.getElementById(elementId);
        if (element) {
            element.style.display = showNewRepoFields ? 'none' : '';
        }
    });

    const subtitleEl = document.querySelector('#github-upload-modal .np-subtitle');
    if (subtitleEl) {
        subtitleEl.textContent = showNewRepoFields
            ? 'Create a new repository and upload selected files'
            : 'Safely update an existing GitHub repository with selected files';
    }

    const confirmBtn = document.getElementById('confirm-github-upload-btn');
    if (confirmBtn) {
        confirmBtn.innerHTML = showNewRepoFields
            ? '<i class="fab fa-github"></i> Create & Upload'
            : '<i class="fab fa-github"></i> Upload to Existing Repo';
    }

    const progressOverlay = document.getElementById('gh-upload-progress');
    if (progressOverlay) {
        progressOverlay.dataset.uploadMode = normalizedMode;
    }

    updateGitHubExistingSafetyNote();
    updateGitHubUploadSubmitState();
}

function updateGitHubExistingSafetyNote() {
    const noteEl = document.getElementById('github-existing-safety-note');
    if (!noteEl) {
        return;
    }

    const forcePushEnabled = Boolean(document.getElementById('github-existing-force-push')?.checked);
    if (forcePushEnabled) {
        noteEl.classList.add('warning');
        noteEl.textContent = 'Force push is enabled: remote history on the target branch will be replaced.';
        return;
    }

    noteEl.classList.remove('warning');
    noteEl.textContent = 'Recommended: keep force push disabled to preserve repository history.';
}

function deriveGitHubRepoTargetFromRemoteOutput(output) {
    const lines = String(output || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    if (lines.length === 0) {
        return '';
    }

    const parseRemoteUrl = (value) => {
        const text = String(value || '').trim();
        if (!text) {
            return '';
        }

        let match = text.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
        if (match) {
            return `${match[1]}/${match[2]}`;
        }

        match = text.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
        if (match) {
            return `${match[1]}/${match[2]}`;
        }

        return '';
    };

    let fallback = '';
    for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts.length < 2) {
            continue;
        }

        const remoteName = parts[0];
        const remoteUrl = parts[1];
        const parsedTarget = parseRemoteUrl(remoteUrl);
        if (!parsedTarget) {
            continue;
        }

        if (remoteName === 'origin') {
            return parsedTarget;
        }
        if (!fallback) {
            fallback = parsedTarget;
        }
    }

    return fallback;
}

async function prefillGitHubExistingRepoTarget() {
    if (!currentProject?.path) {
        return;
    }

    const existingRepoInput = document.getElementById('github-existing-repo-target');
    if (!existingRepoInput || existingRepoInput.value.trim()) {
        return;
    }

    try {
        const remoteResult = await ipcRenderer.invoke('git-remote-list', currentProject.path);
        if (!remoteResult?.success) {
            return;
        }

        const detectedTarget = deriveGitHubRepoTargetFromRemoteOutput(remoteResult.output || '');
        if (!detectedTarget) {
            return;
        }

        existingRepoInput.value = detectedTarget;
        updateGitHubExistingRepoHint();
        updateGitHubUploadSubmitState();
    } catch {
        // Ignore remote discovery errors and keep manual input flow.
    }
}

function validateGitHubExistingRepoTargetInput(rawValue) {
    const sourceValue = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (!sourceValue) {
        return {
            valid: false,
            normalized: '',
            owner: '',
            repo: '',
            message: 'Repository target is required.'
        };
    }

    let candidatePath = sourceValue;
    if (/^https?:\/\//i.test(candidatePath)) {
        try {
            const parsed = new URL(candidatePath);
            if (!/^(?:www\.)?github\.com$/i.test(parsed.hostname)) {
                return {
                    valid: false,
                    normalized: sourceValue,
                    owner: '',
                    repo: '',
                    message: 'Only github.com repositories are supported.'
                };
            }
            candidatePath = parsed.pathname || '';
        } catch {
            return {
                valid: false,
                normalized: sourceValue,
                owner: '',
                repo: '',
                message: 'Repository URL is invalid.'
            };
        }
    } else if (/^ssh:\/\/git@github\.com\//i.test(candidatePath)) {
        candidatePath = candidatePath.replace(/^ssh:\/\/git@github\.com\//i, '');
    } else if (/^git@github\.com:/i.test(candidatePath)) {
        candidatePath = candidatePath.replace(/^git@github\.com:/i, '');
    }

    candidatePath = candidatePath
        .split(/[?#]/, 1)[0]
        .replace(/\.git$/i, '')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '');

    const segments = candidatePath.split('/').filter(Boolean);
    if (segments.length !== 2) {
        return {
            valid: false,
            normalized: sourceValue,
            owner: '',
            repo: '',
            message: 'Use owner/repository format or a GitHub repository URL.'
        };
    }

    const [owner, repo] = segments;
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) {
        return {
            valid: false,
            normalized: sourceValue,
            owner: '',
            repo: '',
            message: 'Repository owner is invalid.'
        };
    }

    if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo) || repo.startsWith('.') || repo.endsWith('.')) {
        return {
            valid: false,
            normalized: sourceValue,
            owner: '',
            repo: '',
            message: 'Repository name is invalid.'
        };
    }

    return {
        valid: true,
        normalized: `${owner}/${repo}`,
        owner,
        repo,
        message: 'Repository target looks good.'
    };
}

function updateGitHubExistingRepoHint(validation, options = {}) {
    const { forceError = false } = options;
    const inputEl = document.getElementById('github-existing-repo-target');
    const hintEl = document.getElementById('github-existing-repo-hint');
    const resolvedValidation = validation || validateGitHubExistingRepoTargetInput(inputEl?.value || '');

    if (inputEl) {
        inputEl.classList.remove('gh-repo-valid', 'gh-repo-invalid');
    }

    let hintState = 'neutral';
    let hintText = 'Use owner/repository or full GitHub URL.';
    const hasInput = Boolean(inputEl?.value.trim());

    if (resolvedValidation.valid) {
        hintState = 'valid';
        hintText = resolvedValidation.message;
        inputEl?.classList.add('gh-repo-valid');
    } else if (hasInput || forceError) {
        hintState = 'invalid';
        hintText = resolvedValidation.message || 'Repository target is invalid.';
        inputEl?.classList.add('gh-repo-invalid');
    }

    if (hintEl) {
        hintEl.textContent = hintText;
        hintEl.dataset.state = hintState;
    }

    return resolvedValidation;
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

function getGitHubUploadSubmitReadiness(modeValidation) {
    const mode = getGitHubUploadMode();
    const validation = mode === 'new'
        ? (modeValidation || validateGitHubRepoNameInput(document.getElementById('github-repo-name')?.value || ''))
        : null;
    const existingValidation = mode === 'existing'
        ? (modeValidation || validateGitHubExistingRepoTargetInput(document.getElementById('github-existing-repo-target')?.value || ''))
        : null;
    const selectedPathCount = collectGitHubUploadPathspecs().length;

    if (githubUploadInProgress) {
        return {
            canSubmit: false,
            reason: 'Upload is currently in progress.',
            mode,
            validation,
            existingValidation,
            selectedPathCount
        };
    }

    if (githubUploadLoadingCandidates) {
        return {
            canSubmit: false,
            reason: 'Scanning project files...',
            mode,
            validation,
            existingValidation,
            selectedPathCount
        };
    }

    if (!currentProject) {
        return {
            canSubmit: false,
            reason: 'No project selected.',
            mode,
            validation,
            existingValidation,
            selectedPathCount
        };
    }

    if (mode === 'new' && (!validation || !validation.valid)) {
        return {
            canSubmit: false,
            reason: validation?.message || 'Repository name is invalid.',
            mode,
            validation,
            existingValidation,
            selectedPathCount
        };
    }

    if (mode === 'existing' && (!existingValidation || !existingValidation.valid)) {
        return {
            canSubmit: false,
            reason: existingValidation?.message || 'Repository target is invalid.',
            mode,
            validation,
            existingValidation,
            selectedPathCount
        };
    }

    if (selectedPathCount === 0) {
        return {
            canSubmit: false,
            reason: 'Select at least one file or folder to upload.',
            mode,
            validation,
            existingValidation,
            selectedPathCount
        };
    }

    return {
        canSubmit: true,
        reason: '',
        mode,
        validation,
        existingValidation,
        selectedPathCount
    };
}

function updateGitHubUploadSubmitState() {
    const confirmBtn = document.getElementById('confirm-github-upload-btn');
    if (!confirmBtn) {
        return;
    }

    const mode = getGitHubUploadMode();
    const validation = mode === 'new'
        ? updateGitHubRepoNameHint()
        : updateGitHubExistingRepoHint();
    const readiness = getGitHubUploadSubmitReadiness(validation);
    confirmBtn.disabled = !readiness.canSubmit;
    confirmBtn.title = readiness.canSubmit
        ? (readiness.mode === 'existing'
            ? 'Upload selected files to existing repository'
            : 'Create repository and upload selected files')
        : (readiness.reason || 'Complete all required fields to continue');
}
