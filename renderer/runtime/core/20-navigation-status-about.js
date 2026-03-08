/* Runtime module: core/20-navigation-status-about.js */
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

    rebuildDocumentationSearchIndex();
    updateDocumentationSearchMeta({ query: '', matchCount: 0 });

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
        if (docsSearchDebounceTimer) {
            clearTimeout(docsSearchDebounceTimer);
        }
        const nextValue = event.target.value || '';
        docsSearchDebounceTimer = setTimeout(() => {
            filterDocumentationSections(nextValue);
            docsSearchDebounceTimer = null;
        }, 100);
    });

    docsSearch?.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            if (docsSearchDebounceTimer) {
                clearTimeout(docsSearchDebounceTimer);
                docsSearchDebounceTimer = null;
            }
            docsSearch.value = '';
            filterDocumentationSections('');
        }
    });

    document.querySelectorAll('.docs-jump-card').forEach((button) => {
        button.addEventListener('click', async () => {
            const targetTab = button.dataset.docTab;
            if (targetTab) {
                if (docsSearch) {
                    docsSearch.value = '';
                }
                filterDocumentationSections('');
                switchDocumentationTab(targetTab, { focusNav: true });
                return;
            }

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

function keepDocumentationTabVisible(navContainer, navItem) {
    if (!navContainer || !navItem) {
        return;
    }

    const canScrollHorizontally = navContainer.scrollWidth > (navContainer.clientWidth + 1);
    if (!canScrollHorizontally) {
        return;
    }

    const navRect = navContainer.getBoundingClientRect();
    const itemRect = navItem.getBoundingClientRect();
    const margin = 10;

    if (itemRect.left < navRect.left + margin) {
        navContainer.scrollLeft -= (navRect.left + margin) - itemRect.left;
    } else if (itemRect.right > navRect.right - margin) {
        navContainer.scrollLeft += itemRect.right - (navRect.right - margin);
    }
}

function resetHorizontalPageScroll() {
    const scrollingElement = document.scrollingElement || document.documentElement;
    if (scrollingElement && scrollingElement.scrollLeft !== 0) {
        scrollingElement.scrollLeft = 0;
    }
    if (document.body && document.body.scrollLeft !== 0) {
        document.body.scrollLeft = 0;
    }
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
    keepDocumentationTabVisible(docsNav, activeNavItem);
    resetHorizontalPageScroll();

    const query = (document.getElementById('docs-search')?.value || '').trim();
    const visibleCount = docsNav.querySelectorAll('.docs-nav-item:not(.docs-nav-item-hidden)').length;
    updateDocumentationSearchMeta({ query, matchCount: query ? visibleCount : 0 });
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
    if (documentationSearchIndex.length === 0) {
        rebuildDocumentationSearchIndex();
    }

    if (!query) {
        navItems.forEach((item) => item.classList.remove('docs-nav-item-hidden'));
        docsContent.classList.remove('docs-content-empty');
        emptyState.classList.remove('show');
        updateDocumentationSearchMeta({ query: '', matchCount: 0 });
        if (!docsNav.querySelector('.docs-nav-item.active')) {
            switchDocumentationTab('overview', { focusNav: false });
        }
        return;
    }

    const matches = new Set(
        documentationSearchIndex
            .filter((entry) => entry.text.includes(query))
            .map((entry) => entry.tab)
    );

    navItems.forEach((item) => {
        const tab = item.dataset.tab || '';
        const isMatch = matches.has(tab);

        item.classList.toggle('docs-nav-item-hidden', !isMatch);
    });

    docsContent.classList.toggle('docs-content-empty', matches.size === 0);
    emptyState.classList.toggle('show', matches.size === 0);
    updateDocumentationSearchMeta({ query, matchCount: matches.size });

    if (matches.size === 0) {
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
    if (!matches.has(currentActiveTab)) {
        const [firstMatch] = matches;
        switchDocumentationTab(firstMatch || 'overview', { focusNav: false });
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

    document.getElementById('open-docs')?.addEventListener('click', async () => {
        hideModal('about-modal');
        const opened = await openDocumentationView('overview');
        if (!opened) {
            showNotification('Unable to open Documentation view right now.', 'warning');
        }
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

    const targetView = document.getElementById(`${viewName}-view`);
    if (!targetView) {
        return false;
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

    const previousView = currentView;
    targetView.classList.add('active');
    currentView = viewName;
    recordViewHistoryTransition(previousView, viewName);

    // Update status bar with current view name
    updateStatusMessage(getViewLabel(viewName));
    setStatusCurrentView(getViewLabel(viewName));

    // Load view-specific data
    if (viewName === 'projects') {
        void loadAllProjects({ force: false, showLoading: false });
    } else if (viewName === 'git') {
        void refreshGitStatus();
    } else if (viewName === 'extensions') {
        void loadInstalledExtensions({ force: false });
    } else if (viewName === 'dashboard') {
        void loadAllProjects({ force: false, showLoading: false });
    } else if (viewName === 'diagnostics' && logViewerController?.refresh) {
        void logViewerController.refresh();
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
        documentation: 'Documentation',
        diagnostics: 'Diagnostics'
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
            const channel = typeof versionInfo.channel === 'string' && versionInfo.channel.trim()
                ? versionInfo.channel.trim().toLowerCase()
                : 'stable';

            appVersionInfo = {
                version,
                displayVersion,
                channel
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

    const aboutReleaseChannelEl = document.getElementById('about-release-channel');
    if (aboutReleaseChannelEl) {
        const channel = typeof appVersionInfo.channel === 'string' && appVersionInfo.channel.trim()
            ? appVersionInfo.channel.trim().toLowerCase()
            : 'stable';
        const channelLabel = channel.charAt(0).toUpperCase() + channel.slice(1);
        aboutReleaseChannelEl.textContent = `${channelLabel} Channel`;
        aboutReleaseChannelEl.dataset.channel = channel;
    }

    const statusVersionEl = document.getElementById('status-app-version');
    if (statusVersionEl) {
        statusVersionEl.textContent = appVersionInfo.displayVersion;
    }

    syncTitlebarUpdateControl();
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

