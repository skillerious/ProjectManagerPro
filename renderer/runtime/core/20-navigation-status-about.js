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
        openReportSmartDialog();
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

let aboutDialogMotionTimer = null;
let aboutDialogKeyHandler = null;
let aboutDialogCloseResolve = null;

function getAboutDialogElements() {
    return {
        overlay: document.getElementById('about-modal'),
        shell: document.getElementById('about-smart-shell'),
        closeBtn: document.getElementById('about-close-btn')
    };
}

function closeAboutSmartDialog() {
    const { overlay } = getAboutDialogElements();

    if (!overlay) {
        return Promise.resolve();
    }

    if (aboutDialogKeyHandler) {
        document.removeEventListener('keydown', aboutDialogKeyHandler, true);
        aboutDialogKeyHandler = null;
    }

    overlay.onclick = null;

    if (aboutDialogMotionTimer) {
        clearTimeout(aboutDialogMotionTimer);
        aboutDialogMotionTimer = null;
        if (typeof aboutDialogCloseResolve === 'function') {
            aboutDialogCloseResolve();
            aboutDialogCloseResolve = null;
        }
    }

    if (!overlay.classList.contains('active')) {
        overlay.classList.remove('update-smart-entering', 'update-smart-closing');
        overlay.setAttribute('aria-hidden', 'true');
        if (typeof aboutDialogCloseResolve === 'function') {
            aboutDialogCloseResolve();
            aboutDialogCloseResolve = null;
        }
        return Promise.resolve();
    }

    overlay.classList.remove('update-smart-entering');
    overlay.classList.add('update-smart-closing');
    overlay.setAttribute('aria-hidden', 'true');

    const exitDuration = Number.isFinite(UPDATE_SMART_DIALOG_EXIT_MS)
        ? UPDATE_SMART_DIALOG_EXIT_MS
        : 200;

    return new Promise((resolve) => {
        aboutDialogCloseResolve = resolve;
        aboutDialogMotionTimer = setTimeout(() => {
            overlay.classList.remove('active', 'update-smart-entering', 'update-smart-closing');
            aboutDialogMotionTimer = null;
            if (typeof aboutDialogCloseResolve === 'function') {
                aboutDialogCloseResolve();
            }
            aboutDialogCloseResolve = null;
        }, exitDuration);
    });
}

