/* Runtime module: extensions/00-extensions-catalog-and-settings.js */
function markExtensionsCacheDirty() {
    extensionsCacheDirty = true;
}

function syncInstalledExtensionCache(extId, patch = {}) {
    if (!extId || !patch || typeof patch !== 'object') {
        return;
    }

    const target = installedExtensionsCache.find((extension) => extension?.id === extId);
    if (!target) {
        return;
    }

    Object.assign(target, patch);
}

function initializeExtensions() {
    if (!extensionsEventBridgeInstalled) {
        extensionsEventBridgeInstalled = true;

        const refreshExtensionData = () => {
            markExtensionsCacheDirty();
            if (currentView === 'extensions' || currentView === 'settings') {
                void loadInstalledExtensions({ force: true });
            }
        };

        ipcRenderer.on('extension-installed', refreshExtensionData);
        ipcRenderer.on('extension-uninstalled', refreshExtensionData);
        ipcRenderer.on('extension-enabled', refreshExtensionData);
        ipcRenderer.on('extension-disabled', refreshExtensionData);
    }

    // Pill tabs
    document.querySelectorAll('.ext-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.ext-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.ext-tab-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            const content = document.getElementById(`ext-${tab.dataset.extTab}`);
            if (content) content.classList.add('active');

            // Load themes tab content on first click
            if (tab.dataset.extTab === 'themes') {
                renderThemesTab();
            }
            if (tab.dataset.extTab === 'marketplace') {
                renderMarketplaceTab();
            }
        });
    });

    // Search with debounce
    let searchTimeout;
    const searchInput = document.getElementById('extension-search');
    const searchClear = document.getElementById('ext-search-clear');

    searchInput?.addEventListener('input', (e) => {
        currentExtSearch = e.target.value;
        searchClear.style.display = currentExtSearch ? 'flex' : 'none';
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => filterAndRenderActiveTab(), 150);
    });

    searchClear?.addEventListener('click', () => {
        searchInput.value = '';
        currentExtSearch = '';
        searchClear.style.display = 'none';
        filterAndRenderActiveTab();
    });

    // Sort select
    document.getElementById('ext-sort')?.addEventListener('change', (e) => {
        currentExtSort = e.target.value;
        filterAndRenderActiveTab();
    });

    // View toggle
    document.querySelectorAll('.ext-view-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.ext-view-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentExtViewMode = btn.dataset.view;
            document.querySelectorAll('.ext-cards-container').forEach(c => {
                c.classList.remove('grid-view', 'list-view');
                c.classList.add(`${currentExtViewMode}-view`);
            });
            try { localStorage.setItem('ext-view-mode', currentExtViewMode); } catch(e) {}
        });
    });

    // Restore view mode
    try {
        const saved = localStorage.getItem('ext-view-mode');
        if (saved === 'list' || saved === 'grid') {
            currentExtViewMode = saved;
            document.querySelectorAll('.ext-view-btn').forEach(b => {
                b.classList.toggle('active', b.dataset.view === currentExtViewMode);
            });
        }
    } catch(e) {}

    // Filter pills
    document.querySelectorAll('.ext-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            document.querySelectorAll('.ext-pill').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            currentExtFilter = pill.dataset.filter;
            filterAndRenderActiveTab();
        });
    });

    // Category cards
    document.querySelectorAll('.ext-category-card').forEach(card => {
        card.addEventListener('click', () => {
            const cat = card.dataset.category;
            // Switch to marketplace tab with that filter
            document.querySelectorAll('.ext-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.ext-tab-content').forEach(c => c.classList.remove('active'));
            const mpTab = document.querySelector('[data-ext-tab="marketplace"]');
            mpTab?.classList.add('active');
            document.getElementById('ext-marketplace')?.classList.add('active');
            // Set filter
            currentExtFilter = cat;
            document.querySelectorAll('.ext-pill').forEach(p => {
                p.classList.toggle('active', p.dataset.filter === cat);
            });
            renderMarketplaceTab();
        });
    });

    // Refresh
    document.getElementById('refresh-extensions')?.addEventListener('click', () => {
        refreshExtensions();
    });

    // Detail panel close
    document.getElementById('ext-detail-close')?.addEventListener('click', closeExtensionDetail);
    document.getElementById('ext-detail-backdrop')?.addEventListener('click', closeExtensionDetail);

    // Featured install button
    document.querySelector('.ext-featured-install')?.addEventListener('click', (e) => {
        const extId = e.currentTarget.dataset.extId;
        const ext = MARKETPLACE_EXTENSIONS.find(x => x.id === extId);
        if (ext) installMarketplaceExtension(ext);
    });

    // Load initial data
    void loadInstalledExtensions({ force: false });
    updateExtensionStats();
}

// Filter and re-render the currently active tab
function filterAndRenderActiveTab() {
    const activeTab = document.querySelector('.ext-tab.active');
    if (!activeTab) return;
    const tab = activeTab.dataset.extTab;
    if (tab === 'installed') renderInstalledCards();
    else if (tab === 'marketplace') renderMarketplaceTab();
}

// Format download numbers
function formatDownloads(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return String(num);
}

// Render star rating HTML
function renderStarRating(rating) {
    let html = '';
    for (let i = 1; i <= 5; i++) {
        if (rating >= i) html += '<i class="fas fa-star"></i>';
        else if (rating >= i - 0.5) html += '<i class="fas fa-star-half-alt"></i>';
        else html += '<i class="far fa-star"></i>';
    }
    return html;
}

// Get category gradient class
function getCategoryClass(category) {
    const map = {
        'themes': 'cat-themes', 'languages': 'cat-languages', 'snippets': 'cat-snippets',
        'linters': 'cat-linters', 'debuggers': 'cat-debuggers', 'productivity': 'cat-productivity',
        'formatters': 'cat-formatters', 'general': 'cat-general'
    };
    return map[category] || 'cat-general';
}

// Get icon for extension category
function getCategoryIcon(category) {
    const icons = {
        'themes': 'fa-palette', 'languages': 'fa-code', 'snippets': 'fa-file-code',
        'linters': 'fa-check-circle', 'debuggers': 'fa-bug', 'productivity': 'fa-rocket',
        'formatters': 'fa-align-left', 'general': 'fa-puzzle-piece'
    };
    return icons[category] || 'fa-puzzle-piece';
}

// Sort extensions array
function sortExtensions(exts) {
    const sorted = [...exts];
    switch (currentExtSort) {
        case 'popular':
            sorted.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
            break;
        case 'rating':
            sorted.sort((a, b) => (b.rating || 0) - (a.rating || 0));
            break;
        case 'newest':
            sorted.sort((a, b) => {
                const versionCompare = compareVersionDescending(a.version, b.version);
                if (versionCompare !== 0) {
                    return versionCompare;
                }
                return (a.displayName || a.name || '').localeCompare(b.displayName || b.name || '');
            });
            break;
        case 'name':
            sorted.sort((a, b) => (a.displayName || a.name || '').localeCompare(b.displayName || b.name || ''));
            break;
    }
    return sorted;
}

// Filter extensions by search + category
function filterExtensions(exts) {
    let filtered = exts;
    if (currentExtFilter && currentExtFilter !== 'all') {
        filtered = filtered.filter(e => e.category === currentExtFilter || e.type === currentExtFilter);
    }
    if (currentExtSearch) {
        const q = currentExtSearch.toLowerCase();
        filtered = filtered.filter(e => {
            const name = (e.displayName || e.name || '').toLowerCase();
            const desc = (e.description || '').toLowerCase();
            const author = (e.author || '').toLowerCase();
            return name.includes(q) || desc.includes(q) || author.includes(q);
        });
    }
    return filtered;
}

