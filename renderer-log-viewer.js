(() => {
    const LOG_HISTORY_LIMIT = 1600;
    const MAX_RENDERED_ROWS = 700;
    const MAX_ENTRIES_IN_MEMORY = 4000;
    const RECENT_WINDOW_MS = 5 * 60 * 1000;
    const SEARCH_DEBOUNCE_MS = 140;
    const FAULT_KEYWORDS = /(error|fail|exception|timeout|denied|invalid|crash|fatal|panic|abort|reject|blocked|corrupt|unable)/i;
    const LEVEL_LABELS = {
        error: 'Error',
        warn: 'Warn',
        info: 'Info',
        debug: 'Debug'
    };

    function toSafeString(value, fallback = '') {
        if (typeof value === 'string') {
            return value;
        }
        if (value === null || value === undefined) {
            return fallback;
        }
        return String(value);
    }

    function escapeHtml(value) {
        return toSafeString(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function normalizeLevel(level) {
        const normalized = toSafeString(level, 'info').trim().toLowerCase();
        if (normalized === 'warning') {
            return 'warn';
        }
        if (normalized === 'error' || normalized === 'warn' || normalized === 'info' || normalized === 'debug') {
            return normalized;
        }
        return 'info';
    }

    function normalizeEntry(entry, fallbackId) {
        const level = normalizeLevel(entry?.level);
        const message = toSafeString(entry?.message, '[empty-message]').trim() || '[empty-message]';
        const source = toSafeString(entry?.source, 'main').trim() || 'main';
        const context = toSafeString(entry?.context, '');
        const timestamp = toSafeString(entry?.timestamp, new Date().toISOString());
        const isFault = Boolean(entry?.isFault) || level === 'error' || level === 'warn' || FAULT_KEYWORDS.test(`${message} ${context}`);
        const idCandidate = Number(entry?.id);
        const id = Number.isFinite(idCandidate) ? idCandidate : fallbackId;

        return {
            id,
            timestamp,
            level,
            source,
            message,
            context,
            isFault
        };
    }

    function formatTimestamp(value) {
        const time = Date.parse(value);
        if (!Number.isFinite(time)) {
            return value || '--';
        }
        return new Date(time).toLocaleString();
    }

    function formatRelativeTime(value) {
        const timestamp = Date.parse(value);
        if (!Number.isFinite(timestamp)) {
            return '--';
        }

        const deltaMs = Date.now() - timestamp;
        const absDelta = Math.abs(deltaMs);
        if (absDelta < 1000) {
            return 'just now';
        }

        const units = [
            { label: 'd', size: 24 * 60 * 60 * 1000 },
            { label: 'h', size: 60 * 60 * 1000 },
            { label: 'm', size: 60 * 1000 },
            { label: 's', size: 1000 }
        ];

        for (const unit of units) {
            if (absDelta >= unit.size) {
                const valueRounded = Math.floor(absDelta / unit.size);
                return deltaMs >= 0 ? `${valueRounded}${unit.label} ago` : `in ${valueRounded}${unit.label}`;
            }
        }

        return '--';
    }

    function normalizeFingerprint(message) {
        return toSafeString(message, '')
            .toLowerCase()
            .replace(/[0-9]+/g, '#')
            .replace(/0x[0-9a-f]+/g, '0x#')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function truncateText(value, maxLength = 120) {
        const safeValue = toSafeString(value, '').trim();
        if (safeValue.length <= maxLength) {
            return safeValue;
        }
        return `${safeValue.slice(0, Math.max(0, maxLength - 3))}...`;
    }

    function buildInsights(entries) {
        const counts = { error: 0, warn: 0, info: 0, debug: 0, fault: 0 };
        const sourceCounts = new Map();
        const faultFingerprints = new Map();
        let recentFaultCount = 0;
        const now = Date.now();

        entries.forEach((entry) => {
            counts[entry.level] = (counts[entry.level] || 0) + 1;
            if (entry.isFault) {
                counts.fault += 1;
                const messageFingerprint = normalizeFingerprint(entry.message);
                if (messageFingerprint) {
                    faultFingerprints.set(messageFingerprint, (faultFingerprints.get(messageFingerprint) || 0) + 1);
                }

                const timestamp = Date.parse(entry.timestamp);
                if (Number.isFinite(timestamp) && now - timestamp <= RECENT_WINDOW_MS) {
                    recentFaultCount += 1;
                }
            }
            sourceCounts.set(entry.source, (sourceCounts.get(entry.source) || 0) + 1);
        });

        let topSource = '';
        let topSourceCount = 0;
        sourceCounts.forEach((count, source) => {
            if (count > topSourceCount) {
                topSource = source;
                topSourceCount = count;
            }
        });

        let topFaultFingerprint = '';
        let topFaultFingerprintCount = 0;
        faultFingerprints.forEach((count, key) => {
            if (count > topFaultFingerprintCount) {
                topFaultFingerprint = key;
                topFaultFingerprintCount = count;
            }
        });

        const recentRate = entries
            .filter((entry) => {
                const timestamp = Date.parse(entry.timestamp);
                return Number.isFinite(timestamp) && now - timestamp <= RECENT_WINDOW_MS;
            })
            .length;
        const perMinuteRate = (recentRate / 5).toFixed(1);

        let summary = 'Telemetry stream is stable.';
        if (counts.fault === 0) {
            summary = 'No active faults in the current filtered view.';
        } else if (recentFaultCount >= 4) {
            summary = `Fault burst detected: ${recentFaultCount} issues in the last 5 minutes.`;
        } else {
            summary = `${counts.fault} fault events detected in this filtered view.`;
        }

        if (topFaultFingerprint && topFaultFingerprintCount >= 2) {
            summary += ` Recurring issue: "${topFaultFingerprint.slice(0, 96)}".`;
        }

        return {
            counts,
            topSource,
            topSourceCount,
            perMinuteRate,
            summary
        };
    }

    async function writeTextToClipboard(text) {
        if (navigator?.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return;
        }

        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.setAttribute('readonly', 'true');
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
    }

    function createLogViewerController(options = {}) {
        const ipcRenderer = options.ipcRenderer;
        const showView = options.showView;
        const getCurrentView = options.getCurrentView;
        const navigateBack = options.navigateBack;
        const openDocumentation = options.openDocumentation;
        const showNotification = options.showNotification;

        const state = {
            initialized: false,
            entries: [],
            filteredEntries: [],
            selectedEntryId: null,
            liveUpdatesEnabled: true,
            unsubscribeLiveLog: null,
            lastSourceView: 'dashboard',
            sourceOptionsSignature: '',
            nextSyntheticId: 1,
            searchDebounceTimer: null,
            refreshInFlight: false,
            elements: {}
        };

        const requiredElementIds = [
            'diagnostics-view',
            'log-viewer-search-input',
            'log-viewer-level-filter',
            'log-viewer-source-filter',
            'log-viewer-fault-toggle',
            'log-viewer-live-toggle',
            'log-viewer-autoscroll-toggle',
            'log-viewer-refresh-btn',
            'log-viewer-clear-btn',
            'log-viewer-copy-btn',
            'log-viewer-export-btn',
            'log-viewer-open-folder-btn',
            'log-viewer-total-count',
            'log-viewer-visible-count',
            'log-viewer-fault-count',
            'log-viewer-error-count',
            'log-viewer-rate',
            'log-viewer-top-source',
            'log-viewer-smart-summary',
            'log-viewer-log-path',
            'log-viewer-list',
            'log-viewer-empty-state',
            'log-viewer-detail-empty',
            'log-viewer-detail-card',
            'log-viewer-detail-id',
            'log-viewer-detail-level',
            'log-viewer-detail-source',
            'log-viewer-detail-time',
            'log-viewer-detail-message',
            'log-viewer-detail-context'
        ];

        function notify(message, type = 'info') {
            if (typeof showNotification === 'function') {
                showNotification(message, type);
            }
        }

        function cacheElements() {
            const next = {};
            for (const id of requiredElementIds) {
                const element = document.getElementById(id);
                if (!element) {
                    return false;
                }
                next[id] = element;
            }
            next['log-viewer-back-btn'] = document.getElementById('log-viewer-back-btn');
            next['log-viewer-open-docs-btn'] = document.getElementById('log-viewer-open-docs-btn');
            state.elements = next;
            return true;
        }

        async function navigateToView(viewName) {
            if (typeof showView !== 'function') {
                return false;
            }

            try {
                const switched = await Promise.resolve(showView(viewName));
                return switched !== false;
            } catch (error) {
                notify(error?.message || `Failed to open ${viewName}`, 'error');
                return false;
            }
        }

        async function goBackFromDiagnostics() {
            if (typeof navigateBack === 'function') {
                const handled = await Promise.resolve(navigateBack());
                if (handled) {
                    return true;
                }
            }

            const fallbackView = state.lastSourceView && state.lastSourceView !== 'diagnostics'
                ? state.lastSourceView
                : 'dashboard';
            return navigateToView(fallbackView);
        }

        async function openDocumentationView() {
            if (typeof openDocumentation === 'function') {
                await Promise.resolve(openDocumentation());
                return true;
            }

            return navigateToView('documentation');
        }

        function cancelScheduledSearchFilter() {
            if (state.searchDebounceTimer !== null) {
                window.clearTimeout(state.searchDebounceTimer);
                state.searchDebounceTimer = null;
            }
        }

        function scheduleSearchFilter() {
            cancelScheduledSearchFilter();
            state.searchDebounceTimer = window.setTimeout(() => {
                state.searchDebounceTimer = null;
                applyFilters();
            }, SEARCH_DEBOUNCE_MS);
        }

        function updateActionButtonState() {
            const hasEntries = state.entries.length > 0;
            const hasVisibleEntries = state.filteredEntries.length > 0;
            const hasSelection = Boolean(getSelectedEntry());
            state.elements['log-viewer-copy-btn'].disabled = !hasSelection || state.refreshInFlight;
            state.elements['log-viewer-export-btn'].disabled = !hasVisibleEntries || state.refreshInFlight;
            state.elements['log-viewer-clear-btn'].disabled = !hasEntries || state.refreshInFlight;
            state.elements['log-viewer-refresh-btn'].disabled = state.refreshInFlight;
        }

        function syncNextSyntheticId() {
            const highestKnownId = state.entries.reduce((maxId, entry) => {
                const candidate = Number(entry?.id);
                if (!Number.isFinite(candidate)) {
                    return maxId;
                }
                return Math.max(maxId, candidate);
            }, 0);
            state.nextSyntheticId = Math.max(state.nextSyntheticId, highestKnownId + 1);
        }

        function updateSourceFilterOptions() {
            const filterElement = state.elements['log-viewer-source-filter'];
            const currentValue = toSafeString(filterElement.value, 'all');
            const sources = Array
                .from(new Set(state.entries.map((entry) => entry.source)))
                .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
            const nextSignature = sources.join('\u0001');

            if (state.sourceOptionsSignature !== nextSignature) {
                const optionsMarkup = ['<option value="all">All Sources</option>']
                    .concat(sources.map((source) => `<option value="${escapeHtml(source)}">${escapeHtml(source)}</option>`))
                    .join('');
                filterElement.innerHTML = optionsMarkup;
                state.sourceOptionsSignature = nextSignature;
            }
            filterElement.value = sources.includes(currentValue) ? currentValue : 'all';
        }

        function getSelectedEntry() {
            return state.filteredEntries.find((entry) => entry.id === state.selectedEntryId) || null;
        }

        function ensureValidSelection(preferredEntryId = null) {
            if (preferredEntryId !== null && state.filteredEntries.some((entry) => entry.id === preferredEntryId)) {
                state.selectedEntryId = preferredEntryId;
                return;
            }

            if (state.selectedEntryId !== null && state.filteredEntries.some((entry) => entry.id === state.selectedEntryId)) {
                return;
            }

            state.selectedEntryId = state.filteredEntries.length ? state.filteredEntries[0].id : null;
        }

        function renderSummary() {
            const insights = buildInsights(state.filteredEntries);
            state.elements['log-viewer-total-count'].textContent = String(state.entries.length);
            state.elements['log-viewer-visible-count'].textContent = String(state.filteredEntries.length);
            state.elements['log-viewer-fault-count'].textContent = String(insights.counts.fault);
            state.elements['log-viewer-error-count'].textContent = String(insights.counts.error);
            state.elements['log-viewer-rate'].textContent = `${insights.perMinuteRate}/min`;
            state.elements['log-viewer-top-source'].textContent = insights.topSource || '--';
            state.elements['log-viewer-smart-summary'].textContent = insights.summary;
        }

        function renderEntries() {
            const listElement = state.elements['log-viewer-list'];
            const emptyElement = state.elements['log-viewer-empty-state'];
            const shouldShowEmpty = state.filteredEntries.length === 0;
            emptyElement.hidden = !shouldShowEmpty;
            listElement.hidden = shouldShowEmpty;

            if (shouldShowEmpty) {
                listElement.innerHTML = '';
                listElement.removeAttribute('aria-activedescendant');
                return;
            }

            let activeRowDomId = '';
            const rendered = state.filteredEntries.slice(0, MAX_RENDERED_ROWS).map((entry, index) => {
                const activeClass = entry.id === state.selectedEntryId ? ' active' : '';
                const faultClass = entry.isFault ? ' is-fault' : '';
                const levelLabel = LEVEL_LABELS[entry.level] || LEVEL_LABELS.info;
                const rowDomId = `log-viewer-row-${entry.id}-${index}`;
                if (!activeRowDomId && entry.id === state.selectedEntryId) {
                    activeRowDomId = rowDomId;
                }
                const rowLabel = `${levelLabel} ${formatRelativeTime(entry.timestamp)} ${entry.source} ${truncateText(entry.message)}`;
                return `
                    <button
                        type="button"
                        id="${escapeHtml(rowDomId)}"
                        class="log-viewer-row${activeClass}${faultClass}"
                        data-entry-id="${entry.id}"
                        role="option"
                        aria-selected="${entry.id === state.selectedEntryId ? 'true' : 'false'}"
                        aria-label="${escapeHtml(rowLabel)}"
                        tabindex="-1"
                    >
                        <span class="log-viewer-row-level level-${escapeHtml(entry.level)}">${escapeHtml(levelLabel)}</span>
                        <span class="log-viewer-row-time" title="${escapeHtml(formatTimestamp(entry.timestamp))}">${escapeHtml(formatRelativeTime(entry.timestamp))}</span>
                        <span class="log-viewer-row-source">${escapeHtml(entry.source)}</span>
                        <span class="log-viewer-row-message">${escapeHtml(entry.message)}</span>
                    </button>
                `;
            }).join('');

            listElement.innerHTML = rendered;
            if (activeRowDomId) {
                listElement.setAttribute('aria-activedescendant', activeRowDomId);
            } else {
                listElement.removeAttribute('aria-activedescendant');
            }
        }

        function renderDetails() {
            const selected = getSelectedEntry();
            const emptyElement = state.elements['log-viewer-detail-empty'];
            const detailCard = state.elements['log-viewer-detail-card'];
            if (!selected) {
                emptyElement.hidden = false;
                detailCard.hidden = true;
                updateActionButtonState();
                return;
            }

            emptyElement.hidden = true;
            detailCard.hidden = false;
            state.elements['log-viewer-detail-id'].textContent = `#${selected.id}`;
            state.elements['log-viewer-detail-level'].textContent = selected.level.toUpperCase();
            state.elements['log-viewer-detail-source'].textContent = selected.source;
            state.elements['log-viewer-detail-time'].textContent = formatTimestamp(selected.timestamp);
            state.elements['log-viewer-detail-message'].textContent = selected.message;
            state.elements['log-viewer-detail-context'].textContent = selected.context || '(no context)';
            updateActionButtonState();
        }

        function applyFilters(preferredEntryId = null) {
            cancelScheduledSearchFilter();
            const searchValue = toSafeString(state.elements['log-viewer-search-input'].value).trim().toLowerCase();
            const levelValue = toSafeString(state.elements['log-viewer-level-filter'].value, 'all').toLowerCase();
            const sourceValue = toSafeString(state.elements['log-viewer-source-filter'].value, 'all').toLowerCase();
            const faultOnly = Boolean(state.elements['log-viewer-fault-toggle'].checked);

            state.filteredEntries = state.entries.filter((entry) => {
                if (levelValue !== 'all' && entry.level !== levelValue) {
                    return false;
                }
                if (sourceValue !== 'all' && entry.source.toLowerCase() !== sourceValue) {
                    return false;
                }
                if (faultOnly && !entry.isFault) {
                    return false;
                }
                if (searchValue) {
                    const haystack = `${entry.message} ${entry.context} ${entry.source}`.toLowerCase();
                    if (!haystack.includes(searchValue)) {
                        return false;
                    }
                }
                return true;
            });

            ensureValidSelection(preferredEntryId);
            renderSummary();
            renderEntries();
            renderDetails();
        }

        function selectEntryByIndex(nextIndex) {
            if (!state.filteredEntries.length) {
                return;
            }

            const boundedIndex = Math.max(0, Math.min(nextIndex, state.filteredEntries.length - 1));
            const nextEntry = state.filteredEntries[boundedIndex];
            if (!nextEntry) {
                return;
            }

            state.selectedEntryId = nextEntry.id;
            renderEntries();
            renderDetails();
            const activeRow = state.elements['log-viewer-list'].querySelector('.log-viewer-row.active');
            if (activeRow) {
                activeRow.scrollIntoView({ block: 'nearest' });
            }
        }

        function getSelectedEntryIndex() {
            return state.filteredEntries.findIndex((entry) => entry.id === state.selectedEntryId);
        }

        async function refreshHistory() {
            if (state.refreshInFlight) {
                return;
            }

            state.refreshInFlight = true;
            state.elements['log-viewer-list'].setAttribute('aria-busy', 'true');
            updateActionButtonState();
            try {
                const response = await ipcRenderer.invoke('get-log-history', {
                    limit: LOG_HISTORY_LIMIT,
                    sort: 'desc'
                });
                if (!response?.success) {
                    notify(response?.error || 'Failed to load diagnostic logs', 'error');
                    return;
                }

                const sourceEntries = Array.isArray(response.entries) ? response.entries : [];
                state.entries = sourceEntries.map((entry, index) => normalizeEntry(entry, index + 1));
                syncNextSyntheticId();
                updateSourceFilterOptions();
                state.elements['log-viewer-log-path'].textContent = response.currentLogFile || response.logDirectory || 'Session memory';
                applyFilters();
            } catch (error) {
                notify(error?.message || 'Failed to load diagnostic logs', 'error');
            } finally {
                state.refreshInFlight = false;
                state.elements['log-viewer-list'].removeAttribute('aria-busy');
                updateActionButtonState();
            }
        }

        async function clearHistory() {
            const confirmed = window.confirm('Clear the in-memory diagnostic history for this session?');
            if (!confirmed) {
                return;
            }

            try {
                const result = await ipcRenderer.invoke('clear-log-history');
                if (!result?.success) {
                    notify(result?.error || 'Failed to clear logs', 'error');
                    return;
                }

                notify('Diagnostic history cleared', 'success');
                await refreshHistory();
            } catch (error) {
                notify(error?.message || 'Failed to clear logs', 'error');
            }
        }

        async function copySelectedEntry() {
            const selected = getSelectedEntry();
            if (!selected) {
                notify('Select a log entry first', 'warning');
                return;
            }

            try {
                const payload = JSON.stringify(selected, null, 2);
                await writeTextToClipboard(payload);
                notify('Selected log entry copied', 'success');
            } catch (error) {
                notify(error?.message || 'Failed to copy selected log entry', 'error');
            }
        }

        async function exportVisibleEntries() {
            if (!state.filteredEntries.length) {
                notify('No visible log entries to export', 'warning');
                return;
            }

            try {
                const exportPayload = {
                    exportedAt: new Date().toISOString(),
                    totalEntries: state.entries.length,
                    visibleEntries: state.filteredEntries.length,
                    entries: state.filteredEntries
                };

                const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
                const objectUrl = URL.createObjectURL(blob);
                const anchor = document.createElement('a');
                const stamp = new Date().toISOString().replace(/[:.]/g, '-');
                anchor.href = objectUrl;
                anchor.download = `diagnostics-log-export-${stamp}.json`;
                document.body.appendChild(anchor);
                anchor.click();
                document.body.removeChild(anchor);
                URL.revokeObjectURL(objectUrl);
                notify('Diagnostics export downloaded', 'success');
            } catch (error) {
                notify(error?.message || 'Failed to export visible log entries', 'error');
            }
        }

        async function openLogFolder() {
            try {
                const result = await ipcRenderer.invoke('open-log-folder');
                if (!result?.success) {
                    notify(result?.error || 'Failed to open log folder', 'error');
                    return;
                }
                notify(`Opened log folder: ${result.path}`, 'success');
            } catch (error) {
                notify(error?.message || 'Failed to open log folder', 'error');
            }
        }

        function handleLiveLogEntry(entry) {
            if (!state.liveUpdatesEnabled) {
                return;
            }

            const normalized = normalizeEntry(entry, state.nextSyntheticId);
            const normalizedId = Number(normalized.id);
            if (Number.isFinite(normalizedId)) {
                state.nextSyntheticId = Math.max(state.nextSyntheticId + 1, normalizedId + 1);
            } else {
                state.nextSyntheticId += 1;
            }
            state.entries.unshift(normalized);
            if (state.entries.length > MAX_ENTRIES_IN_MEMORY) {
                state.entries.length = MAX_ENTRIES_IN_MEMORY;
            }

            updateSourceFilterOptions();
            applyFilters(normalized.id);
            if (state.elements['log-viewer-autoscroll-toggle'].checked) {
                state.elements['log-viewer-list'].scrollTop = 0;
            }
        }

        function bindEvents() {
            const applyFiltersNow = () => {
                cancelScheduledSearchFilter();
                applyFilters();
            };

            state.elements['log-viewer-search-input'].addEventListener('input', () => {
                scheduleSearchFilter();
            });
            state.elements['log-viewer-search-input'].addEventListener('keydown', (event) => {
                const key = toSafeString(event.key, '');
                if (key === 'Enter') {
                    event.preventDefault();
                    applyFiltersNow();
                    return;
                }
                if (key === 'Escape' && state.elements['log-viewer-search-input'].value) {
                    event.preventDefault();
                    state.elements['log-viewer-search-input'].value = '';
                    applyFiltersNow();
                }
            });

            state.elements['log-viewer-level-filter'].addEventListener('change', () => applyFiltersNow());
            state.elements['log-viewer-source-filter'].addEventListener('change', () => applyFiltersNow());
            state.elements['log-viewer-fault-toggle'].addEventListener('change', () => applyFiltersNow());

            state.elements['log-viewer-live-toggle'].addEventListener('change', (event) => {
                state.liveUpdatesEnabled = Boolean(event.target.checked);
            });

            state.elements['log-viewer-refresh-btn'].addEventListener('click', () => {
                void refreshHistory();
            });
            state.elements['log-viewer-clear-btn'].addEventListener('click', () => {
                void clearHistory();
            });
            state.elements['log-viewer-copy-btn'].addEventListener('click', () => {
                void copySelectedEntry();
            });
            state.elements['log-viewer-export-btn'].addEventListener('click', () => {
                void exportVisibleEntries();
            });
            state.elements['log-viewer-open-folder-btn'].addEventListener('click', () => {
                void openLogFolder();
            });

            state.elements['log-viewer-list'].addEventListener('click', (event) => {
                const row = event.target.closest('.log-viewer-row');
                if (!row) {
                    return;
                }
                const nextId = Number(row.getAttribute('data-entry-id'));
                if (!Number.isFinite(nextId)) {
                    return;
                }
                state.selectedEntryId = nextId;
                renderEntries();
                renderDetails();
            });
            if (!state.elements['log-viewer-list'].hasAttribute('tabindex')) {
                state.elements['log-viewer-list'].setAttribute('tabindex', '0');
            }
            state.elements['log-viewer-list'].addEventListener('keydown', (event) => {
                if (!state.filteredEntries.length) {
                    return;
                }

                const key = toSafeString(event.key, '');
                const selectedIndex = getSelectedEntryIndex();
                const fallbackIndex = selectedIndex >= 0 ? selectedIndex : 0;
                if (key === 'ArrowDown') {
                    event.preventDefault();
                    selectEntryByIndex(fallbackIndex + 1);
                    return;
                }
                if (key === 'ArrowUp') {
                    event.preventDefault();
                    selectEntryByIndex(fallbackIndex - 1);
                    return;
                }
                if (key === 'Home') {
                    event.preventDefault();
                    selectEntryByIndex(0);
                    return;
                }
                if (key === 'End') {
                    event.preventDefault();
                    selectEntryByIndex(state.filteredEntries.length - 1);
                    return;
                }
                if (key === 'Enter') {
                    event.preventDefault();
                    void copySelectedEntry();
                }
            });

            document.addEventListener('keydown', (event) => {
                if (typeof getCurrentView === 'function' && getCurrentView() !== 'diagnostics') {
                    return;
                }

                const target = event.target;
                const isTypingContext = Boolean(
                    target && (
                        target.tagName === 'INPUT' ||
                        target.tagName === 'TEXTAREA' ||
                        target.tagName === 'SELECT' ||
                        target.isContentEditable
                    )
                );
                if (isTypingContext) {
                    return;
                }

                const key = toSafeString(event.key, '').toLowerCase();
                if ((event.ctrlKey || event.metaKey) && key === 'f') {
                    event.preventDefault();
                    state.elements['log-viewer-search-input'].focus();
                    state.elements['log-viewer-search-input'].select();
                    return;
                }

                if (key === 'escape') {
                    event.preventDefault();
                    void goBackFromDiagnostics();
                }
            });

            state.elements['log-viewer-back-btn']?.addEventListener('click', () => {
                void goBackFromDiagnostics();
            });
            state.elements['log-viewer-open-docs-btn']?.addEventListener('click', () => {
                void openDocumentationView();
            });
        }

        function initialize() {
            if (state.initialized) {
                return true;
            }
            if (!ipcRenderer || typeof ipcRenderer.invoke !== 'function' || typeof ipcRenderer.on !== 'function') {
                return false;
            }
            if (!cacheElements()) {
                return false;
            }

            bindEvents();
            updateActionButtonState();
            state.unsubscribeLiveLog = ipcRenderer.on('app-log-entry', (_event, entry) => {
                handleLiveLogEntry(entry);
            });
            state.initialized = true;
            return true;
        }

        async function open() {
            if (!initialize()) {
                notify('Diagnostics viewer is unavailable', 'error');
                return false;
            }

            const activeView = typeof getCurrentView === 'function' ? toSafeString(getCurrentView(), '') : '';
            if (activeView && activeView !== 'diagnostics') {
                state.lastSourceView = activeView;
            }

            const switched = await navigateToView('diagnostics');
            if (!switched) {
                return false;
            }
            state.elements['log-viewer-search-input'].focus();
            return true;
        }

        return {
            initialize,
            open,
            refresh: refreshHistory
        };
    }

    window.AppRendererModules = Object.assign({}, window.AppRendererModules, {
        logViewer: {
            createLogViewerController
        }
    });
})();