function openAboutSmartDialog() {
    const { overlay, shell, closeBtn } = getAboutDialogElements();
    if (!overlay || !shell || !closeBtn) {
        return false;
    }

    if (aboutDialogMotionTimer) {
        clearTimeout(aboutDialogMotionTimer);
        aboutDialogMotionTimer = null;
        if (typeof aboutDialogCloseResolve === 'function') {
            aboutDialogCloseResolve();
            aboutDialogCloseResolve = null;
        }
    }

    if (aboutDialogKeyHandler) {
        document.removeEventListener('keydown', aboutDialogKeyHandler, true);
        aboutDialogKeyHandler = null;
    }

    overlay.classList.remove('update-smart-entering', 'update-smart-closing');
    overlay.classList.add('active');
    overlay.setAttribute('aria-hidden', 'false');

    closeBtn.onclick = () => {
        void closeAboutSmartDialog();
    };

    overlay.onclick = (event) => {
        if (event.target === overlay) {
            void closeAboutSmartDialog();
        }
    };

    aboutDialogKeyHandler = (event) => {
        if (event.key !== 'Escape') {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        void closeAboutSmartDialog();
    };
    document.addEventListener('keydown', aboutDialogKeyHandler, true);

    void overlay.offsetWidth;
    requestAnimationFrame(() => {
        overlay.classList.add('update-smart-entering');
        if (closeBtn) {
            closeBtn.focus({ preventScroll: true });
        } else {
            shell.focus({ preventScroll: true });
        }
    });

    return true;
}

// Show About Dialog
async function showAboutDialog() {
    if (!openAboutSmartDialog()) {
        return;
    }

    await loadAppVersionInfo();
    updateAboutRegistrationState();
    const electronVersionEl = document.getElementById('electron-version');
    const nodeVersionEl = document.getElementById('node-version');
    const platformInfoEl = document.getElementById('platform-info');

    // Populate version information
    if (process && process.versions) {
        if (electronVersionEl) {
            electronVersionEl.textContent = process.versions.electron || 'N/A';
        }
        if (nodeVersionEl) {
            nodeVersionEl.textContent = process.versions.node || 'N/A';
        }
    }

    // Platform information
    const platform = process.platform || 'unknown';
    const arch = process.arch || 'unknown';
    if (platformInfoEl) {
        platformInfoEl.textContent = `${platform} (${arch})`;
    }

    // Fetch additional system information from main process
    try {
        const systemInfo = await ipcRenderer.invoke('get-system-info');
        if (systemInfo?.platform && platformInfoEl) {
            platformInfoEl.textContent = `${systemInfo.platform} (${systemInfo.arch || 'unknown'})`;
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
        await closeAboutSmartDialog();
        const opened = await openDocumentationView('overview');
        if (!opened) {
            showNotification('Unable to open Documentation view right now.', 'warning');
        }
    });

    document.getElementById('open-license')?.addEventListener('click', () => {
        openConfiguredExternalLink('license', '', 'Opening license...');
    });

    document.getElementById('check-updates')?.addEventListener('click', async () => {
        await closeAboutSmartDialog();
        await checkForUpdatesInteractive();
    });

    document.getElementById('rollback-update')?.addEventListener('click', async () => {
        await closeAboutSmartDialog();
        await rollbackToStableInteractive();
    });
}

// ─── Report Issue Smart Dialog ───────────────────────────────────────────

let reportDialogMotionTimer = null;
let reportDialogKeyHandler = null;
let reportDialogCloseResolve = null;
let reportDropdownOpen = false;

function getReportDialogElements() {
    return {
        overlay: document.getElementById('report-issue-overlay'),
        shell: document.getElementById('report-issue-shell'),
        closeBtn: document.getElementById('report-issue-close')
    };
}

function closeReportDropdown() {
    const dropdown = document.getElementById('report-dropdown');
    if (dropdown) {
        dropdown.classList.remove('is-open');
    }
    reportDropdownOpen = false;
}

function selectReportCategory(value) {
    const hiddenInput = document.getElementById('report-category');
    const dropdown = document.getElementById('report-dropdown');
    const triggerEl = document.getElementById('report-dropdown-trigger');

    if (!hiddenInput || !dropdown || !triggerEl) {
        return;
    }

    hiddenInput.value = value;

    // Update selected state on items
    dropdown.querySelectorAll('.report-dropdown-item').forEach((item) => {
        item.classList.toggle('is-selected', item.dataset.value === value);
    });

    // Find the selected item and update trigger display
    const selectedItem = dropdown.querySelector(`.report-dropdown-item[data-value="${value}"]`);
    if (selectedItem) {
        const icon = selectedItem.querySelector('i');
        const label = selectedItem.querySelector('.report-dropdown-item-label');

        triggerEl.innerHTML = '';
        if (icon) {
            const iconClone = document.createElement('i');
            iconClone.className = icon.className;
            iconClone.classList.add('report-dropdown-selected-icon');
            triggerEl.appendChild(iconClone);
        }
        const textSpan = document.createElement('span');
        textSpan.className = 'report-dropdown-selected-text';
        textSpan.textContent = label ? label.textContent : value;
        triggerEl.appendChild(textSpan);
        const arrow = document.createElement('i');
        arrow.className = 'fas fa-chevron-down report-dropdown-arrow';
        triggerEl.appendChild(arrow);
    }

    closeReportDropdown();
    updateReportSubmitState();
}

function resetReportForm() {
    const hiddenInput = document.getElementById('report-category');
    const description = document.getElementById('report-description');
    const charCount = document.getElementById('report-char-current');
    const submitBtn = document.getElementById('report-submit');
    const form = document.getElementById('report-form-section');
    const actions = document.getElementById('report-actions-section');
    const success = document.getElementById('report-success');
    const dropdown = document.getElementById('report-dropdown');
    const triggerEl = document.getElementById('report-dropdown-trigger');

    if (hiddenInput) {
        hiddenInput.value = '';
    }

    if (description) {
        description.value = '';
    }

    if (charCount) {
        charCount.textContent = '0';
    }

    if (submitBtn) {
        submitBtn.disabled = true;
        const btnSpan = submitBtn.querySelector('span');
        const btnIcon = submitBtn.querySelector('i');
        if (btnSpan) {
            btnSpan.textContent = 'Send Report';
        }
        if (btnIcon) {
            btnIcon.className = 'fas fa-paper-plane';
        }
    }

    // Reset dropdown to placeholder state
    if (triggerEl) {
        triggerEl.innerHTML = '';
        const placeholder = document.createElement('span');
        placeholder.className = 'report-dropdown-placeholder';
        placeholder.id = 'report-dropdown-text';
        placeholder.textContent = 'Select a category...';
        triggerEl.appendChild(placeholder);
        const arrow = document.createElement('i');
        arrow.className = 'fas fa-chevron-down report-dropdown-arrow';
        triggerEl.appendChild(arrow);
    }

    if (dropdown) {
        dropdown.classList.remove('is-open');
        dropdown.querySelectorAll('.report-dropdown-item').forEach((item) => {
            item.classList.remove('is-selected');
        });
    }

    reportDropdownOpen = false;

    // Show form + actions, hide success (using classes, not hidden attribute)
    if (form) {
        form.classList.remove('is-hidden');
    }

    if (actions) {
        actions.classList.remove('is-hidden');
    }

    if (success) {
        success.classList.remove('is-visible');
    }
}

function closeReportSmartDialog() {
    const { overlay } = getReportDialogElements();

    if (!overlay) {
        return Promise.resolve();
    }

    closeReportDropdown();

    if (reportDialogKeyHandler) {
        document.removeEventListener('keydown', reportDialogKeyHandler, true);
        reportDialogKeyHandler = null;
    }

    overlay.onclick = null;

    if (reportDialogMotionTimer) {
        clearTimeout(reportDialogMotionTimer);
        reportDialogMotionTimer = null;
        if (typeof reportDialogCloseResolve === 'function') {
            reportDialogCloseResolve();
            reportDialogCloseResolve = null;
        }
    }

    if (!overlay.classList.contains('active')) {
        overlay.classList.remove('update-smart-entering', 'update-smart-closing');
        overlay.setAttribute('aria-hidden', 'true');
        if (typeof reportDialogCloseResolve === 'function') {
            reportDialogCloseResolve();
            reportDialogCloseResolve = null;
        }
        return Promise.resolve();
    }

    overlay.classList.remove('update-smart-entering');
    overlay.classList.add('update-smart-closing');
    overlay.setAttribute('aria-hidden', 'true');

    const exitDuration = Number.isFinite(UPDATE_SMART_DIALOG_EXIT_MS)
        ? UPDATE_SMART_DIALOG_EXIT_MS
        : 200;

    return new Promise((resolve) => {
        reportDialogCloseResolve = resolve;
        reportDialogMotionTimer = setTimeout(() => {
            overlay.classList.remove('active', 'update-smart-entering', 'update-smart-closing');
            reportDialogMotionTimer = null;
            if (typeof reportDialogCloseResolve === 'function') {
                reportDialogCloseResolve();
            }
            reportDialogCloseResolve = null;
        }, exitDuration);
    });
}

function openReportSmartDialog() {
    const { overlay, shell, closeBtn } = getReportDialogElements();
    if (!overlay || !shell || !closeBtn) {
        return false;
    }

    if (reportDialogMotionTimer) {
        clearTimeout(reportDialogMotionTimer);
        reportDialogMotionTimer = null;
        if (typeof reportDialogCloseResolve === 'function') {
            reportDialogCloseResolve();
            reportDialogCloseResolve = null;
        }
    }

    if (reportDialogKeyHandler) {
        document.removeEventListener('keydown', reportDialogKeyHandler, true);
        reportDialogKeyHandler = null;
    }

    resetReportForm();

    overlay.classList.remove('update-smart-entering', 'update-smart-closing');
    overlay.classList.add('active');
    overlay.setAttribute('aria-hidden', 'false');

    closeBtn.onclick = () => {
        void closeReportSmartDialog();
    };

    overlay.onclick = (event) => {
        if (event.target === overlay) {
            void closeReportSmartDialog();
        }
    };

    reportDialogKeyHandler = (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (reportDropdownOpen) {
                closeReportDropdown();
            } else {
                void closeReportSmartDialog();
            }
        }
    };
    document.addEventListener('keydown', reportDialogKeyHandler, true);

    void overlay.offsetWidth;
    requestAnimationFrame(() => {
        overlay.classList.add('update-smart-entering');
        const dropdown = document.getElementById('report-dropdown');
        if (dropdown) {
            dropdown.focus({ preventScroll: true });
        } else {
            shell.focus({ preventScroll: true });
        }
    });

    return true;
}