// Create extension card DOM element
function createExtensionCard(extension) {
    const card = document.createElement('div');
    card.className = 'ext-card';
    card.dataset.extensionId = extension.id;
    card.dataset.type = extension.type || 'installed';
    card.dataset.category = extension.category || 'general';

    const safeName = escapeHtml(extension.displayName || extension.name || 'Unnamed');
    const safeDesc = escapeHtml(extension.description || 'No description available');
    const safeVersion = escapeHtml(extension.version || '1.0.0');
    const safeAuthor = escapeHtml(extension.author || 'Unknown');
    const catClass = getCategoryClass(extension.category);
    const iconClass = getCategoryIcon(extension.category);
    const isInstalled = extension.type === 'installed' || extension.type === 'themes' || extension.type === 'theme' || installedExtensionsCache.some(e => e.id === extension.id);
    const rating = extension.rating || 0;
    const downloads = extension.downloads || 0;

    let actionsHTML = '';
    if (isInstalled && extension.type !== 'marketplace') {
        actionsHTML = `
            <label class="ext-toggle" title="${extension.enabled ? 'Disable' : 'Enable'}">
                <input type="checkbox" ${extension.enabled ? 'checked' : ''} data-toggle-ext="${extension.id}">
                <span class="ext-toggle-slider"></span>
            </label>
            <button class="ext-btn ext-btn-danger" data-action="uninstall" data-ext-id="${extension.id}" title="Uninstall">
                <i class="fas fa-trash"></i>
            </button>
        `;
    } else {
        actionsHTML = `
            <button class="ext-btn ext-btn-primary" data-action="install" data-ext-id="${extension.id}">
                <i class="fas fa-download"></i> Install
            </button>
        `;
    }

    card.innerHTML = `
        <div class="ext-card-header">
            <div class="ext-card-icon ${catClass}">
                <i class="fas ${iconClass}"></i>
            </div>
            <div class="ext-card-title-row">
                <h4 class="ext-card-name">${safeName}</h4>
                <p class="ext-card-author">${safeAuthor}</p>
            </div>
            <div class="ext-card-actions">
                ${actionsHTML}
            </div>
        </div>
        <p class="ext-card-desc">${safeDesc}</p>
        <div class="ext-card-footer">
            <div class="ext-card-meta">
                <span class="ext-meta-version"><i class="fas fa-tag"></i> v${safeVersion}</span>
                ${downloads ? `<span><i class="fas fa-download"></i> ${formatDownloads(downloads)}</span>` : ''}
            </div>
            ${rating ? `<div class="ext-card-rating">${renderStarRating(rating)}<span>${rating}</span></div>` : ''}
        </div>
    `;

    // Toggle switch event
    const toggle = card.querySelector('[data-toggle-ext]');
    if (toggle) {
        toggle.addEventListener('change', async (e) => {
            e.stopPropagation();
            const extId = e.target.dataset.toggleExt;
            const enable = e.target.checked;
            const result = enable
                ? await ipcRenderer.invoke('enable-extension', extId)
                : await ipcRenderer.invoke('disable-extension', extId);
            if (result.success) {
                syncInstalledExtensionCache(extId, { enabled: enable });
                showNotification(`${safeName} ${enable ? 'enabled' : 'disabled'}`, 'success');
                updateExtensionStats();
                renderSettingsExtensionsList();
            } else {
                e.target.checked = !enable; // revert
                showNotification(`Failed: ${result.error}`, 'error');
            }
        });
    }

    // Uninstall button
    const uninstallBtn = card.querySelector('[data-action="uninstall"]');
    if (uninstallBtn) {
        uninstallBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const extId = e.currentTarget.dataset.extId;
            if (confirm(`Are you sure you want to uninstall ${safeName}?`)) {
                const result = await ipcRenderer.invoke('uninstall-extension', extId);
                if (result.success) {
                    card.style.transition = 'all 0.3s ease';
                    card.style.opacity = '0';
                    card.style.transform = 'scale(0.95)';
                    setTimeout(() => {
                        card.remove();
                        markExtensionsCacheDirty();
                        showNotification(`${safeName} uninstalled`, 'success');
                        void loadInstalledExtensions({ force: true });
                    }, 300);
                } else {
                    showNotification(`Failed: ${result.error}`, 'error');
                }
            }
        });
    }

    // Install button
    const installBtn = card.querySelector('[data-action="install"]');
    if (installBtn) {
        installBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await installMarketplaceExtension(extension, installBtn);
        });
    }

    // Card click → open detail panel
    card.addEventListener('click', (e) => {
        if (e.target.closest('.ext-toggle') || e.target.closest('.ext-btn')) return;
        openExtensionDetail(extension);
    });

    return card;
}

// Install a marketplace extension
async function installMarketplaceExtension(ext, btn) {
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Installing...';
    }

    const isTheme = ext.installType === 'themes' || ext.category === 'themes';
    const installType = isTheme ? 'themes' : 'installed';

    const manifest = {
        name: ext.id,
        displayName: ext.displayName || ext.name,
        version: ext.version || '1.0.0',
        description: ext.description || '',
        publisher: ext.author || 'Marketplace',
        category: ext.category || 'general',
        rating: ext.rating,
        downloads: ext.downloads
    };

    const files = {
        'manifest.json': JSON.stringify(manifest, null, 2)
    };

    // Theme extensions: include the CSS file and theme metadata
    if (isTheme && ext.themeCSS) {
        manifest.main = 'theme.css';
        manifest.colors = ext.preview?.palette || [];
        manifest.preview = ext.preview || {};
        files['manifest.json'] = JSON.stringify(manifest, null, 2);
        files['theme.css'] = ext.themeCSS;
    }

    // Non-theme extensions: store settings schema so we can render settings later
    if (ext.settings) {
        manifest.settingsSchema = ext.settings;
        files['manifest.json'] = JSON.stringify(manifest, null, 2);
    }

    const extensionData = {
        id: ext.id,
        name: ext.displayName || ext.name,
        type: installType,
        files: files
    };

    const result = await ipcRenderer.invoke('install-extension', extensionData);

    if (result.success) {
        if (btn) btn.innerHTML = '<i class="fas fa-check"></i> Installed';
        showNotification(`${ext.displayName || ext.name} installed`, 'success');

        // Reload extensions and refresh theme dropdowns
        markExtensionsCacheDirty();
        await loadInstalledExtensions({ force: true });

        if (isTheme) {
            // Refresh theme list in settings dropdown
            await loadThemeExtensions();
        }

        // Refresh the settings extensions panel if it exists
        renderSettingsExtensionsList();
    } else {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-download"></i> Install';
        }
        showNotification(`Failed: ${result.error}`, 'error');
    }
}

// Render installed extension cards
function renderInstalledCards() {
    const container = document.getElementById('ext-installed-cards');
    const emptyState = document.getElementById('ext-empty-installed');
    if (!container) return;

    let exts = filterExtensions(installedExtensionsCache);
    exts = sortExtensions(exts);

    container.innerHTML = '';
    container.classList.remove('grid-view', 'list-view');
    container.classList.add(`${currentExtViewMode}-view`);

    if (exts.length === 0) {
        container.style.display = 'none';
        if (emptyState) {
            emptyState.style.display = 'block';
            emptyState.querySelector('h3').textContent = currentExtSearch ? 'No extensions found' : 'No extensions installed';
            emptyState.querySelector('p').textContent = currentExtSearch ? 'Try a different search term' : 'Browse the marketplace to discover and install extensions';
        }
        return;
    }

    container.style.display = '';
    if (emptyState) emptyState.style.display = 'none';

    const fragment = document.createDocumentFragment();
    exts.forEach((ext) => {
        fragment.appendChild(createExtensionCard(ext));
    });
    container.appendChild(fragment);
}

