/* Runtime module: projects/20-github-auth-and-delete-dialogs.js */
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
        await updateGitHubReposCount({ force: true });
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

function clearGitHubAvatarPreviewHideTimer() {
    if (!githubAvatarPreviewHideTimer) {
        return;
    }
    clearTimeout(githubAvatarPreviewHideTimer);
    githubAvatarPreviewHideTimer = null;
}

function ensureGitHubAvatarPreviewElements() {
    if (githubAvatarPreviewElements) {
        return githubAvatarPreviewElements;
    }

    const preview = document.createElement('div');
    preview.className = 'github-avatar-hover-preview';
    preview.id = 'github-avatar-hover-preview';
    preview.setAttribute('aria-hidden', 'true');
    preview.innerHTML = `
        <div class="github-avatar-hover-card">
            <img src="" alt="Expanded GitHub avatar" />
            <div class="github-avatar-hover-sheen"></div>
        </div>
    `;

    document.body.appendChild(preview);
    const image = preview.querySelector('img');
    githubAvatarPreviewElements = { preview, image };
    return githubAvatarPreviewElements;
}

function updateGitHubAvatarPreviewSource() {
    const elements = ensureGitHubAvatarPreviewElements();
    if (!elements?.image) {
        return;
    }

    const source = githubUserData?.avatar_url
        ? buildHiResAvatarUrl(githubUserData.avatar_url, 512)
        : createFallbackAvatarDataUrl(githubUserData?.login || 'GH');
    elements.image.src = source;
}

function computeGitHubAvatarPreviewPosition(anchorRect) {
    const baseWidth = Math.max(64, Math.round(anchorRect.width || 70));
    const previewSize = Math.round(baseWidth * 2.5);
    const margin = 14;
    const offset = 14;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1280;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 720;

    let left = anchorRect.right + offset;
    let top = anchorRect.top + ((anchorRect.height - previewSize) / 2);

    if (left + previewSize + margin > viewportWidth) {
        left = anchorRect.left - previewSize - offset;
    }

    if (left < margin) {
        left = anchorRect.left + ((anchorRect.width - previewSize) / 2);
    }

    left = Math.max(margin, Math.min(left, viewportWidth - previewSize - margin));
    top = Math.max(margin, Math.min(top, viewportHeight - previewSize - margin));

    return { left, top, size: previewSize };
}

function positionGitHubAvatarPreview(anchorRect) {
    const elements = ensureGitHubAvatarPreviewElements();
    if (!elements?.preview || !anchorRect) {
        return;
    }

    const position = computeGitHubAvatarPreviewPosition(anchorRect);
    elements.preview.style.width = `${position.size}px`;
    elements.preview.style.height = `${position.size}px`;
    elements.preview.style.left = `${position.left}px`;
    elements.preview.style.top = `${position.top}px`;
}

function hideGitHubAvatarPreview(immediate = false) {
    const elements = ensureGitHubAvatarPreviewElements();
    if (!elements?.preview) {
        return;
    }

    clearGitHubAvatarPreviewHideTimer();
    if (immediate) {
        elements.preview.classList.remove('active');
        elements.preview.setAttribute('aria-hidden', 'true');
        return;
    }

    githubAvatarPreviewHideTimer = setTimeout(() => {
        elements.preview.classList.remove('active');
        elements.preview.setAttribute('aria-hidden', 'true');
        githubAvatarPreviewHideTimer = null;
    }, 80);
}

function showGitHubAvatarPreviewFromAnchor(anchorElement) {
    if (!anchorElement || !githubUserData) {
        return;
    }

    const accountModal = document.getElementById('github-account-modal');
    if (!accountModal || !accountModal.classList.contains('show')) {
        return;
    }

    const anchorRect = anchorElement.getBoundingClientRect();
    if (!anchorRect || anchorRect.width <= 0 || anchorRect.height <= 0) {
        return;
    }

    updateGitHubAvatarPreviewSource();
    positionGitHubAvatarPreview(anchorRect);

    const elements = ensureGitHubAvatarPreviewElements();
    clearGitHubAvatarPreviewHideTimer();
    elements.preview.classList.add('active');
    elements.preview.setAttribute('aria-hidden', 'false');
}