function updateReportSubmitState() {
    const hiddenInput = document.getElementById('report-category');
    const description = document.getElementById('report-description');
    const submitBtn = document.getElementById('report-submit');
    if (!hiddenInput || !description || !submitBtn) {
        return;
    }

    const hasCategory = Boolean(hiddenInput.value);
    const hasDescription = description.value.trim().length > 0;
    submitBtn.disabled = !(hasCategory && hasDescription);
}

async function submitIssueReport() {
    const hiddenInput = document.getElementById('report-category');
    const description = document.getElementById('report-description');
    const submitBtn = document.getElementById('report-submit');
    const form = document.getElementById('report-form-section');
    const actions = document.getElementById('report-actions-section');
    const success = document.getElementById('report-success');

    if (!hiddenInput || !description || !submitBtn) {
        return;
    }

    const categoryValue = hiddenInput.value;
    const descriptionValue = description.value.trim();

    if (!categoryValue || !descriptionValue) {
        return;
    }

    // Disable button and show sending state
    submitBtn.disabled = true;
    const btnSpan = submitBtn.querySelector('span');
    const btnIcon = submitBtn.querySelector('i');
    if (btnSpan) {
        btnSpan.textContent = 'Sending...';
    }
    if (btnIcon) {
        btnIcon.className = 'fas fa-circle-notch fa-spin';
    }

    try {
        const result = await ipcRenderer.invoke('submit-issue-report', {
            category: categoryValue,
            description: descriptionValue
        });

        if (result?.success) {
            // Transition to success state
            if (form) {
                form.classList.add('is-hidden');
            }
            if (actions) {
                actions.classList.add('is-hidden');
            }
            if (success) {
                success.classList.add('is-visible');
            }

            // Auto-close after a comfortable pause
            setTimeout(() => {
                void closeReportSmartDialog();
            }, 2200);
        } else {
            showNotification(result?.error || 'Failed to send report. Please try again.', 'error');
            submitBtn.disabled = false;
            if (btnSpan) {
                btnSpan.textContent = 'Send Report';
            }
            if (btnIcon) {
                btnIcon.className = 'fas fa-paper-plane';
            }
        }
    } catch {
        showNotification('Failed to send report. Please try again.', 'error');
        submitBtn.disabled = false;
        if (btnSpan) {
            btnSpan.textContent = 'Send Report';
        }
        if (btnIcon) {
            btnIcon.className = 'fas fa-paper-plane';
        }
    }
}