// Render marketplace tab
function renderMarketplaceTab() {
    const container = document.getElementById('ext-marketplace-cards');
    if (!container) return;

    let exts = filterExtensions(MARKETPLACE_EXTENSIONS);
    exts = sortExtensions(exts);

    container.innerHTML = '';
    container.classList.remove('grid-view', 'list-view');
    container.classList.add(`${currentExtViewMode}-view`);

    const fragment = document.createDocumentFragment();
    exts.forEach((ext) => {
        fragment.appendChild(createExtensionCard(ext));
    });
    container.appendChild(fragment);
}

// Render themes tab (inline, not modal)
function renderThemesTab() {
    const grid = document.getElementById('ext-themes-grid');
    if (!grid) return;

    // Combine themes from THEME_MARKETPLACE (external file) and MARKETPLACE_EXTENSIONS (inline themes)
    const oldThemes = (typeof THEME_MARKETPLACE !== 'undefined') ? THEME_MARKETPLACE : [];
    const newThemes = MARKETPLACE_EXTENSIONS.filter(e => e.category === 'themes' && e.preview);

    // Build a unified list, deduplicating by id
    const seenIds = new Set();
    const allThemes = [];

    // New inline marketplace themes first (they have themeCSS)
    for (const t of newThemes) {
        if (!seenIds.has(t.id)) {
            seenIds.add(t.id);
            allThemes.push({
                id: t.id, displayName: t.displayName, description: t.description,
                author: t.author, version: t.version, rating: t.rating, downloads: t.downloads,
                preview: t.preview, tags: t.tags || [], css: t.themeCSS,
                source: 'marketplace' // installed via installMarketplaceExtension
            });
        }
    }

    // Old THEME_MARKETPLACE themes
    for (const t of oldThemes) {
        if (!seenIds.has(t.id)) {
            seenIds.add(t.id);
            allThemes.push({
                id: t.id, displayName: t.displayName, description: t.description,
                author: t.author, version: t.version, rating: t.rating, downloads: t.downloads,
                preview: t.preview, tags: t.tags || [], css: t.css,
                source: 'legacy' // installed via downloadMarketplaceTheme
            });
        }
    }

    if (allThemes.length === 0) return;

    // Check which are already installed
    const installedIds = new Set(installedExtensionsCache.map(e => e.id));

    grid.innerHTML = allThemes.map((theme) => {
        const stars = renderStarRating(theme.rating);
        const isInstalled = installedIds.has(theme.id);
        return `
            <div class="ext-theme-card" data-theme-id="${theme.id}">
                <div class="ext-theme-preview" style="background: ${theme.preview.background};">
                    <div class="ext-theme-palette">
                        ${theme.preview.palette.map(c => `<div class="ext-theme-swatch" style="background:${c};"></div>`).join('')}
                    </div>
                </div>
                <div class="ext-theme-info">
                    <h3 class="ext-theme-name">${escapeHtml(theme.displayName)}</h3>
                    <p class="ext-theme-desc">${escapeHtml(theme.description)}</p>
                </div>
                <div class="ext-theme-tags">
                    ${(theme.tags || []).slice(0, 3).map(t => `<span class="ext-theme-tag">${t}</span>`).join('')}
                </div>
                <div class="ext-theme-footer">
                    <div class="ext-theme-stats">
                        <span><span class="ext-star-color">${stars}</span> ${theme.rating}</span>
                        <span><i class="fas fa-download"></i> ${formatDownloads(theme.downloads)}</span>
                    </div>
                    <button class="ext-theme-install-btn${isInstalled ? ' installed' : ''}" data-theme-install="${theme.id}" data-theme-source="${theme.source}" ${isInstalled ? 'disabled' : ''}>
                        <i class="fas fa-${isInstalled ? 'check' : 'download'}"></i> ${isInstalled ? 'Installed' : 'Install'}
                    </button>
                </div>
            </div>
        `;
    }).join('');

    // Attach install handlers
    grid.querySelectorAll('[data-theme-install]:not([disabled])').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const themeId = e.currentTarget.dataset.themeInstall;
            const source = e.currentTarget.dataset.themeSource;

            e.currentTarget.disabled = true;
            e.currentTarget.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

            let success = false;
            if (source === 'marketplace') {
                // Install via new flow (writes theme.css + manifest)
                const ext = MARKETPLACE_EXTENSIONS.find(x => x.id === themeId);
                if (ext) {
                    await installMarketplaceExtension(ext, null);
                    success = true;
                }
            } else {
                // Legacy flow
                const theme = oldThemes.find(t => t.id === themeId);
                if (theme) {
                    success = await downloadMarketplaceTheme(theme);
                }
            }

            if (success) {
                e.currentTarget.innerHTML = '<i class="fas fa-check"></i> Installed';
                // Refresh the themes grid to update installed state
                await loadThemeExtensions();
                renderSettingsExtensionsList();
            } else {
                e.currentTarget.disabled = false;
                e.currentTarget.innerHTML = '<i class="fas fa-download"></i> Install';
            }
        });
    });
}

// Open extension detail panel
function openExtensionDetail(ext) {
    const panel = document.getElementById('ext-detail-panel');
    const backdrop = document.getElementById('ext-detail-backdrop');
    if (!panel || !backdrop) return;

    const safeName = escapeHtml(ext.displayName || ext.name || 'Extension');
    const safeAuthor = escapeHtml(ext.author || 'Unknown');
    const safeDesc = escapeHtml(ext.description || 'No description available');
    const catClass = getCategoryClass(ext.category);
    const iconClass = getCategoryIcon(ext.category);

    // Populate
    const iconEl = document.getElementById('ext-detail-icon');
    iconEl.className = `ext-detail-icon ${catClass}`;
    iconEl.innerHTML = `<i class="fas ${iconClass}"></i>`;

    document.getElementById('ext-detail-name').textContent = safeName;
    document.getElementById('ext-detail-author').textContent = `by ${safeAuthor}`;
    document.getElementById('ext-detail-rating').innerHTML = ext.rating ? renderStarRating(ext.rating) : '';
    document.getElementById('ext-detail-version').textContent = `v${ext.version || '1.0.0'}`;
    document.getElementById('ext-detail-downloads').textContent = formatDownloads(ext.downloads || 0);
    document.getElementById('ext-detail-category').textContent = (ext.category || 'general').charAt(0).toUpperCase() + (ext.category || 'general').slice(1);
    document.getElementById('ext-detail-description').textContent = safeDesc;

    // Actions
    const actionsEl = document.getElementById('ext-detail-actions');
    const isInstalled = ext.type === 'installed' || ext.type === 'themes' || ext.type === 'theme' || installedExtensionsCache.some(e => e.id === ext.id);

    if (isInstalled) {
        actionsEl.innerHTML = `
            <button class="ext-btn ext-btn-primary" id="ext-detail-toggle-btn">
                <i class="fas fa-${ext.enabled ? 'pause' : 'play'}"></i> ${ext.enabled ? 'Disable' : 'Enable'}
            </button>
            <button class="ext-btn ext-btn-danger" id="ext-detail-uninstall-btn">
                <i class="fas fa-trash"></i> Uninstall
            </button>
        `;
        document.getElementById('ext-detail-toggle-btn')?.addEventListener('click', async () => {
            const result = ext.enabled
                ? await ipcRenderer.invoke('disable-extension', ext.id)
                : await ipcRenderer.invoke('enable-extension', ext.id);
            if (result.success) {
                syncInstalledExtensionCache(ext.id, { enabled: !ext.enabled });
                showNotification(`${safeName} ${ext.enabled ? 'disabled' : 'enabled'}`, 'success');
                closeExtensionDetail();
                void loadInstalledExtensions({ force: true });
            } else {
                showNotification(`Failed: ${result.error}`, 'error');
            }
        });
        document.getElementById('ext-detail-uninstall-btn')?.addEventListener('click', async () => {
            if (confirm(`Uninstall ${safeName}?`)) {
                const result = await ipcRenderer.invoke('uninstall-extension', ext.id);
                if (result.success) {
                    markExtensionsCacheDirty();
                    showNotification(`${safeName} uninstalled`, 'success');
                    closeExtensionDetail();
                    void loadInstalledExtensions({ force: true });
                } else {
                    showNotification(`Failed: ${result.error}`, 'error');
                }
            }
        });
    } else {
        actionsEl.innerHTML = `
            <button class="ext-btn ext-btn-primary" id="ext-detail-install-btn">
                <i class="fas fa-download"></i> Install Extension
            </button>
        `;
        document.getElementById('ext-detail-install-btn')?.addEventListener('click', async () => {
            const btn = document.getElementById('ext-detail-install-btn');
            await installMarketplaceExtension(ext, btn);
        });
    }

    // Show
    panel.classList.add('visible');
    backdrop.classList.add('visible');
}