function initializeGitHubAvatarHoverPreview() {
    const avatarLarge = document.getElementById('github-avatar-large');
    if (!avatarLarge) {
        return;
    }

    ensureGitHubAvatarPreviewElements();

    avatarLarge.addEventListener('mouseenter', () => {
        showGitHubAvatarPreviewFromAnchor(avatarLarge);
    });

    avatarLarge.addEventListener('mouseleave', () => {
        hideGitHubAvatarPreview(false);
    });

    avatarLarge.addEventListener('focusin', () => {
        showGitHubAvatarPreviewFromAnchor(avatarLarge);
    });

    avatarLarge.addEventListener('focusout', () => {
        hideGitHubAvatarPreview(false);
    });

    window.addEventListener('resize', () => {
        hideGitHubAvatarPreview(true);
    });

    window.addEventListener('scroll', () => {
        hideGitHubAvatarPreview(true);
    }, true);

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            hideGitHubAvatarPreview(true);
        }
    });
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
            avatarImage.src = githubUserData.avatar_url
                ? buildHiResAvatarUrl(githubUserData.avatar_url, 256)
                : createFallbackAvatarDataUrl(githubUserData.login || 'GH');
            avatarImage.alt = githubUserData.login || 'GitHub avatar';
        }
    }

    updateGitHubAvatarPreviewSource();

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
            await updateGitHubReposCount({ force: true });

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
            await updateGitHubReposCount({ force: true });
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

    const confirmed = typeof requestGitSmartConfirmation === 'function'
        ? await requestGitSmartConfirmation({
            title: 'Discard File Changes',
            subtitle: `Discard local changes for ${filename}?`,
            detail: 'This file will be restored to the last committed state.',
            mode: 'danger',
            icon: 'fa-file-circle-xmark',
            confirmLabel: 'Discard File',
            confirmVariant: 'danger'
        })
        : confirm(`Are you sure you want to discard changes to ${filename}? This cannot be undone.`);
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
        <div class="modal-content git-smart-modal" style="max-width: 900px;">
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
        <div class="modal-content git-smart-modal" style="max-width: 900px;">
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
        <div class="modal-content git-smart-modal" style="max-width: 980px;">
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

    const hasGitRepository = currentProject.hasGit === true || await isGitRepositoryPath(currentProject.path);
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
    const confirmed = typeof requestGitSmartConfirmation === 'function'
        ? await requestGitSmartConfirmation({
            title: 'Delete Branch',
            subtitle: `Delete branch "${branchName}"?`,
            detail: 'The branch reference will be removed locally.',
            mode: 'danger',
            icon: 'fa-code-branch',
            confirmLabel: 'Delete Branch',
            confirmVariant: 'danger'
        })
        : confirm(`Are you sure you want to delete branch "${branchName}"?`);
    if (!confirmed) {
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
    if (typeof showGitSmartInputDialog === 'function') {
        void (async () => {
            const branchName = await showGitSmartInputDialog({
                title: 'Create Branch',
                subtitle: 'Create and switch to a new local branch.',
                detail: 'Use a clear name like feature/login-flow or fix/push-dialog.',
                label: 'Branch Name',
                placeholder: 'feature/my-branch',
                confirmLabel: 'Create Branch',
                confirmIcon: 'fa-code-branch'
            });
            if (!branchName || !branchName.trim()) {
                return;
            }
            createBranch(branchName.trim());
        })();
        return;
    }

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
        <div class="modal-content git-smart-modal" style="max-width: 800px;">
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
        <div class="modal-content git-smart-modal">
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
    const confirmed = typeof requestGitSmartConfirmation === 'function'
        ? await requestGitSmartConfirmation({
            title: 'Remove Remote',
            subtitle: `Remove remote "${remoteName}"?`,
            detail: 'Push and pull actions using this remote will stop until you add it again.',
            mode: 'danger',
            icon: 'fa-globe',
            confirmLabel: 'Remove Remote',
            confirmVariant: 'danger'
        })
        : confirm(`Are you sure you want to remove remote "${remoteName}"?`);
    if (!confirmed) {
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
        if (result.updated) {
            showNotification(`Remote ${name} updated successfully`, 'success');
        } else if (result.unchanged) {
            showNotification(`Remote ${name} already points to this URL`, 'info');
        } else {
            showNotification(`Remote ${name} added successfully`, 'success');
        }
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
        <div class="modal-content git-smart-modal" style="max-width: 700px;">
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