function initializeReportDialog() {
    const description = document.getElementById('report-description');
    const charCount = document.getElementById('report-char-current');
    const dropdown = document.getElementById('report-dropdown');
    const triggerEl = document.getElementById('report-dropdown-trigger');

    // Textarea character counter + validation
    if (description) {
        description.addEventListener('input', () => {
            if (charCount) {
                charCount.textContent = description.value.length;
            }
            updateReportSubmitState();
        });
    }

    // Custom dropdown toggle
    if (triggerEl && dropdown) {
        triggerEl.addEventListener('click', (e) => {
            e.stopPropagation();
            reportDropdownOpen = !reportDropdownOpen;
            dropdown.classList.toggle('is-open', reportDropdownOpen);
        });

        // Keyboard support on the dropdown wrapper
        dropdown.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (!reportDropdownOpen) {
                    reportDropdownOpen = true;
                    dropdown.classList.add('is-open');
                }
            }
        });
    }

    // Dropdown item selection
    document.getElementById('report-dropdown-menu')?.addEventListener('click', (e) => {
        const item = e.target.closest('.report-dropdown-item');
        if (item?.dataset.value) {
            selectReportCategory(item.dataset.value);
        }
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (reportDropdownOpen && !e.target.closest('#report-dropdown')) {
            closeReportDropdown();
        }
    });

    document.getElementById('report-cancel')?.addEventListener('click', () => {
        void closeReportSmartDialog();
    });

    document.getElementById('report-submit')?.addEventListener('click', () => {
        void submitIssueReport();
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

    // Keep ARIA labels in sync when the active view changes
    refreshSidebarAccessibilityLabels();

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
        aboutVersionEl.textContent = appVersionInfo.displayVersion;
    }

    const aboutReleaseChannelEl = document.getElementById('about-release-channel');
    if (aboutReleaseChannelEl) {
        const channel = typeof appVersionInfo.channel === 'string' && appVersionInfo.channel.trim()
            ? appVersionInfo.channel.trim().toLowerCase()
            : 'stable';
        const channelLabel = channel.charAt(0).toUpperCase() + channel.slice(1);
        aboutReleaseChannelEl.textContent = channelLabel;
        aboutReleaseChannelEl.dataset.channel = channel;
    }

    const statusVersionEl = document.getElementById('status-app-version');
    if (statusVersionEl) {
        statusVersionEl.textContent = appVersionInfo.displayVersion;
    }

    syncTitlebarUpdateControl();
}