// Close extension detail panel
function closeExtensionDetail() {
    document.getElementById('ext-detail-panel')?.classList.remove('visible');
    document.getElementById('ext-detail-backdrop')?.classList.remove('visible');
}

// Refresh extensions
async function refreshExtensions() {
    const btn = document.getElementById('refresh-extensions');
    if (btn) {
        btn.disabled = true;
        btn.querySelector('i').className = 'fas fa-sync-alt fa-spin';
    }

    markExtensionsCacheDirty();
    await loadInstalledExtensions({ force: true });

    setTimeout(() => {
        if (btn) {
            btn.disabled = false;
            btn.querySelector('i').className = 'fas fa-sync-alt';
        }
        showNotification('Extensions refreshed', 'success');
    }, 400);
}

// Load installed extensions from backend
async function loadInstalledExtensions(options = {}) {
    const force = options.force === true;
    const shouldRefreshCache = force
        || extensionsCacheDirty
        || installedExtensionsCache.length === 0
        || (Date.now() - extensionsLastLoadedAt) > EXTENSIONS_CACHE_TTL_MS;

    if (!shouldRefreshCache) {
        renderInstalledCards();
        updateExtensionStats();
        renderSettingsExtensionsList();
        return;
    }

    if (extensionsLoadInFlight) {
        extensionsLoadQueued = true;
        extensionsLoadQueuedForce = extensionsLoadQueuedForce || force;
        return;
    }

    extensionsLoadInFlight = true;
    const container = document.getElementById('ext-installed-cards');
    if (container && installedExtensionsCache.length === 0) {
        container.innerHTML = Array(3).fill(0).map(() => `
            <div class="ext-skeleton">
                <div class="ext-skeleton-row">
                    <div class="ext-skeleton-icon"></div>
                    <div class="ext-skeleton-lines">
                        <div class="ext-skeleton-line"></div>
                        <div class="ext-skeleton-line"></div>
                        <div class="ext-skeleton-line"></div>
                    </div>
                </div>
            </div>
        `).join('');
    }

    try {
        const result = await ipcRenderer.invoke('get-installed-extensions');

        if (result?.success && Array.isArray(result.extensions)) {
            installedExtensionsCache = result.extensions;
        } else {
            installedExtensionsCache = [];
        }

        extensionsCacheDirty = false;
        extensionsLastLoadedAt = Date.now();
    } catch (error) {
        console.error('Failed to load installed extensions:', error);
        installedExtensionsCache = [];
        extensionsCacheDirty = true;
    } finally {
        extensionsLoadInFlight = false;
    }

    renderInstalledCards();
    updateExtensionStats();
    renderSettingsExtensionsList();

    if (extensionsLoadQueued) {
        const queuedForce = extensionsLoadQueuedForce;
        extensionsLoadQueued = false;
        extensionsLoadQueuedForce = false;
        void loadInstalledExtensions({ force: queuedForce });
    }
}

// Update hero stats and tab badge
function updateExtensionStats() {
    const total = installedExtensionsCache.length;
    const enabled = installedExtensionsCache.filter(e => e.enabled).length;
    const themes = installedExtensionsCache.filter(e => e.type === 'themes' || e.type === 'theme' || e.category === 'themes').length;

    const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    };

    setVal('ext-stat-total', total);
    setVal('ext-stat-enabled', enabled);
    setVal('ext-stat-themes', themes);
    setVal('ext-tab-badge-installed', total);
}

// Legacy compat
function updateExtensionCounts() {
    updateExtensionStats();
}

// ============================================
// SETTINGS > EXTENSIONS — Installed Extension List & Settings Modal
// ============================================

function normalizeSettingsExtensionsFilter(filterValue) {
    const allowed = new Set(['all', 'themes', 'extensions', 'enabled', 'disabled', 'configurable']);
    return allowed.has(filterValue) ? filterValue : 'all';
}

function normalizeSettingsExtensionsSort(sortValue) {
    const allowed = new Set(['name-asc', 'name-desc', 'status', 'type', 'version-desc']);
    return allowed.has(sortValue) ? sortValue : 'name-asc';
}

function initializeSettingsExtensionsControls() {
    if (settingsExtensionsUiInitialized) {
        return;
    }

    const searchInput = document.getElementById('settings-ext-search');
    const filterSelect = document.getElementById('settings-ext-filter');
    const sortSelect = document.getElementById('settings-ext-sort');
    if (!searchInput || !filterSelect || !sortSelect) {
        return;
    }

    settingsExtensionsUiInitialized = true;
    filterSelect.value = normalizeSettingsExtensionsFilter(settingsExtensionsFilter);
    sortSelect.value = normalizeSettingsExtensionsSort(settingsExtensionsSort);
    searchInput.value = settingsExtensionsSearchQuery;

    searchInput.addEventListener('input', () => {
        settingsExtensionsSearchQuery = searchInput.value.trim().toLowerCase();
        renderSettingsExtensionsList();
    });

    filterSelect.addEventListener('change', () => {
        settingsExtensionsFilter = normalizeSettingsExtensionsFilter(filterSelect.value);
        renderSettingsExtensionsList();
    });

    sortSelect.addEventListener('change', () => {
        settingsExtensionsSort = normalizeSettingsExtensionsSort(sortSelect.value);
        renderSettingsExtensionsList();
    });
}

function updateSettingsExtensionsSummary(model) {
    const summaryEl = document.getElementById('settings-ext-summary');
    if (!summaryEl) {
        return;
    }

    if (!model || model.total === 0) {
        summaryEl.textContent = 'No installed extensions';
        return;
    }

    summaryEl.textContent =
        `${model.visible} of ${model.total} shown | ${model.enabled} enabled | ${model.themes} themes | ${model.configurable} configurable`;
}