const STATUS_MESSAGE_SEVERITIES = new Set(['neutral', 'info', 'success', 'warning', 'error', 'busy']);
const STATUS_MESSAGE_ICON_BY_SEVERITY = {
    neutral: 'fa-circle-dot',
    info: 'fa-circle-info',
    success: 'fa-circle-check',
    warning: 'fa-triangle-exclamation',
    error: 'fa-circle-xmark',
    busy: 'fa-arrows-rotate'
};
const STATUS_MESSAGE_CLASS_LIST = ['is-neutral', 'is-info', 'is-success', 'is-warning', 'is-error', 'is-busy'];
let statusBarRefreshTimer = null;
let statusBarClockTimer = null;
let statusBarUnloadCleanupBound = false;
const statusBarState = {
    currentView: 'Dashboard',
    projectName: 'No project selected',
    branchName: '--',
    connected: false,
    totalProjects: 0,
    recentProjects: 0,
    overrideMessage: '',
    overrideSeverity: 'info',
    overrideExpiresAt: 0
};

function sanitizeStatusSeverity(value) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : 'info';
    return STATUS_MESSAGE_SEVERITIES.has(normalized) ? normalized : 'info';
}

function inferStatusSeverityFromText(message) {
    const normalized = String(message || '').trim().toLowerCase();
    if (!normalized) {
        return 'info';
    }

    if (
        normalized.includes('error') ||
        normalized.includes('failed') ||
        normalized.includes('failure') ||
        normalized.includes('invalid')
    ) {
        return 'error';
    }

    if (
        normalized.includes('warning') ||
        normalized.includes('requires') ||
        normalized.includes('unable') ||
        normalized.includes('missing')
    ) {
        return 'warning';
    }

    if (
        normalized.includes('checking') ||
        normalized.includes('loading') ||
        normalized.includes('refresh') ||
        normalized.includes('download') ||
        normalized.includes('upload') ||
        normalized.includes('clon')
    ) {
        return 'busy';
    }

    if (
        normalized.includes('saved') ||
        normalized.includes('complete') ||
        normalized.includes('connected') ||
        normalized.includes('enabled')
    ) {
        return 'success';
    }

    return 'info';
}

function formatStatusTimeValue(dateValue = new Date()) {
    const resolvedDate = dateValue instanceof Date ? dateValue : new Date(dateValue);
    const fallback = '--:--';
    if (Number.isNaN(resolvedDate.getTime())) {
        return fallback;
    }

    let formatPreference = 'system';
    if (typeof normalizeSettings === 'function') {
        formatPreference = normalizeSettings(appSettings).statusTimeFormat || 'system';
    } else if (appSettings && typeof appSettings.statusTimeFormat === 'string') {
        formatPreference = appSettings.statusTimeFormat;
    }

    const options = {
        hour: '2-digit',
        minute: '2-digit'
    };

    if (formatPreference === '24h') {
        options.hour12 = false;
    } else if (formatPreference === '12h') {
        options.hour12 = true;
    }

    return resolvedDate.toLocaleTimeString([], options);
}

function updateStatusClockDisplay() {
    const timeEl = document.getElementById('status-time');
    if (!timeEl) {
        return;
    }

    const now = new Date();
    timeEl.textContent = formatStatusTimeValue(now);
    timeEl.title = now.toLocaleString();
}

function stopStatusClockTimer() {
    if (statusBarClockTimer) {
        clearInterval(statusBarClockTimer);
        statusBarClockTimer = null;
    }
}

function startStatusClockTimer() {
    stopStatusClockTimer();
    updateStatusClockDisplay();
    statusBarClockTimer = setInterval(() => {
        updateStatusClockDisplay();
    }, 1000);

    if (!statusBarUnloadCleanupBound) {
        statusBarUnloadCleanupBound = true;
        window.addEventListener('beforeunload', () => {
            stopStatusClockTimer();
            if (statusBarRefreshTimer) {
                clearTimeout(statusBarRefreshTimer);
                statusBarRefreshTimer = null;
            }
        }, { once: true });
    }
}

function getOperationQueueStatusMessage() {
    if (!Array.isArray(operationQueueJobs) || operationQueueJobs.length === 0) {
        return null;
    }

    const runningJobs = operationQueueJobs.filter((job) => job?.status === 'running');
    const queuedJobs = operationQueueJobs.filter((job) => job?.status === 'queued');

    if (runningJobs.length > 0) {
        const primaryJob = runningJobs[0];
        const primaryLabel = typeof getOperationQueueLabel === 'function'
            ? getOperationQueueLabel(primaryJob?.type)
            : 'Operation';
        const queuedSuffix = queuedJobs.length > 0 ? `, ${queuedJobs.length} queued` : '';
        const text = runningJobs.length === 1
            ? `${primaryLabel} running${queuedSuffix}`
            : `${runningJobs.length} operations running${queuedSuffix}`;
        return {
            text,
            severity: 'busy'
        };
    }

    if (queuedJobs.length > 0) {
        return {
            text: `${queuedJobs.length} operation${queuedJobs.length === 1 ? '' : 's'} queued`,
            severity: 'info'
        };
    }

    return null;
}

function resolveStatusMessageState() {
    const now = Date.now();
    if (statusBarState.overrideMessage && statusBarState.overrideExpiresAt > now) {
        return {
            text: statusBarState.overrideMessage,
            severity: sanitizeStatusSeverity(statusBarState.overrideSeverity)
        };
    }

    if (statusBarState.overrideMessage && statusBarState.overrideExpiresAt <= now) {
        statusBarState.overrideMessage = '';
        statusBarState.overrideExpiresAt = 0;
    }

    const queueStatus = getOperationQueueStatusMessage();
    if (queueStatus) {
        return queueStatus;
    }

    if (cloneSmartDialogInProgress) {
        return {
            text: 'Cloning repository...',
            severity: 'busy'
        };
    }

    if (githubUploadInProgress) {
        return {
            text: 'Uploading to GitHub...',
            severity: 'busy'
        };
    }

    if (updateState.checking) {
        return {
            text: 'Checking for updates...',
            severity: 'busy'
        };
    }

    if (updateState.error) {
        return {
            text: 'Update service error',
            severity: 'warning'
        };
    }

    if (updateState.downloaded) {
        return {
            text: 'Update ready to install',
            severity: 'success'
        };
    }

    const downloadProgress = Number(updateState.downloadProgress);
    if (updateState.backgroundDownloadActive && Number.isFinite(downloadProgress) && downloadProgress > 0 && downloadProgress < 100) {
        return {
            text: `Downloading in background ${Math.round(downloadProgress)}%`,
            severity: 'busy'
        };
    }

    if (updateState.available && Number.isFinite(downloadProgress) && downloadProgress > 0 && downloadProgress < 100) {
        return {
            text: `Downloading update ${Math.round(downloadProgress)}%`,
            severity: 'busy'
        };
    }

    if (updateState.available) {
        const availableVersion = typeof updateState.latestVersion === 'string' && updateState.latestVersion.trim()
            ? updateState.latestVersion.trim()
            : 'latest';
        return {
            text: `Update ${availableVersion} available`,
            severity: 'info'
        };
    }

    if (!workspacePath) {
        return {
            text: 'Choose a workspace to begin',
            severity: 'warning'
        };
    }

    if (currentView === 'git' && (!currentProject || !currentProject.path)) {
        return {
            text: 'Select a repository to manage',
            severity: 'warning'
        };
    }

    if (currentProject && statusBarState.branchName === '--' && currentView === 'git') {
        return {
            text: 'Git repository not initialized',
            severity: 'info'
        };
    }

    if (statusBarState.totalProjects <= 0) {
        return {
            text: 'No projects found in workspace',
            severity: 'info'
        };
    }

    if (!statusBarState.connected && currentView === 'git') {
        return {
            text: 'GitHub account not connected',
            severity: 'info'
        };
    }

    return {
        text: 'Ready',
        severity: 'neutral'
    };
}

function applyStatusMessageState(messageState) {
    const messageEl = document.getElementById('status-message');
    const messageIconEl = document.getElementById('status-message-icon');
    const messageItemEl = document.querySelector('.status-item-message');
    if (!messageEl || !messageIconEl || !messageItemEl) {
        return;
    }

    const safeText = typeof messageState?.text === 'string' && messageState.text.trim()
        ? messageState.text.trim()
        : 'Ready';
    const safeSeverity = sanitizeStatusSeverity(messageState?.severity || 'neutral');

    messageEl.textContent = safeText;
    messageItemEl.title = safeText;
    messageItemEl.classList.remove(...STATUS_MESSAGE_CLASS_LIST);
    messageItemEl.classList.add(`is-${safeSeverity}`);

    const iconClass = STATUS_MESSAGE_ICON_BY_SEVERITY[safeSeverity] || STATUS_MESSAGE_ICON_BY_SEVERITY.info;
    messageIconEl.className = `fas ${iconClass}`;
    messageIconEl.classList.toggle('status-spin', safeSeverity === 'busy');
}