function renderSettingsExtensionsList() {
    initializeSettingsExtensionsControls();

    const container = document.getElementById('settings-ext-list');
    if (!container) {
        return;
    }

    const searchInput = document.getElementById('settings-ext-search');
    const filterSelect = document.getElementById('settings-ext-filter');
    const sortSelect = document.getElementById('settings-ext-sort');
    if (searchInput) {
        searchInput.value = settingsExtensionsSearchQuery;
    }
    if (filterSelect) {
        filterSelect.value = normalizeSettingsExtensionsFilter(settingsExtensionsFilter);
    }
    if (sortSelect) {
        sortSelect.value = normalizeSettingsExtensionsSort(settingsExtensionsSort);
    }

    const exts = Array.isArray(installedExtensionsCache) ? installedExtensionsCache : [];
    if (exts.length === 0) {
        updateSettingsExtensionsSummary({ total: 0 });
        container.innerHTML = `
            <div class="settings-ext-empty">
                <i class="fas fa-puzzle-piece"></i>
                <p>No extensions installed yet</p>
            </div>
        `;
        return;
    }

    const currentTheme = document.getElementById('theme-select')?.value || '';
    const models = exts.map((ext) => {
        const isTheme = ext.type === 'theme' || ext.type === 'themes' || ext.category === 'themes';
        const marketplaceExt = MARKETPLACE_EXTENSIONS.find((item) => item.id === ext.id);
        const hasSettings = !isTheme && Boolean(
            (marketplaceExt && marketplaceExt.settings) ||
            (ext.settingsSchema && typeof ext.settingsSchema === 'object')
        );

        return {
            raw: ext,
            id: String(ext.id || ''),
            name: String(ext.displayName || ext.name || ext.id || 'Unknown Extension'),
            description: String(ext.description || '').trim(),
            version: String(ext.version || '1.0.0'),
            isTheme,
            isEnabled: Boolean(ext.enabled),
            isActiveTheme: isTheme && currentTheme === `ext:${ext.id}`,
            hasSettings,
            categoryClass: getCategoryClass(ext.category || 'general'),
            iconClass: getCategoryIcon(ext.category || 'general')
        };
    });

    const query = settingsExtensionsSearchQuery.trim().toLowerCase();
    const filtered = models.filter((model) => {
        if (query) {
            const haystack = `${model.name} ${model.description} ${model.id} ${model.version}`.toLowerCase();
            if (!haystack.includes(query)) {
                return false;
            }
        }

        const filter = normalizeSettingsExtensionsFilter(settingsExtensionsFilter);
        if (filter === 'themes') {
            return model.isTheme;
        }
        if (filter === 'extensions') {
            return !model.isTheme;
        }
        if (filter === 'enabled') {
            return model.isEnabled;
        }
        if (filter === 'disabled') {
            return !model.isEnabled;
        }
        if (filter === 'configurable') {
            return model.hasSettings;
        }
        return true;
    });

    const sortMode = normalizeSettingsExtensionsSort(settingsExtensionsSort);
    filtered.sort((left, right) => {
        if (sortMode === 'name-desc') {
            return right.name.localeCompare(left.name, undefined, { numeric: true, sensitivity: 'base' });
        }
        if (sortMode === 'status') {
            if (left.isEnabled !== right.isEnabled) {
                return left.isEnabled ? -1 : 1;
            }
            return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
        }
        if (sortMode === 'type') {
            if (left.isTheme !== right.isTheme) {
                return left.isTheme ? -1 : 1;
            }
            return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
        }
        if (sortMode === 'version-desc') {
            const versionCompare = compareVersionDescending(left.version, right.version);
            if (versionCompare !== 0) {
                return versionCompare;
            }
            return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
        }
        return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    const summaryModel = {
        total: models.length,
        visible: filtered.length,
        enabled: models.filter((model) => model.isEnabled).length,
        themes: models.filter((model) => model.isTheme).length,
        configurable: models.filter((model) => model.hasSettings).length
    };
    updateSettingsExtensionsSummary(summaryModel);

    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="settings-ext-empty settings-ext-empty-search">
                <i class="fas fa-search"></i>
                <p>No extensions match your current search/filter.</p>
                <button class="btn-secondary" id="settings-ext-clear-filters">
                    <i class="fas fa-rotate-left"></i> Clear Filters
                </button>
            </div>
        `;

        document.getElementById('settings-ext-clear-filters')?.addEventListener('click', () => {
            settingsExtensionsSearchQuery = '';
            settingsExtensionsFilter = 'all';
            settingsExtensionsSort = 'name-asc';
            renderSettingsExtensionsList();
        });
        return;
    }

    container.innerHTML = filtered.map((model) => {
        const safeName = escapeHtml(model.name);
        const safeDesc = escapeHtml(model.description || (model.isTheme ? 'Theme extension' : 'No description provided'));
        const safeVersion = escapeHtml(model.version);
        const safeId = escapeHtml(model.id);

        return `
            <div class="settings-ext-item ${model.isTheme ? 'is-theme' : 'is-extension'} ${model.isEnabled ? 'is-enabled' : 'is-disabled'}" data-ext-id="${safeId}">
                <div class="settings-ext-icon ${model.categoryClass}">
                    <i class="fas ${model.iconClass}"></i>
                </div>
                <div class="settings-ext-info">
                    <div class="settings-ext-name-row">
                        <h4 class="settings-ext-name">${safeName}</h4>
                        <div class="settings-ext-tags">
                            <span class="settings-ext-status ${model.isEnabled ? 'enabled' : 'disabled'}">${model.isEnabled ? 'Enabled' : 'Disabled'}</span>
                            <span class="settings-ext-type-badge ${model.isTheme ? 'theme-badge' : 'ext-badge'}">${model.isTheme ? 'Theme' : 'Extension'}</span>
                            ${model.isActiveTheme ? '<span class="settings-ext-state-badge active-theme">Active Theme</span>' : ''}
                            ${model.hasSettings ? '<span class="settings-ext-state-badge configurable">Configurable</span>' : ''}
                        </div>
                    </div>
                    <p class="settings-ext-desc">${safeDesc}</p>
                    <div class="settings-ext-meta">
                        <span class="settings-ext-id">${safeId}</span>
                        <span class="settings-ext-version">v${safeVersion}</span>
                    </div>
                </div>
                <div class="settings-ext-actions">
                    ${model.isTheme ? `
                        <button class="${model.isActiveTheme ? 'active-theme-btn' : ''}" data-action="apply-theme" data-ext-id="${safeId}" title="${model.isActiveTheme ? 'Theme currently active' : 'Apply this theme'}">
                            <i class="fas fa-${model.isActiveTheme ? 'check' : 'palette'}"></i>
                        </button>
                    ` : `
                        <button data-action="toggle-ext" data-ext-id="${safeId}" data-enable="${model.isEnabled ? 'false' : 'true'}" title="${model.isEnabled ? 'Disable extension' : 'Enable extension'}">
                            <i class="fas fa-${model.isEnabled ? 'pause' : 'play'}"></i>
                        </button>
                    `}
                    ${model.hasSettings ? `
                        <button data-action="ext-settings" data-ext-id="${safeId}" title="Open extension settings">
                            <i class="fas fa-cog"></i>
                        </button>
                    ` : ''}
                    <button class="danger-btn" data-action="uninstall-ext" data-ext-id="${safeId}" title="Uninstall extension">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
        `;
    }).join('');

    container.querySelectorAll('[data-action="apply-theme"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const themeId = btn.dataset.extId;
            const theme = `ext:${themeId}`;
            const themeSelect = document.getElementById('theme-select');
            if (themeSelect) {
                themeSelect.value = theme;
                themeSelect.dispatchEvent(new Event('change', { bubbles: true }));
            } else {
                await applyTheme(theme);
                refreshSettingsDirtyState();
            }
            renderSettingsExtensionsList();
        });
    });

    container.querySelectorAll('[data-action="toggle-ext"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const extId = btn.dataset.extId;
            const shouldEnable = btn.dataset.enable === 'true';
            const ext = installedExtensionsCache.find((item) => item.id === extId);
            const extName = ext?.displayName || ext?.name || extId;

            btn.disabled = true;
            const result = shouldEnable
                ? await ipcRenderer.invoke('enable-extension', extId)
                : await ipcRenderer.invoke('disable-extension', extId);
            if (result.success) {
                syncInstalledExtensionCache(extId, { enabled: shouldEnable });
                showNotification(`${extName} ${shouldEnable ? 'enabled' : 'disabled'}`, 'success');
                await loadInstalledExtensions({ force: true });
                renderSettingsExtensionsList();
            } else {
                showNotification(`Failed: ${result.error}`, 'error');
                btn.disabled = false;
            }
        });
    });

    container.querySelectorAll('[data-action="ext-settings"]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const extId = btn.dataset.extId;
            openExtensionSettingsModal(extId);
        });
    });

    container.querySelectorAll('[data-action="uninstall-ext"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const extId = btn.dataset.extId;
            const ext = installedExtensionsCache.find((item) => item.id === extId);
            const name = ext?.displayName || ext?.name || extId;
            if (confirm(`Uninstall ${name}?`)) {
                const result = await ipcRenderer.invoke('uninstall-extension', extId);
                if (result.success) {
                    markExtensionsCacheDirty();
                    showNotification(`${name} uninstalled`, 'success');
                    await loadInstalledExtensions({ force: true });
                    await loadThemeExtensions();
                    renderSettingsExtensionsList();
                } else {
                    showNotification(`Failed: ${result.error}`, 'error');
                }
            }
        });
    });
}

// Open the per-extension settings modal
async function openExtensionSettingsModal(extId) {
    const marketplaceExt = MARKETPLACE_EXTENSIONS.find(m => m.id === extId);
    const installedExt = installedExtensionsCache.find(e => e.id === extId);
    const settingsSchema = (marketplaceExt && marketplaceExt.settings)
        ? marketplaceExt.settings
        : (installedExt && installedExt.settingsSchema && typeof installedExt.settingsSchema === 'object'
            ? installedExt.settingsSchema
            : null);
    if (!settingsSchema) {
        showNotification('No configurable settings for this extension', 'info');
        return;
    }

    const extensionSource = marketplaceExt || installedExt || { id: extId };
    const safeName = escapeHtml(extensionSource.displayName || extensionSource.name || extId);
    const safeAuthor = escapeHtml(extensionSource.author || extensionSource.publisher || 'Unknown');
    const catClass = getCategoryClass(extensionSource.category || 'general');
    const iconClass = getCategoryIcon(extensionSource.category || 'general');

    // Load saved settings from backend
    let savedSettings = {};
    try {
        const result = await ipcRenderer.invoke('get-extension-settings', extId);
        if (result && typeof result === 'object' && result.success && result.settings && typeof result.settings === 'object') {
            savedSettings = result.settings;
        } else if (result && typeof result === 'object' && !Array.isArray(result)) {
            savedSettings = result;
        }
    } catch (e) {
        console.error('Failed to load extension settings:', e);
    }

    // Build settings rows
    const schema = settingsSchema;
    let settingsHTML = '';
    for (const [key, config] of Object.entries(schema)) {
        const currentVal = savedSettings[key] !== undefined ? savedSettings[key] : config.default;
        const safeLabel = escapeHtml(config.label);

        if (config.type === 'toggle') {
            settingsHTML += `
                <div class="ext-setting-row">
                    <span class="ext-setting-label">${safeLabel}</span>
                    <label class="ext-toggle">
                        <input type="checkbox" data-setting-key="${key}" ${currentVal ? 'checked' : ''}>
                        <span class="ext-toggle-slider"></span>
                    </label>
                </div>
            `;
        } else if (config.type === 'select') {
            const optionsHTML = config.options.map(opt =>
                `<option value="${escapeHtml(opt)}" ${String(currentVal) === String(opt) ? 'selected' : ''}>${escapeHtml(opt)}</option>`
            ).join('');
            settingsHTML += `
                <div class="ext-setting-row">
                    <span class="ext-setting-label">${safeLabel}</span>
                    <select data-setting-key="${key}">${optionsHTML}</select>
                </div>
            `;
        }
    }

    // Create modal
    const overlay = document.createElement('div');
    overlay.className = 'ext-settings-modal-overlay';
    overlay.innerHTML = `
        <div class="ext-settings-modal">
            <div class="ext-settings-modal-header">
                <div class="settings-ext-icon ${catClass}">
                    <i class="fas ${iconClass}"></i>
                </div>
                <h3>${safeName}<small>by ${safeAuthor}</small></h3>
                <button class="ext-settings-modal-close"><i class="fas fa-times"></i></button>
            </div>
            <div class="ext-settings-modal-body">
                ${settingsHTML}
            </div>
            <div class="ext-settings-modal-footer">
                <button class="ext-settings-cancel-btn">Cancel</button>
                <button class="ext-settings-save-btn"><i class="fas fa-check"></i> Save Settings</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    // Close handlers
    const closeModal = () => overlay.remove();
    overlay.querySelector('.ext-settings-modal-close').addEventListener('click', closeModal);
    overlay.querySelector('.ext-settings-cancel-btn').addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModal();
    });

    // Save handler
    overlay.querySelector('.ext-settings-save-btn').addEventListener('click', async () => {
        const newSettings = {};
        overlay.querySelectorAll('[data-setting-key]').forEach(el => {
            const key = el.dataset.settingKey;
            if (el.type === 'checkbox') {
                newSettings[key] = el.checked;
            } else {
                newSettings[key] = el.value;
            }
        });

        try {
            const result = await ipcRenderer.invoke('save-extension-settings', extId, newSettings);
            if (result.success) {
                showNotification(`${safeName} settings saved`, 'success');
                closeModal();
            } else {
                showNotification(`Failed to save settings: ${result.error}`, 'error');
            }
        } catch (e) {
            showNotification('Failed to save settings', 'error');
        }
    });
}