function renderStatusUpdateProgressIndicator() {
    const progressItemEl = document.getElementById('status-update-progress');
    const progressTextEl = document.getElementById('status-update-progress-text');
    const progressBarEl = document.getElementById('status-update-progress-bar');
    if (!progressItemEl || !progressTextEl || !progressBarEl) {
        return;
    }

    const rawProgress = Number(updateState.downloadProgress);
    const clampedProgress = Number.isFinite(rawProgress) ? Math.max(0, Math.min(100, rawProgress)) : 0;
    const roundedProgress = Math.round(clampedProgress);
    const dialogContext = typeof getActiveUpdateSmartDialogContext === 'function'
        ? getActiveUpdateSmartDialogContext()
        : '';
    const dialogVisible = typeof isUpdateSmartDialogActive === 'function'
        ? isUpdateSmartDialogActive()
        : false;
    const dialogShowingDownload = dialogVisible && (dialogContext === 'download' || dialogContext === 'download-test');
    const shouldShow = updateState.backgroundDownloadActive === true
        && Number.isFinite(rawProgress)
        && rawProgress > 0
        && rawProgress < 100
        && !dialogShowingDownload;

    progressItemEl.hidden = !shouldShow;
    progressItemEl.classList.toggle('is-active', shouldShow);

    if (!shouldShow) {
        progressTextEl.textContent = 'Downloading update 0%';
        progressBarEl.style.width = '0%';
        progressItemEl.title = 'Background update download progress';
        return;
    }

    const progressText = `Downloading update ${roundedProgress}%`;
    progressTextEl.textContent = progressText;
    progressBarEl.style.width = `${clampedProgress}%`;
    progressItemEl.title = progressText;
}

function renderStatusBarState() {
    const workspaceEl = document.getElementById('workspace-path');
    const viewEl = document.getElementById('status-current-view');
    const projectNameEl = document.getElementById('status-project-name');
    const branchEl = document.getElementById('status-git-branch');
    const branchItemEl = document.querySelector('.status-item-branch');
    const connectionEl = document.getElementById('status-connection');
    const connectionDotEl = document.getElementById('status-connection-dot');
    const connectionItemEl = document.querySelector('.status-item-connection');
    const totalProjectsEl = document.getElementById('status-project-count');
    const recentCountEl = document.getElementById('status-recent-count');

    const workspaceLabel = workspacePath || 'No workspace selected';
    if (workspaceEl) {
        workspaceEl.textContent = workspaceLabel;
        workspaceEl.title = workspaceLabel;
    }

    if (viewEl) {
        viewEl.textContent = statusBarState.currentView || 'Dashboard';
    }

    if (projectNameEl) {
        projectNameEl.textContent = statusBarState.projectName || 'No project selected';
    }

    const branchName = statusBarState.branchName || '--';
    if (branchEl) {
        branchEl.textContent = branchName;
    }
    if (branchItemEl) {
        branchItemEl.classList.toggle('status-branch-empty', !branchName || branchName === '--');
    }

    if (connectionEl) {
        connectionEl.textContent = statusBarState.connected ? 'Connected' : 'Disconnected';
    }
    if (connectionDotEl) {
        connectionDotEl.classList.toggle('status-online', statusBarState.connected);
        connectionDotEl.classList.toggle('status-offline', !statusBarState.connected);
    }
    if (connectionItemEl) {
        connectionItemEl.classList.toggle('status-connected', statusBarState.connected);
        connectionItemEl.classList.toggle('status-disconnected', !statusBarState.connected);
    }

    if (totalProjectsEl) {
        totalProjectsEl.textContent = String(statusBarState.totalProjects);
    }

    if (recentCountEl) {
        recentCountEl.textContent = String(statusBarState.recentProjects);
    }

    updateStatusClockDisplay();
    applyStatusMessageState(resolveStatusMessageState());
    renderStatusUpdateProgressIndicator();
}

function scheduleStatusBarRefresh(options = {}) {
    const immediate = options.immediate === true;
    if (immediate) {
        if (statusBarRefreshTimer) {
            clearTimeout(statusBarRefreshTimer);
            statusBarRefreshTimer = null;
        }
        renderStatusBarState();
        return;
    }

    if (statusBarRefreshTimer) {
        return;
    }

    statusBarRefreshTimer = setTimeout(() => {
        statusBarRefreshTimer = null;
        renderStatusBarState();
    }, 90);
}

function setStatusTransientMessage(message, options = {}) {
    const safeMessage = String(message || '').trim();
    if (!safeMessage) {
        return;
    }

    const requestedDuration = Number(options.durationMs);
    const durationMs = Number.isFinite(requestedDuration)
        ? Math.max(800, Math.min(20000, Math.round(requestedDuration)))
        : 3000;

    statusBarState.overrideMessage = safeMessage;
    statusBarState.overrideSeverity = sanitizeStatusSeverity(options.severity || inferStatusSeverityFromText(safeMessage));
    statusBarState.overrideExpiresAt = Date.now() + durationMs;

    if (statusMessageTimeout) {
        clearTimeout(statusMessageTimeout);
    }

    statusMessageTimeout = setTimeout(() => {
        statusBarState.overrideMessage = '';
        statusBarState.overrideExpiresAt = 0;
        statusMessageTimeout = null;
        scheduleStatusBarRefresh({ immediate: true });
    }, durationMs);

    scheduleStatusBarRefresh({ immediate: true });
}

function setStatusCurrentView(viewLabel) {
    statusBarState.currentView = viewLabel || 'Dashboard';
    scheduleStatusBarRefresh();
}

function setStatusProjectName(projectName) {
    statusBarState.projectName = projectName || 'No project selected';
    scheduleStatusBarRefresh();
}

function setStatusGitBranch(branchName) {
    statusBarState.branchName = branchName || '--';
    scheduleStatusBarRefresh();
}

function setStatusConnectionState(isConnected) {
    statusBarState.connected = Boolean(isConnected);
    scheduleStatusBarRefresh();
}

function updateStatusProjectCounts(totalProjects, recentCount = recentProjects.length) {
    const heroRecentEl = document.getElementById('hero-recent');
    const safeTotalProjects = Number.isFinite(Number(totalProjects)) ? Math.max(0, Number(totalProjects)) : 0;
    const safeRecentProjects = Number.isFinite(Number(recentCount)) ? Math.max(0, Number(recentCount)) : 0;

    statusBarState.totalProjects = safeTotalProjects;
    statusBarState.recentProjects = safeRecentProjects;

    if (heroRecentEl) {
        heroRecentEl.textContent = String(safeRecentProjects);
    }

    scheduleStatusBarRefresh();
}

function initializeStatusBar() {
    statusBarState.currentView = getViewLabel(currentView);
    statusBarState.projectName = currentProject ? currentProject.name : 'No project selected';
    statusBarState.branchName = currentProject ? 'main' : '--';
    statusBarState.connected = Boolean(githubUserData);
    statusBarState.totalProjects = document.querySelectorAll('#all-projects-list .project-card-modern').length;
    statusBarState.recentProjects = Array.isArray(recentProjects) ? recentProjects.length : 0;
    const heroRecentEl = document.getElementById('hero-recent');
    if (heroRecentEl) {
        heroRecentEl.textContent = String(statusBarState.recentProjects);
    }

    startStatusClockTimer();
    applyAppVersionDisplays();
    scheduleStatusBarRefresh({ immediate: true });
    void refreshStatusBranch();
}

function refreshStatusBar(options = {}) {
    const { refreshBranch = true, immediate = false } = options;
    statusBarState.currentView = getViewLabel(currentView);
    statusBarState.projectName = currentProject ? currentProject.name : 'No project selected';
    statusBarState.connected = Boolean(githubUserData);
    statusBarState.totalProjects = document.querySelectorAll('#all-projects-list .project-card-modern').length;
    statusBarState.recentProjects = Array.isArray(recentProjects) ? recentProjects.length : 0;
    const heroRecentEl = document.getElementById('hero-recent');
    if (heroRecentEl) {
        heroRecentEl.textContent = String(statusBarState.recentProjects);
    }

    scheduleStatusBarRefresh({ immediate });
    if (refreshBranch) {
        void refreshStatusBranch();
    }
}

// Settings functionality
/* ────────────────────────────────────────
   Custom Dropdown — replaces native <select>
   ──────────────────────────────────────── */