// Hook: render the settings extensions list when the Extensions settings panel is shown
(function hookSettingsExtPanel() {
    // Wait for DOM, then observe settings category clicks
    const observer = new MutationObserver(() => {
        const navItems = document.querySelectorAll('.settings-category');
        if (navItems.length > 0) {
            observer.disconnect();
            navItems.forEach(item => {
                item.addEventListener('click', () => {
                    if (item.dataset.category === 'extensions') {
                        renderSettingsExtensionsList();
                    }
                });
            });
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
})();

// ============================================
// THEME MARKETPLACE SYSTEM
// ============================================

// Load marketplace themes from external file or inline
const THEME_MARKETPLACE = [
    {
        id: 'monokai-pro',
        displayName: 'Monokai Pro',
        description: 'Beautiful Monokai-inspired dark theme with vibrant syntax highlighting',
        author: 'Monokai',
        version: '2.1.0',
        rating: 4.9,
        downloads: 125340,
        category: 'Dark',
        tags: ['dark', 'vibrant', 'popular', 'pro'],
        preview: {
            background: '#2d2a2e',
            accent: '#ff6188',
            secondary: '#ffd866',
            palette: ['#2d2a2e', '#ff6188', '#ffd866', '#a9dc76', '#78dce8', '#ab9df2']
        },
        css: `:root { --bg-primary: #2d2a2e; --bg-secondary: #221f22; --bg-tertiary: #3a3739; --text-primary: #fcfcfa; --text-secondary: #939293; --accent-primary: #ff6188; --accent-secondary: #ffd866; --border-color: #5b595c; --success: #a9dc76; --warning: #fc9867; --error: #ff6188; --info: #78dce8; }
.sidebar { background: var(--bg-secondary); border-right: 1px solid var(--border-color); }
.titlebar { background: var(--bg-secondary); }
.project-card, .extension-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.project-card:hover, .extension-card:hover { border-color: var(--accent-primary); transform: translateY(-2px); box-shadow: 0 8px 24px rgba(255, 97, 136, 0.15); }
.btn-primary { background: linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%); }`
    },
    // Dracula Official
    {
        id: 'dracula-official',
        displayName: 'Dracula Official',
        description: 'Dark theme with perfect contrast and vibrant colors',
        author: 'Dracula Theme',
        version: '4.0.1',
        rating: 4.8,
        downloads: 234750,
        category: 'Dark',
        tags: ['dark', 'vibrant', 'popular', 'purple'],
        preview: {
            background: '#282a36',
            accent: '#bd93f9',
            secondary: '#ff79c6',
            palette: ['#282a36', '#bd93f9', '#ff79c6', '#50fa7b', '#8be9fd', '#f1fa8c']
        },
        css: `:root { --bg-primary: #282a36; --bg-secondary: #21222c; --bg-tertiary: #343746; --text-primary: #f8f8f2; --text-secondary: #6272a4; --accent-primary: #bd93f9; --accent-secondary: #ff79c6; --border-color: #44475a; --success: #50fa7b; --warning: #f1fa8c; --error: #ff5555; --info: #8be9fd; }
.sidebar { background: var(--bg-secondary); }
.project-card, .extension-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.project-card:hover, .extension-card:hover { border-color: var(--accent-primary); box-shadow: 0 4px 20px rgba(189, 147, 249, 0.2); }`
    },
    // Tokyo Night
    {
        id: 'tokyo-night',
        displayName: 'Tokyo Night',
        description: 'Clean, dark theme inspired by Tokyo nights with neon accents',
        author: 'Tokyo Night',
        version: '1.3.0',
        rating: 4.9,
        downloads: 156240,
        category: 'Dark',
        tags: ['dark', 'blue', 'neon', 'modern'],
        preview: {
            background: '#1a1b26',
            accent: '#7aa2f7',
            secondary: '#bb9af7',
            palette: ['#1a1b26', '#7aa2f7', '#bb9af7', '#9ece6a', '#e0af68', '#f7768e']
        },
        css: `:root { --bg-primary: #1a1b26; --bg-secondary: #16161e; --bg-tertiary: #24283b; --text-primary: #c0caf5; --text-secondary: #565f89; --accent-primary: #7aa2f7; --accent-secondary: #bb9af7; --border-color: #292e42; --success: #9ece6a; --warning: #e0af68; --error: #f7768e; --info: #7dcfff; }
.sidebar { background: var(--bg-secondary); }
.project-card, .extension-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.project-card:hover { border-color: var(--accent-primary); box-shadow: 0 8px 24px rgba(122, 162, 247, 0.2); }`
    }
];

// Download and install marketplace theme
async function downloadMarketplaceTheme(themeData) {
    showNotification(`Downloading ${themeData.displayName}...`, 'info');

    const extensionData = {
        id: themeData.id,
        name: themeData.displayName,
        type: 'themes',
        files: {
            'manifest.json': JSON.stringify({
                name: themeData.id,
                displayName: themeData.displayName,
                version: themeData.version,
                description: themeData.description,
                publisher: themeData.author,
                category: 'themes',
                main: 'theme.css',
                rating: themeData.rating,
                downloads: themeData.downloads,
                preview: themeData.preview,
                colors: themeData.preview?.palette || []
            }, null, 2),
            'theme.css': themeData.css
        }
    };

    const result = await ipcRenderer.invoke('install-extension', extensionData);

    if (result.success) {
        markExtensionsCacheDirty();
        showNotification(`${themeData.displayName} installed successfully!`, 'success');
        await loadThemeExtensions();
        await loadInstalledExtensions({ force: true });
        return true;
    } else {
        showNotification(`Failed to install ${themeData.displayName}: ${result.error}`, 'error');
        return false;
    }
}

// Show theme marketplace - redirects to themes tab in extensions view
function showThemeMarketplace() {
    // Switch to extensions view and themes tab
    const extView = document.getElementById('extensions-view');
    if (extView) {
        // Activate the extensions view if not already active
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        extView.classList.add('active');
    }
    // Activate themes tab
    document.querySelectorAll('.ext-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.ext-tab-content').forEach(c => c.classList.remove('active'));
    const themesTab = document.querySelector('[data-ext-tab="themes"]');
    if (themesTab) themesTab.classList.add('active');
    const themesContent = document.getElementById('ext-themes');
    if (themesContent) themesContent.classList.add('active');
    renderThemesTab();

    // Legacy: if modal was somehow opened, also handle that
    const modalHTML = `
        <div class="modal" id="theme-marketplace-modal">
            <div class="modal-content" style="max-width: 1200px; height: 80vh; overflow: hidden; display: flex; flex-direction: column;">
                <div class="modal-header">
                    <h2><i class="fas fa-palette"></i> Theme Marketplace</h2>
                    <button class="close-modal" onclick="hideModal('theme-marketplace-modal')">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="modal-body" style="flex: 1; overflow-y: auto; padding: 20px;">
                    <div class="marketplace-search" style="margin-bottom: 20px;">
                        <input type="text" id="marketplace-search" placeholder="Search themes..." style="width: 100%; padding: 12px; border-radius: 8px; border: 1px solid var(--border-color); background: var(--bg-tertiary); color: var(--text-primary);">
                    </div>
                    <div class="marketplace-grid" id="marketplace-themes-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(350px, 1fr)); gap: 20px;">
                        <!-- Themes will be injected here -->
                    </div>
                </div>
            </div>
        </div>
    `;

    // Add modal to page if it doesn't exist
    if (!document.getElementById('theme-marketplace-modal')) {
        document.body.insertAdjacentHTML('beforeend', modalHTML);
    }

    // Populate themes
    const grid = document.getElementById('marketplace-themes-grid');
    grid.innerHTML = THEME_MARKETPLACE.map(theme => createMarketplaceThemeCard(theme)).join('');

    // Add search functionality
    document.getElementById('marketplace-search')?.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        const cards = grid.querySelectorAll('.marketplace-theme-card');
        cards.forEach(card => {
            const text = card.textContent.toLowerCase();
            card.style.display = text.includes(query) ? 'block' : 'none';
        });
    });

    showModal('theme-marketplace-modal');
}

// Create marketplace theme card
function createMarketplaceThemeCard(theme) {
    const stars = '\u2605'.repeat(Math.floor(theme.rating)) + '\u2606'.repeat(5 - Math.floor(theme.rating));

    return `
        <div class="marketplace-theme-card" data-theme-id="${theme.id}" style="
            background: var(--bg-tertiary);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            padding: 20px;
            cursor: pointer;
            transition: all 0.3s ease;
        ">
            <div class="theme-preview" style="
                height: 80px;
                border-radius: 8px;
                background: ${theme.preview.background};
                margin-bottom: 15px;
                position: relative;
                overflow: hidden;
                display: flex;
                align-items: flex-end;
                padding: 10px;
            ">
                <div style="display: flex; gap: 6px;">
                    ${theme.preview.palette.map(color => `
                        <div style="width: 24px; height: 24px; border-radius: 4px; background: ${color}; border: 2px solid rgba(255,255,255,0.2);"></div>
                    `).join('')}
                </div>
            </div>

            <h3 style="margin: 0 0 8px 0; font-size: 18px; color: var(--text-primary);">
                ${theme.displayName}
            </h3>

            <p style="font-size: 13px; color: var(--text-secondary); margin: 0 0 12px 0; line-height: 1.5;">
                ${theme.description}
            </p>

            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                <div style="font-size: 12px; color: var(--text-secondary);">
                    <span style="color: #ffd866;">${stars}</span> ${theme.rating}
                </div>
                <div style="font-size: 12px; color: var(--text-secondary);">
                    <i class="fas fa-download"></i> ${(theme.downloads / 1000).toFixed(1)}k
                </div>
            </div>

            <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 15px;">
                ${theme.tags.slice(0, 3).map(tag => `
                    <span style="
                        background: var(--bg-secondary);
                        color: var(--accent-primary);
                        padding: 4px 10px;
                        border-radius: 12px;
                        font-size: 11px;
                        font-weight: 500;
                    ">${tag}</span>
                `).join('')}
            </div>

            <button class="btn-primary" style="width: 100%; padding: 10px; border-radius: 8px; border: none; cursor: pointer; font-weight: 500;"
                onclick="event.stopPropagation(); installMarketplaceTheme('${theme.id}')">
                <i class="fas fa-download"></i> Install Theme
            </button>
        </div>
    `;
}

// Install marketplace theme by ID
async function installMarketplaceTheme(themeId) {
    const theme = THEME_MARKETPLACE.find(t => t.id === themeId);
    if (theme) {
        const success = await downloadMarketplaceTheme(theme);
        if (success) {
            hideModal('theme-marketplace-modal');
        }
    }
}

// Make functions globally accessible
window.showThemeMarketplace = showThemeMarketplace;
window.installMarketplaceTheme = installMarketplaceTheme;

// Install all marketplace themes (for quick setup)
async function installAllMarketplaceThemes() {
    showNotification('Installing curated themes from marketplace...', 'info');

    let installedCount = 0;
    for (const theme of THEME_MARKETPLACE) {
        const success = await downloadMarketplaceTheme(theme);
        if (success) installedCount++;
    }

    if (installedCount > 0) {
        showNotification(`Successfully installed ${installedCount} themes!`, 'success');
    }
}

// Legacy function - redirects to marketplace
async function installSampleThemes() {
    showThemeMarketplace();
}

// Make globally accessible
window.installAllMarketplaceThemes = installAllMarketplaceThemes;

// Install sample theme extensions for testing (OLD - kept for compatibility)
async function installSampleThemesOld() {
    const themes = [
        {
            id: 'monokai-pro',
            name: 'Monokai Pro',
            description: 'Beautiful Monokai-inspired dark theme',
            css: `
:root {
    --bg-primary: #2d2a2e;
    --bg-secondary: #221f22;
    --bg-tertiary: #3a3739;
    --text-primary: #fcfcfa;
    --text-secondary: #939293;
    --accent-primary: #ff6188;
    --accent-secondary: #ffd866;
    --border-color: #5b595c;
    --success: #a9dc76;
    --warning: #fc9867;
    --error: #ff6188;
    --info: #78dce8;
}

.sidebar {
    background: var(--bg-secondary);
}

.project-card, .extension-card {
    background: var(--bg-tertiary);
    border-color: var(--border-color);
}

.project-card:hover, .extension-card:hover {
    border-color: var(--accent-primary);
}

.btn-primary {
    background: linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%);
}
`
        },
        {
            id: 'dracula',
            name: 'Dracula',
            description: 'Dark theme with vibrant colors',
            css: `
:root {
    --bg-primary: #282a36;
    --bg-secondary: #21222c;
    --bg-tertiary: #343746;
    --text-primary: #f8f8f2;
    --text-secondary: #6272a4;
    --accent-primary: #bd93f9;
    --accent-secondary: #ff79c6;
    --border-color: #44475a;
    --success: #50fa7b;
    --warning: #f1fa8c;
    --error: #ff5555;
    --info: #8be9fd;
}

.sidebar {
    background: var(--bg-secondary);
}

.titlebar {
    background: var(--bg-secondary);
}

.project-card, .extension-card {
    background: var(--bg-tertiary);
    border-color: var(--border-color);
}

.project-card:hover, .extension-card:hover {
    border-color: var(--accent-primary);
    box-shadow: 0 4px 20px rgba(189, 147, 249, 0.2);
}

.btn-primary {
    background: linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%);
}
`
        },
        {
            id: 'nord',
            name: 'Nord',
            description: 'Arctic, north-bluish color palette',
            css: `
:root {
    --bg-primary: #2e3440;
    --bg-secondary: #3b4252;
    --bg-tertiary: #434c5e;
    --text-primary: #eceff4;
    --text-secondary: #d8dee9;
    --accent-primary: #88c0d0;
    --accent-secondary: #81a1c1;
    --border-color: #4c566a;
    --success: #a3be8c;
    --warning: #ebcb8b;
    --error: #bf616a;
    --info: #5e81ac;
}

.sidebar {
    background: var(--bg-secondary);
}

.titlebar {
    background: var(--bg-secondary);
}

.project-card, .extension-card {
    background: var(--bg-tertiary);
    border-color: var(--border-color);
}

.project-card:hover, .extension-card:hover {
    border-color: var(--accent-primary);
}

.btn-primary {
    background: linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%);
}
`
        },
        {
            id: 'solarized-dark',
            name: 'Solarized Dark',
            description: 'Precision colors for machines and people',
            css: `
:root {
    --bg-primary: #002b36;
    --bg-secondary: #073642;
    --bg-tertiary: #0f4b5a;
    --text-primary: #fdf6e3;
    --text-secondary: #93a1a1;
    --accent-primary: #268bd2;
    --accent-secondary: #2aa198;
    --border-color: #586e75;
    --success: #859900;
    --warning: #b58900;
    --error: #dc322f;
    --info: #268bd2;
}

.sidebar {
    background: var(--bg-secondary);
}

.titlebar {
    background: var(--bg-secondary);
}

.project-card, .extension-card {
    background: var(--bg-tertiary);
    border-color: var(--border-color);
}

.btn-primary {
    background: linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%);
}
`
        }
    ];

    let installedCount = 0;
    for (const theme of themes) {
        const extensionData = {
            id: theme.id,
            name: theme.name,
            type: 'themes',
            files: {
                'manifest.json': JSON.stringify({
                    name: theme.id,
                    displayName: theme.name,
                    version: '1.0.0',
                    description: theme.description,
                    publisher: 'Built-in',
                    category: 'themes',
                    main: 'theme.css',
                    colors: {}
                }, null, 2),
                'theme.css': theme.css
            }
        };

        const result = await ipcRenderer.invoke('install-extension', extensionData);
        if (result.success) {
            installedCount++;
        }
    }

    if (installedCount > 0) {
        showNotification(`Installed ${installedCount} sample themes`, 'success');
        await loadThemeExtensions();
        markExtensionsCacheDirty();
        await loadInstalledExtensions({ force: true });
    }
}

// Make function available globally for testing
window.installSampleThemes = installSampleThemes;

// Command palette

