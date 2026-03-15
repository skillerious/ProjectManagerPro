/* Runtime module: git/10-github-upload-and-tabs.js */
function initializeGitHubUploadPickerUi() {
    if (githubUploadUiInitialized) {
        return;
    }
    githubUploadUiInitialized = true;

    const searchInput = document.getElementById('gh-upload-search');
    const sortFieldSelect = document.getElementById('gh-upload-sort-field');
    const sortDirectionBtn = document.getElementById('gh-upload-sort-direction');
    const selectAllBtn = document.getElementById('gh-upload-select-all');
    const selectNoneBtn = document.getElementById('gh-upload-select-none');
    const refreshBtn = document.getElementById('gh-upload-refresh');
    const smartExcludeBtn = document.getElementById('gh-upload-smart-exclude');
    const applyExcludeBtn = document.getElementById('gh-upload-apply-exclude');
    const clearExcludeBtn = document.getElementById('gh-upload-clear-exclude');
    const excludeInput = document.getElementById('gh-upload-exclude-patterns');
    const treeContainer = document.getElementById('gh-upload-tree');

    let _ghUploadSearchTimer = null;
    searchInput?.addEventListener('input', () => {
        clearTimeout(_ghUploadSearchTimer);
        _ghUploadSearchTimer = setTimeout(() => {
            githubUploadSearchQuery = searchInput.value.trim().toLowerCase();
            applyGitHubUploadFilter();
            renderGitHubUploadTree();
        }, 180);
    });

    sortFieldSelect?.addEventListener('change', () => {
        githubUploadSortField = sortFieldSelect.value || 'name';
        sortGitHubUploadTree();
        renderGitHubUploadTree();
    });

    sortDirectionBtn?.addEventListener('click', () => {
        githubUploadSortDirection = githubUploadSortDirection === 'asc' ? 'desc' : 'asc';
        updateGitHubSortDirectionUi();
        sortGitHubUploadTree();
        renderGitHubUploadTree();
    });

    selectAllBtn?.addEventListener('click', () => {
        setGitHubUploadSelectionForAll(true);
        renderGitHubUploadTree();
    });

    selectNoneBtn?.addEventListener('click', () => {
        setGitHubUploadSelectionForAll(false);
        renderGitHubUploadTree();
    });

    refreshBtn?.addEventListener('click', async () => {
        if (!githubUploadActiveProjectPath) {
            return;
        }
        await loadGitHubUploadCandidates(githubUploadActiveProjectPath);
    });

    smartExcludeBtn?.addEventListener('click', () => {
        applyGitHubSmartExclusions();
    });

    applyExcludeBtn?.addEventListener('click', () => {
        applyGitHubUploadExcludePatterns({ silent: false });
    });

    clearExcludeBtn?.addEventListener('click', () => {
        githubUploadExcludeDraft = '';
        githubUploadExcludePatterns = [];
        if (excludeInput) {
            excludeInput.value = '';
        }
        applyGitHubUploadExcludePatterns({ silent: false });
    });

    excludeInput?.addEventListener('input', () => {
        githubUploadExcludeDraft = excludeInput.value;
        updateGitHubUploadExcludeHint();
    });

    excludeInput?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            applyGitHubUploadExcludePatterns({ silent: false });
        }
    });

    treeContainer?.addEventListener('click', (event) => {
        const expandBtn = event.target.closest('.gh-file-expand-btn');
        if (expandBtn) {
            const targetPath = expandBtn.dataset.path || '';
            if (!targetPath) {
                return;
            }

            if (githubUploadExpandedPaths.has(targetPath)) {
                githubUploadExpandedPaths.delete(targetPath);
            } else {
                githubUploadExpandedPaths.add(targetPath);
            }
            renderGitHubUploadTree();
            return;
        }

        const row = event.target.closest('.gh-file-row[data-path]');
        if (!row || event.target.closest('.gh-file-check')) {
            return;
        }

        const nodePath = row.dataset.path || '';
        const node = githubUploadNodeMap.get(nodePath);
        if (!node || node.type !== 'directory') {
            return;
        }

        if (githubUploadExpandedPaths.has(nodePath)) {
            githubUploadExpandedPaths.delete(nodePath);
        } else {
            githubUploadExpandedPaths.add(nodePath);
        }
        renderGitHubUploadTree();
    });

    treeContainer?.addEventListener('change', (event) => {
        const checkbox = event.target.closest('.gh-file-check-input');
        if (!checkbox) {
            return;
        }

        const nodePath = checkbox.dataset.path || '';
        const node = githubUploadNodeMap.get(nodePath);
        if (!node) {
            return;
        }
        if (node.excludedByPattern) {
            checkbox.checked = false;
            return;
        }

        setGitHubUploadNodeSelection(node, checkbox.checked);
        updateGitHubUploadAncestorStates(node.parentPath);
        renderGitHubUploadTree();
    });

    treeContainer?.addEventListener('wheel', (event) => {
        if (!treeContainer) {
            return;
        }

        const canScroll = treeContainer.scrollHeight > treeContainer.clientHeight + 1;
        if (!canScroll) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }

        const atTop = treeContainer.scrollTop <= 0;
        const atBottom = treeContainer.scrollTop + treeContainer.clientHeight >= treeContainer.scrollHeight - 1;
        if ((event.deltaY < 0 && atTop) || (event.deltaY > 0 && atBottom)) {
            event.preventDefault();
        }
        event.stopPropagation();
    }, { passive: false });

    updateGitHubSortDirectionUi();
}

async function loadGitHubUploadCandidates(projectPath) {
    const treeContainer = document.getElementById('gh-upload-tree');
    const summaryEl = document.getElementById('gh-upload-selection-summary');
    const excludeInput = document.getElementById('gh-upload-exclude-patterns');

    if (!treeContainer) {
        githubUploadLoadingCandidates = false;
        updateGitHubUploadSubmitState();
        return;
    }

    githubUploadActiveProjectPath = projectPath || '';
    githubUploadLoadingCandidates = true;
    updateGitHubUploadSubmitState();

    treeContainer.innerHTML = `
        <div class="gh-file-state loading">
            <i class="fas fa-spinner fa-spin"></i>
            <span>Scanning project files...</span>
        </div>
    `;
    if (summaryEl) {
        summaryEl.textContent = 'Loading project structure...';
    }
    if (excludeInput) {
        excludeInput.value = githubUploadExcludeDraft || '';
    }
    updateGitHubUploadExcludeHint();

    try {
        const result = await ipcRenderer.invoke('github-list-upload-candidates', projectPath);
        if (!result || !result.success) {
            throw new Error(result?.error || 'Unable to scan files for upload');
        }

        githubUploadCandidates = Array.isArray(result.items) ? result.items : [];
        buildGitHubUploadTree(githubUploadCandidates);
        applyGitHubUploadExcludePatterns({ silent: true, renderAfterApply: false });
        applyGitHubUploadFilter();
        renderGitHubUploadTree();

        if (result.truncated) {
            showNotification('Large project detected: file list truncated for performance', 'warning');
        }
    } catch (error) {
        githubUploadCandidates = [];
        githubUploadNodeMap = new Map();
        githubUploadRootNodes = [];
        githubUploadExpandedPaths = new Set();
        githubUploadExcludedByPatternCount = 0;
        treeContainer.innerHTML = `
            <div class="gh-file-state error">
                <i class="fas fa-exclamation-triangle"></i>
                <span>${escapeHtml(error.message || 'Failed to load upload candidates')}</span>
            </div>
        `;
        if (summaryEl) {
            summaryEl.textContent = 'Unable to load file selection.';
        }
    } finally {
        githubUploadLoadingCandidates = false;
        updateGitHubUploadSubmitState();
    }
}

function shouldGitHubUploadNodeBeSelectedByDefault(pathValue, type, size) {
    const normalizedPath = typeof pathValue === 'string'
        ? pathValue.replace(/\\/g, '/').trim()
        : '';
    if (!normalizedPath) {
        return false;
    }

    const segments = normalizedPath.split('/').map((segment) => segment.toLowerCase());
    if (segments.some((segment) => GITHUB_UPLOAD_DEFAULT_EXCLUDED_DIRS.has(segment))) {
        return false;
    }

    if (type === 'file' && Number(size) > GITHUB_UPLOAD_AUTO_DESELECT_FILE_SIZE_BYTES) {
        return false;
    }

    if (doesGitHubUploadPathMatchExcludePatterns(normalizedPath, githubUploadExcludeRegexes)) {
        return false;
    }

    return true;
}

function normalizeGitHubUploadExcludePattern(rawPattern) {
    const source = typeof rawPattern === 'string'
        ? rawPattern.replace(/\\/g, '/').trim()
        : '';
    if (!source) {
        return '';
    }

    return source
        .replace(/^\.\//, '')
        .replace(/^\/+/, '')
        .replace(/\/+/g, '/');
}

function escapeRegexForGitHubUploadPattern(value) {
    return String(value || '').replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function compileGitHubUploadExcludePattern(pattern) {
    const normalizedPattern = normalizeGitHubUploadExcludePattern(pattern);
    if (!normalizedPattern) {
        return null;
    }

    let regexSource = '';
    for (let index = 0; index < normalizedPattern.length; index += 1) {
        const character = normalizedPattern[index];
        const nextCharacter = normalizedPattern[index + 1];
        if (character === '*' && nextCharacter === '*') {
            regexSource += '.*';
            index += 1;
            continue;
        }
        if (character === '*') {
            regexSource += '[^/]*';
            continue;
        }
        if (character === '?') {
            regexSource += '[^/]';
            continue;
        }
        regexSource += escapeRegexForGitHubUploadPattern(character);
    }

    if (!regexSource) {
        return null;
    }

    const hasPathSeparator = normalizedPattern.includes('/');
    const finalRegex = hasPathSeparator
        ? `^${regexSource}$`
        : `(?:^|/)${regexSource}$`;

    try {
        return new RegExp(finalRegex, 'i');
    } catch {
        return null;
    }
}

function parseGitHubUploadExcludePatternDraft(rawDraft) {
    const source = typeof rawDraft === 'string' ? rawDraft : '';
    if (!source.trim()) {
        return {
            valid: true,
            patterns: [],
            regexes: [],
            message: 'No exclusion patterns set.'
        };
    }

    const chunks = source
        .split(/[\n,]+/)
        .map((chunk) => normalizeGitHubUploadExcludePattern(chunk))
        .filter(Boolean);

    if (chunks.length > 120) {
        return {
            valid: false,
            patterns: [],
            regexes: [],
            message: 'Too many exclusion patterns. Use 120 or fewer.'
        };
    }

    const patterns = [];
    const regexes = [];
    const seen = new Set();
    for (const chunk of chunks) {
        if (chunk.length > 260 || /[\0\r]/.test(chunk)) {
            return {
                valid: false,
                patterns: [],
                regexes: [],
                message: `Invalid exclusion pattern: ${chunk}`
            };
        }
        if (chunk.startsWith('!')) {
            return {
                valid: false,
                patterns: [],
                regexes: [],
                message: `Negation patterns are not supported: ${chunk}`
            };
        }

        if (seen.has(chunk.toLowerCase())) {
            continue;
        }
        const regex = compileGitHubUploadExcludePattern(chunk);
        if (!regex) {
            return {
                valid: false,
                patterns: [],
                regexes: [],
                message: `Invalid exclusion pattern: ${chunk}`
            };
        }
        seen.add(chunk.toLowerCase());
        patterns.push(chunk);
        regexes.push(regex);
    }

    return {
        valid: true,
        patterns,
        regexes,
        message: `${patterns.length} exclusion pattern${patterns.length === 1 ? '' : 's'} active.`
    };
}

function doesGitHubUploadPathMatchExcludePatterns(pathValue, compiledRegexes = githubUploadExcludeRegexes) {
    if (!Array.isArray(compiledRegexes) || compiledRegexes.length === 0) {
        return false;
    }
    const normalizedPath = typeof pathValue === 'string'
        ? pathValue.replace(/\\/g, '/').trim()
        : '';
    if (!normalizedPath) {
        return false;
    }

    return compiledRegexes.some((regex) => regex && regex.test(normalizedPath));
}

function updateGitHubUploadExcludeHint(validation = null) {
    const excludeInput = document.getElementById('gh-upload-exclude-patterns');
    const hintEl = document.getElementById('gh-upload-exclude-hint');
    const resolvedValidation = validation || parseGitHubUploadExcludePatternDraft(githubUploadExcludeDraft || excludeInput?.value || '');

    if (excludeInput) {
        excludeInput.classList.toggle('invalid', !resolvedValidation.valid);
    }
    if (!hintEl) {
        return resolvedValidation;
    }

    if (!resolvedValidation.valid) {
        hintEl.classList.add('invalid');
        hintEl.textContent = resolvedValidation.message || 'Exclude patterns are invalid.';
        return resolvedValidation;
    }

    hintEl.classList.remove('invalid');
    if (resolvedValidation.patterns.length === 0) {
        hintEl.innerHTML = 'Use comma-separated glob patterns. Supports <code>*</code>, <code>?</code>, and <code>**</code>.';
        return resolvedValidation;
    }

    hintEl.textContent = `${resolvedValidation.message} Excluded files cannot be selected.`;
    return resolvedValidation;
}

function applyGitHubUploadExcludePatterns(options = {}) {
    const {
        silent = false,
        renderAfterApply = true
    } = options;

    const excludeInput = document.getElementById('gh-upload-exclude-patterns');
    const validation = parseGitHubUploadExcludePatternDraft(excludeInput?.value ?? githubUploadExcludeDraft);
    githubUploadExcludeDraft = excludeInput?.value ?? githubUploadExcludeDraft;

    if (!validation.valid) {
        updateGitHubUploadExcludeHint(validation);
        updateGitHubUploadSubmitState();
        if (!silent) {
            showNotification(validation.message || 'Exclude patterns are invalid', 'error');
        }
        return false;
    }

    githubUploadExcludePatterns = validation.patterns;
    githubUploadExcludeRegexes = validation.regexes;
    githubUploadExcludedByPatternCount = 0;
    updateGitHubUploadExcludeHint(validation);

    const applyToNode = (node, inheritedExcluded = false) => {
        const selfExcluded = doesGitHubUploadPathMatchExcludePatterns(node.path, githubUploadExcludeRegexes);
        const excluded = inheritedExcluded || selfExcluded;
        node.excludedByPattern = excluded;

        if (excluded) {
            node.selected = false;
            node.indeterminate = false;
            if (node.type === 'file') {
                githubUploadExcludedByPatternCount += 1;
            }
        }

        node.children.forEach((child) => {
            applyToNode(child, excluded);
        });

        if (node.type === 'directory' && !excluded) {
            const allSelected = node.children.length > 0 && node.children.every((child) => child.selected && !child.indeterminate);
            const anySelected = node.children.some((child) => child.selected || child.indeterminate);
            node.selected = allSelected;
            node.indeterminate = !allSelected && anySelected;
        }
    };

    githubUploadRootNodes.forEach((rootNode) => {
        applyToNode(rootNode, false);
    });

    if (renderAfterApply) {
        applyGitHubUploadFilter();
        renderGitHubUploadTree();
    } else {
        updateGitHubUploadSummary();
        updateGitHubUploadSubmitState();
    }

    if (!silent) {
        if (validation.patterns.length === 0) {
            showNotification('Exclude patterns cleared', 'info');
        } else {
            showNotification(`Applied ${validation.patterns.length} exclusion pattern${validation.patterns.length === 1 ? '' : 's'}`, 'success');
        }
    }
    return true;
}

function getGitHubUploadExcludePatternValidation() {
    const excludeInput = document.getElementById('gh-upload-exclude-patterns');
    return parseGitHubUploadExcludePatternDraft(excludeInput?.value ?? githubUploadExcludeDraft);
}

function collectGitHubUploadExcludePatterns() {
    return Array.isArray(githubUploadExcludePatterns) ? [...githubUploadExcludePatterns] : [];
}

function applyGitHubSmartExclusions() {
    const candidatePatterns = new Set(collectGitHubUploadExcludePatterns().map((pattern) => pattern.toLowerCase()));
    const mergedPatterns = collectGitHubUploadExcludePatterns();
    const tryAddPattern = (pattern) => {
        const normalized = normalizeGitHubUploadExcludePattern(pattern);
        if (!normalized) {
            return;
        }
        const key = normalized.toLowerCase();
        if (candidatePatterns.has(key)) {
            return;
        }
        candidatePatterns.add(key);
        mergedPatterns.push(normalized);
    };

    githubUploadNodeMap.forEach((node) => {
        if (node.type !== 'file') {
            return;
        }
        const extension = getFileExtension(node.name);
        if (extension && GITHUB_UPLOAD_SMART_EXCLUDE_EXTENSIONS.has(extension)) {
            tryAddPattern(`*.${extension}`);
        }
        if (Number(node.size) > GITHUB_UPLOAD_SMART_EXCLUDE_FILE_SIZE_BYTES) {
            if (extension) {
                tryAddPattern(`*.${extension}`);
            } else {
                tryAddPattern(node.path);
            }
        }
    });

    if (mergedPatterns.length === githubUploadExcludePatterns.length) {
        showNotification('No additional risky files detected for smart exclusion', 'info');
        return;
    }

    githubUploadExcludeDraft = mergedPatterns.join(', ');
    const excludeInput = document.getElementById('gh-upload-exclude-patterns');
    if (excludeInput) {
        excludeInput.value = githubUploadExcludeDraft;
    }

    applyGitHubUploadExcludePatterns({ silent: false });
}

function syncGitHubUploadDirectorySelection(node) {
    if (!node || node.type !== 'directory') {
        return;
    }

    node.children.forEach((child) => {
        if (child.type === 'directory') {
            syncGitHubUploadDirectorySelection(child);
        }
    });

    if (node.children.length === 0) {
        node.selected = false;
        node.indeterminate = false;
        return;
    }

    const allSelected = node.children.every((child) => child.selected && !child.indeterminate);
    const anySelected = node.children.some((child) => child.selected || child.indeterminate);
    node.selected = allSelected;
    node.indeterminate = !allSelected && anySelected;
}

function buildGitHubUploadTree(items) {
    githubUploadNodeMap = new Map();
    githubUploadRootNodes = [];
    githubUploadExpandedPaths = new Set();

    for (const item of items) {
        const normalizedPath = typeof item.path === 'string'
            ? item.path.replace(/\\/g, '/').trim()
            : '';
        if (!normalizedPath) {
            continue;
        }

        const parentPath = typeof item.parentPath === 'string'
            ? item.parentPath.replace(/\\/g, '/').trim()
            : '';

        githubUploadNodeMap.set(normalizedPath, {
            path: normalizedPath,
            parentPath,
            name: item.name || normalizedPath.split('/').pop() || normalizedPath,
            type: item.type === 'directory' ? 'directory' : 'file',
            size: Number(item.size) || 0,
            mtimeMs: Number(item.mtimeMs) || 0,
            children: [],
            selected: shouldGitHubUploadNodeBeSelectedByDefault(
                normalizedPath,
                item.type === 'directory' ? 'directory' : 'file',
                Number(item.size) || 0
            ),
            indeterminate: false,
            visible: true,
            fileCount: item.type === 'directory' ? 0 : 1,
            totalSize: Number(item.size) || 0,
            excludedByPattern: false
        });
    }

    for (const node of githubUploadNodeMap.values()) {
        if (node.parentPath && githubUploadNodeMap.has(node.parentPath)) {
            githubUploadNodeMap.get(node.parentPath).children.push(node);
        } else {
            githubUploadRootNodes.push(node);
        }
    }

    for (const rootNode of githubUploadRootNodes) {
        computeGitHubUploadNodeAggregates(rootNode);
        if (rootNode.type === 'directory') {
            syncGitHubUploadDirectorySelection(rootNode);
        }
        if (rootNode.type === 'directory') {
            githubUploadExpandedPaths.add(rootNode.path);
        }
    }

    sortGitHubUploadTree();
}

function sortGitHubUploadTree() {
    const sortRecursive = (nodes) => {
        nodes.sort(compareGitHubUploadNodes);
        nodes.forEach((node) => {
            if (node.children.length > 0) {
                sortRecursive(node.children);
            }
        });
    };

    sortRecursive(githubUploadRootNodes);
}

function compareGitHubUploadNodes(a, b) {
    if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
    }

    const direction = githubUploadSortDirection === 'desc' ? -1 : 1;
    const field = githubUploadSortField;
    let valueA;
    let valueB;

    if (field === 'size') {
        valueA = a.type === 'directory' ? a.totalSize : a.size;
        valueB = b.type === 'directory' ? b.totalSize : b.size;
        if (valueA !== valueB) {
            return direction * (valueA - valueB);
        }
    } else if (field === 'modified') {
        valueA = a.mtimeMs || 0;
        valueB = b.mtimeMs || 0;
        if (valueA !== valueB) {
            return direction * (valueA - valueB);
        }
    } else if (field === 'type') {
        const extA = a.type === 'directory' ? 'directory' : getFileExtension(a.name);
        const extB = b.type === 'directory' ? 'directory' : getFileExtension(b.name);
        const extCompare = extA.localeCompare(extB, undefined, { numeric: true, sensitivity: 'base' });
        if (extCompare !== 0) {
            return direction * extCompare;
        }
    }

    return direction * a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

function computeGitHubUploadNodeAggregates(node) {
    if (node.type === 'file') {
        node.fileCount = 1;
        node.totalSize = Number(node.size) || 0;
        return;
    }

    let totalFiles = 0;
    let totalSize = 0;
    let latestMtime = Number(node.mtimeMs) || 0;
    node.children.forEach((child) => {
        computeGitHubUploadNodeAggregates(child);
        totalFiles += child.fileCount;
        totalSize += child.totalSize;
        latestMtime = Math.max(latestMtime, Number(child.mtimeMs) || 0);
    });

    node.fileCount = totalFiles;
    node.totalSize = totalSize;
    node.mtimeMs = latestMtime;
}

function applyGitHubUploadFilter() {
    const query = githubUploadSearchQuery;

    const applyVisibility = (node) => {
        const selfMatch = !query || node.name.toLowerCase().includes(query) || node.path.toLowerCase().includes(query);
        let childMatch = false;
        node.children.forEach((child) => {
            if (applyVisibility(child)) {
                childMatch = true;
            }
        });

        node.visible = selfMatch || childMatch;
        if (query && childMatch && node.type === 'directory') {
            githubUploadExpandedPaths.add(node.path);
        }
        return node.visible;
    };

    githubUploadRootNodes.forEach((rootNode) => {
        applyVisibility(rootNode);
    });
}

function renderGitHubUploadTree() {
    const treeContainer = document.getElementById('gh-upload-tree');
    if (!treeContainer) {
        return;
    }

    if (githubUploadNodeMap.size === 0) {
        treeContainer.innerHTML = `
            <div class="gh-file-state empty">
                <i class="fas fa-folder-open"></i>
                <span>No files found in this project folder.</span>
            </div>
        `;
        updateGitHubUploadSummary();
        updateGitHubUploadSubmitState();
        return;
    }

    const rows = [];
    collectGitHubUploadRows(githubUploadRootNodes, 0, rows);

    if (rows.length === 0) {
        treeContainer.innerHTML = `
            <div class="gh-file-state empty">
                <i class="fas fa-search"></i>
                <span>No files match your current filter.</span>
            </div>
        `;
        updateGitHubUploadSummary();
        updateGitHubUploadSubmitState();
        return;
    }

    treeContainer.innerHTML = rows.map((row) => {
        const node = row.node;
        const canExpand = node.type === 'directory';
        const isExpanded = canExpand && githubUploadExpandedPaths.has(node.path);
        const checkedAttr = node.selected && !node.indeterminate && !node.excludedByPattern ? 'checked' : '';
        const indeterminateAttr = node.indeterminate ? 'true' : 'false';
        const disabledAttr = node.excludedByPattern ? 'disabled' : '';
        const folderMeta = `${node.fileCount} file${node.fileCount === 1 ? '' : 's'} | ${formatBytesForDisplay(node.totalSize)}`;
        const fileMeta = node.excludedByPattern
            ? 'Excluded by pattern'
            : `${formatBytesForDisplay(node.size)} | ${formatTimestampForDisplay(node.mtimeMs)}`;

        return `
            <div class="gh-file-row ${node.type} ${node.excludedByPattern ? 'excluded' : ''}" data-path="${escapeHtml(node.path)}" style="--gh-depth:${row.depth};">
                <button type="button" class="gh-file-expand-btn ${canExpand ? '' : 'placeholder'} ${isExpanded ? 'expanded' : ''}" data-path="${escapeHtml(node.path)}" ${canExpand ? '' : 'tabindex="-1" aria-hidden="true"'}>
                    <i class="fas fa-chevron-right"></i>
                </button>
                <label class="gh-file-check ${node.indeterminate ? 'indeterminate' : ''}" title="${node.excludedByPattern ? 'Excluded by pattern' : 'Select for upload'}">
                    <input class="gh-file-check-input" type="checkbox" data-path="${escapeHtml(node.path)}" ${checkedAttr} data-indeterminate="${indeterminateAttr}" ${disabledAttr} />
                    <span class="gh-file-checkmark"></span>
                </label>
                <div class="gh-file-icon">
                    <i class="${escapeHtml(getGitHubUploadNodeIcon(node, isExpanded))}"></i>
                </div>
                <div class="gh-file-text">
                    <span class="gh-file-name">${escapeHtml(node.name)}</span>
                    <span class="gh-file-path">${escapeHtml(node.path)}</span>
                </div>
                <div class="gh-file-meta">${escapeHtml(node.type === 'directory' ? folderMeta : fileMeta)}</div>
            </div>
        `;
    }).join('');

    treeContainer.querySelectorAll('.gh-file-check-input[data-indeterminate="true"]').forEach((input) => {
        input.indeterminate = true;
    });

    updateGitHubUploadSummary();
    updateGitHubUploadSubmitState();
}

function collectGitHubUploadRows(nodes, depth, rows) {
    nodes.forEach((node) => {
        if (!node.visible) {
            return;
        }

        rows.push({ node, depth });
        if (node.type === 'directory' && githubUploadExpandedPaths.has(node.path)) {
            collectGitHubUploadRows(node.children, depth + 1, rows);
        }
    });
}

function setGitHubUploadSelectionForAll(selected) {
    githubUploadRootNodes.forEach((rootNode) => {
        setGitHubUploadNodeSelection(rootNode, selected);
    });
}

function setGitHubUploadNodeSelection(node, selected) {
    if (node.excludedByPattern) {
        node.selected = false;
        node.indeterminate = false;
        node.children.forEach((child) => {
            setGitHubUploadNodeSelection(child, false);
        });
        return;
    }

    node.selected = selected;
    node.indeterminate = false;
    node.children.forEach((child) => {
        setGitHubUploadNodeSelection(child, selected);
    });
}

function updateGitHubUploadAncestorStates(parentPath) {
    let cursor = parentPath;
    while (cursor && githubUploadNodeMap.has(cursor)) {
        const parentNode = githubUploadNodeMap.get(cursor);
        if (parentNode.excludedByPattern) {
            parentNode.selected = false;
            parentNode.indeterminate = false;
            cursor = parentNode.parentPath;
            continue;
        }
        const children = parentNode.children;
        if (children.length === 0) {
            parentNode.selected = false;
            parentNode.indeterminate = false;
        } else {
            const allSelected = children.every((child) => child.selected && !child.indeterminate);
            const anySelected = children.some((child) => child.selected || child.indeterminate);
            parentNode.selected = allSelected;
            parentNode.indeterminate = !allSelected && anySelected;
        }
        cursor = parentNode.parentPath;
    }
}

function updateGitHubUploadSummary() {
    const summaryEl = document.getElementById('gh-upload-selection-summary');
    if (!summaryEl) {
        return;
    }

    const selectedPathspecs = collectGitHubUploadPathspecs();
    let selectedFileCount = 0;
    let selectedBytes = 0;
    let excludedFileCount = 0;
    githubUploadNodeMap.forEach((node) => {
        if (node.type === 'file' && node.excludedByPattern) {
            excludedFileCount += 1;
        }
        if (node.type === 'file' && node.selected) {
            selectedFileCount += 1;
            selectedBytes += Number(node.size) || 0;
        }
    });
    githubUploadExcludedByPatternCount = excludedFileCount;

    const excludedText = excludedFileCount > 0
        ? ` | ${excludedFileCount} excluded`
        : '';
    summaryEl.textContent = `${selectedPathspecs.length} item${selectedPathspecs.length === 1 ? '' : 's'} selected | ${selectedFileCount} file${selectedFileCount === 1 ? '' : 's'} | ${formatBytesForDisplay(selectedBytes)}${excludedText}`;
}

function collectGitHubUploadPathspecs() {
    if (githubUploadNodeMap.size === 0) {
        return [];
    }

    const pathspecs = [];
    const nodes = Array.from(githubUploadNodeMap.values())
        .filter((node) => node.selected && !node.indeterminate && !node.excludedByPattern)
        .sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));

    for (const node of nodes) {
        if (!hasSelectedGitHubUploadAncestor(node.path)) {
            pathspecs.push(node.path);
        }
    }

    return pathspecs;
}

function hasSelectedGitHubUploadAncestor(nodePath) {
    let cursor = githubUploadNodeMap.get(nodePath)?.parentPath;
    while (cursor && githubUploadNodeMap.has(cursor)) {
        const ancestor = githubUploadNodeMap.get(cursor);
        if (ancestor.selected && !ancestor.indeterminate) {
            return true;
        }
        cursor = ancestor.parentPath;
    }
    return false;
}

function getGitHubUploadNodeIcon(node, isExpanded) {
    if (node.type === 'directory') {
        return isExpanded ? 'fas fa-folder-open' : 'fas fa-folder';
    }

    const extension = getFileExtension(node.name);
    if (['js', 'ts', 'tsx', 'jsx'].includes(extension)) {
        return 'fas fa-file-code';
    }
    if (['json', 'yml', 'yaml', 'toml', 'ini'].includes(extension)) {
        return 'fas fa-file-alt';
    }
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'].includes(extension)) {
        return 'fas fa-file-image';
    }
    if (['zip', 'tar', 'gz', '7z'].includes(extension)) {
        return 'fas fa-file-archive';
    }
    if (['md', 'txt', 'log'].includes(extension)) {
        return 'fas fa-file-alt';
    }
    return 'fas fa-file';
}

function getFileExtension(filename) {
    const index = filename.lastIndexOf('.');
    if (index <= 0 || index === filename.length - 1) {
        return '';
    }
    return filename.slice(index + 1).toLowerCase();
}

function formatBytesForDisplay(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) {
        return `${value} B`;
    }
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = value / 1024;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index += 1;
    }
    const precision = size >= 100 ? 0 : size >= 10 ? 1 : 2;
    return `${size.toFixed(precision)} ${units[index]}`;
}

function formatTimestampForDisplay(timestamp) {
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
        return 'Unknown';
    }
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
        return 'Unknown';
    }
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function updateGitHubSortDirectionUi() {
    const sortDirectionBtn = document.getElementById('gh-upload-sort-direction');
    if (!sortDirectionBtn) {
        return;
    }
    const isAsc = githubUploadSortDirection === 'asc';
    sortDirectionBtn.dataset.direction = githubUploadSortDirection;
    sortDirectionBtn.title = isAsc ? 'Sort ascending' : 'Sort descending';
    sortDirectionBtn.innerHTML = isAsc
        ? '<i class="fas fa-sort-amount-down-alt"></i>'
        : '<i class="fas fa-sort-amount-up-alt"></i>';
}

// Git Helper Functions

async function loadProjectsIntoDropdown(options = {}) {
    const force = options.force === true;
    if (force) {
        gitProjectsDropdownCache.clear();
    }

    let projects = [];
    try {
        projects = await gitProjectsDropdownCache.get('all-projects', async () => {
            const loadedProjects = await ipcRenderer.invoke('get-projects');
            return Array.isArray(loadedProjects) ? loadedProjects : [];
        });
    } catch (error) {
        console.error('[GIT] Failed to load projects:', error);
        projects = [];
    }

    const menuBody = document.getElementById('git-projects-menu-body');
    if (!menuBody) return;

    if (!projects || projects.length === 0) {
        menuBody.innerHTML = `
            <div class="git-projects-menu-empty">
                <i class="fas fa-folder-open"></i>
                <p>No projects found</p>
                <small>Create a project or clone a repository to get started</small>
            </div>
        `;
        return;
    }

    menuBody.innerHTML = projects.map(project => {
        const isActive = currentProject && currentProject.path === project.path;
        const safeProjectPath = escapeHtml(project.path || '');
        const safeProjectName = escapeHtml(project.name || '');
        const safeProjectType = escapeHtml(project.type || '');

        return `
            <div class="git-projects-menu-item ${isActive ? 'active' : ''}" data-path="${safeProjectPath}" data-name="${safeProjectName}">
                <i class="fas fa-folder"></i>
                <div class="git-projects-menu-item-content">
                    <span class="git-projects-menu-item-name">${safeProjectName}</span>
                    <span class="git-projects-menu-item-path">${safeProjectPath}</span>
                </div>
                ${project.type ? `<span class="git-projects-menu-item-badge">${safeProjectType}</span>` : ''}
            </div>
        `;
    }).join('');

    // Add click handlers
    document.querySelectorAll('.git-projects-menu-item').forEach(item => {
        item.addEventListener('click', async () => {
            const itemPath = item.dataset.path;
            const name = item.dataset.name;
            if (!itemPath || !name) return;

            currentProject = { name, path: itemPath };
            updateSelectedProject();

            try {
                // Start file watcher for real-time updates
                await ipcRenderer.invoke('start-file-watcher', itemPath);
            } catch (error) {
                console.error('[GIT] Failed to start file watcher:', error);
            }

            await refreshGitStatus();
            const menu = document.getElementById('git-projects-menu');
            const btn = document.getElementById('git-project-dropdown-btn');
            if (menu) menu.classList.remove('show');
            if (btn) btn.classList.remove('active');
        });
    });
}

function filterProjectsInDropdown(query) {
    const items = document.querySelectorAll('.git-projects-menu-item');
    const lowerQuery = (query || '').toLowerCase();

    items.forEach(item => {
        const name = (item.dataset.name || '').toLowerCase();
        const itemPath = (item.dataset.path || '').toLowerCase();

        if (name.includes(lowerQuery) || itemPath.includes(lowerQuery)) {
            item.style.display = 'flex';
        } else {
            item.style.display = 'none';
        }
    });
}

function updateSelectedProject() {
    const nameEl = document.getElementById('git-selected-project-name');
    const pathEl = document.getElementById('git-selected-project-path');

    if (!currentProject) {
        if (nameEl) nameEl.textContent = 'No repository selected';
        if (pathEl) pathEl.textContent = 'Select a project to manage';
        setStatusProjectName(null);
        setStatusGitBranch('--');

        // Clear status badges
        const badgesContainer = document.getElementById('git-repo-status-badges');
        if (badgesContainer) {
            badgesContainer.innerHTML = '';
        }
        return;
    }

    if (nameEl) nameEl.textContent = currentProject.name;
    if (pathEl) pathEl.textContent = currentProject.path;
    setStatusProjectName(currentProject.name);
    void refreshStatusBranch();

    // Add file watcher badge
    const badgesContainer = document.getElementById('git-repo-status-badges');
    if (badgesContainer) {
        badgesContainer.innerHTML = `
            <div class="git-status-badge watching" title="Real-time file monitoring active">
                <i class="fas fa-eye"></i>
                <span>Watching</span>
            </div>
        `;
    }
}

async function updateGitHubStatus() {
    let result;
    try {
        result = await ipcRenderer.invoke('github-get-user');
    } catch (error) {
        console.error('[GitHub] Failed to get user status:', error);
        return;
    }

    const statusDiv = document.getElementById('github-status');
    const actionsDiv = document.getElementById('github-actions');
    if (!statusDiv || !actionsDiv) {
        updateGitHubLoginModalState();
        return;
    }

    if (result.success && result.user) {
        githubUserData = result.user;
        githubLastSyncedAt = new Date();
        updateGitHubAvatar();
        setStatusConnectionState(true);
        const safeLogin = escapeHtml(result.user.login || 'Unknown');
        const safeEmail = escapeHtml(result.user.email || 'No email');
        statusDiv.innerHTML = `
            <div class="github-connected">
                <div class="github-connected-identity">
                    <div class="github-connected-icon">
                        <i class="fab fa-github"></i>
                    </div>
                    <div class="github-user-info">
                        <div class="github-connection-badge">
                            <i class="fas fa-check-circle"></i>
                            <span>Connected</span>
                        </div>
                        <div class="github-username">@${safeLogin}</div>
                        <div class="github-email">${safeEmail}</div>
                    </div>
                </div>
                <button class="github-disconnect-btn" id="github-disconnect-btn-inline">
                    <i class="fas fa-unlink"></i> Disconnect
                </button>
            </div>
        `;
        actionsDiv.style.display = 'flex';
        const placeholder = document.getElementById('github-actions-placeholder');
        if (placeholder) placeholder.style.display = 'none';

        // Add disconnect handler (fresh element each time innerHTML is set, so no leak)
        document.getElementById('github-disconnect-btn-inline')?.addEventListener('click', async () => {
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
    } else {
        githubUserData = null;
        githubLastSyncedAt = null;
        updateGitHubAvatar();
        setStatusConnectionState(false);
        statusDiv.innerHTML = `
            <div class="github-not-connected">
                <div class="github-empty-state">
                    <div class="github-empty-hero">
                        <div class="github-empty-icon-wrap">
                            <i class="fab fa-github"></i>
                        </div>
                        <h4 class="github-empty-title">Connect your GitHub account</h4>
                        <p class="github-empty-subtitle">Create repositories, publish branches, open pull requests, and track issues without leaving AppManager.</p>
                    </div>
                    <div class="github-empty-benefits">
                        <span class="github-empty-benefit"><i class="fas fa-rocket"></i> Fast repository setup</span>
                        <span class="github-empty-benefit"><i class="fas fa-code-branch"></i> PR and branch workflow</span>
                        <span class="github-empty-benefit"><i class="fas fa-shield-alt"></i> Secure token storage</span>
                    </div>
                    <button class="github-connect-cta" id="github-connect-status-btn">
                        <span class="btn-icon"><i class="fab fa-github"></i></span>
                        <span>Connect Account</span>
                    </button>
                    <small class="github-connect-hint">Supports classic and fine-grained personal access tokens.</small>
                </div>
            </div>
        `;
        actionsDiv.style.display = 'none';
        const placeholderEl = document.getElementById('github-actions-placeholder');
        if (placeholderEl) placeholderEl.style.display = '';

        // Add connect handler
        document.getElementById('github-connect-status-btn')?.addEventListener('click', () => {
            openGitHubLoginModal();
        });
    }

    updateGitHubLoginModalState();
    updateGitHubSyncMeta();
}

async function loadBranchesForRebase() {
    if (!currentProject) return;

    const result = await ipcRenderer.invoke('git-branches', currentProject.path);
    const select = document.getElementById('rebase-branch-select');

    if (!select || !result.success || !result.output) return;

    const branches = result.output
        .split('\n')
        .filter(b => b.trim() && !b.trim().startsWith('*'))
        .map(b => b.replace('*', '').trim().replace(/^remotes\//, ''));

    select.innerHTML = '<option value="">Select a branch...</option>' +
        branches.map(branch =>
            `<option value="${escapeHtml(branch)}">${escapeHtml(branch)}</option>`
        ).join('');
}

async function loadGitTags() {
    if (!currentProject) return;

    let result;
    try {
        result = await ipcRenderer.invoke('git-tag-list', currentProject.path);
    } catch (error) {
        showNotification(`Failed to load tags: ${error.message}`, 'error');
        return;
    }
    const tagsList = document.getElementById('git-tags-list');
    if (!tagsList) return;

    if (!result.success || !result.output || result.output.trim() === '') {
        tagsList.innerHTML = `
            <div class="tags-empty">
                <i class="fas fa-tag"></i>
                <p>No tags found</p>
            </div>
        `;
        return;
    }

    const tags = result.output.split('\n').filter(line => line.trim());
    tagsList.innerHTML = tags.map(tag => {
        const parts = tag.split(/\s+/);
        const tagName = parts[0];
        const tagMessage = parts.slice(1).join(' ') || 'No message';
        const encodedTagName = encodeURIComponent(tagName);

        return `
            <div class="tag-item">
                <div class="tag-item-info">
                    <div class="tag-item-name">${escapeHtml(tagName)}</div>
                    <div class="tag-item-message">${escapeHtml(tagMessage)}</div>
                </div>
                <div class="tag-item-actions">
                    <button class="btn-icon" onclick="deleteTag(decodeURIComponent('${encodedTagName}'))" title="Delete tag">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

async function deleteTag(tagName) {
    if (!currentProject) {
        showNotification('No project selected', 'error');
        return;
    }
    const confirmed = typeof requestGitSmartConfirmation === 'function'
        ? await requestGitSmartConfirmation({
            title: 'Delete Tag',
            subtitle: `Delete tag "${tagName}"?`,
            detail: 'This removes the local tag reference.',
            mode: 'danger',
            icon: 'fa-tag',
            confirmLabel: 'Delete Tag',
            confirmVariant: 'danger'
        })
        : confirm(`Delete tag "${tagName}"?`);
    if (!confirmed) return;

    const deleteFromRemote = typeof requestGitSmartConfirmation === 'function'
        ? await requestGitSmartConfirmation({
            title: 'Delete Remote Tag',
            subtitle: 'Also delete this tag from the remote repository?',
            detail: 'Use this when the tag should be removed for all collaborators.',
            mode: 'warning',
            icon: 'fa-cloud-arrow-down',
            confirmLabel: 'Delete Remote Tag'
        })
        : confirm('Also delete from remote?');
    try {
        const result = await ipcRenderer.invoke('git-tag-delete', currentProject.path, tagName, deleteFromRemote);
        if (result.success) {
            showNotification('Tag deleted successfully', 'success');
            await loadGitTags();
        } else {
            showNotification(`Failed to delete tag: ${result.error}`, 'error');
        }
    } catch (error) {
        showNotification(`Delete tag error: ${error.message}`, 'error');
    }
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('git-projects-menu');
    const btn = document.getElementById('git-project-dropdown-btn');

    if (dropdown && btn && !dropdown.contains(e.target) && !btn.contains(e.target)) {
        dropdown.classList.remove('show');
        btn.classList.remove('active');
    }
});

// Git Tabs Functionality
let gitStatusNeedsRefresh = false;
let currentGitTab = 'overview';

function initializeGitTabs() {
    const tabs = document.querySelectorAll('.git-tab');
    const panels = document.querySelectorAll('.git-tab-panel');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const targetTab = tab.dataset.tab;
            currentGitTab = targetTab;

            // Remove active class from all tabs and panels
            tabs.forEach(t => t.classList.remove('active'));
            panels.forEach(p => p.classList.remove('active'));

            // Add active class to clicked tab and corresponding panel
            tab.classList.add('active');
            const targetPanel = document.getElementById(`git-tab-${targetTab}`);
            if (targetPanel) {
                targetPanel.classList.add('active');
            }

            // If switching to changes tab and refresh is pending, do it now
            if (targetTab === 'changes' && gitStatusNeedsRefresh) {
                requestAnimationFrame(() => {
                    refreshGitStatusNow();
                });
            }
        });
    });
}

// ============================================
// EXTENSIONS - PREMIUM REDESIGN
// ============================================

// Sample marketplace extension data — themes include full CSS so they actually work
const MARKETPLACE_EXTENSIONS = [
    // ── THEMES (install as type:'themes' with real CSS) ──
    {
        id: 'synthwave-84', displayName: 'SynthWave \'84', description: 'Retro-futuristic neon theme inspired by the music and aesthetics of the 1980s',
        author: 'Robb Owen', version: '1.2.0', category: 'themes', rating: 4.9, downloads: 3200000, enabled: false, type: 'marketplace',
        installType: 'themes',
        themeCSS: `:root { --bg-primary: #262335; --bg-secondary: #1e1a31; --bg-tertiary: #34294f; --bg-hover: #2f2752; --text-primary: #e0d9f6; --text-secondary: #9d8dc7; --text-highlight: #fff; --accent-primary: #ff7edb; --accent-secondary: #36f9f6; --accent-hover: #e66cc5; --border-color: #4a3a6a; --success: #72f1b8; --warning: #fede5d; --error: #fe4450; --info: #36f9f6; }
.sidebar { background: var(--bg-secondary); } .titlebar { background: var(--bg-secondary); }
.project-card, .extension-card, .ext-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.project-card:hover, .ext-card:hover { border-color: var(--accent-primary); box-shadow: 0 4px 25px rgba(255,126,219,0.2); }
.btn-primary, .ext-btn-primary { background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary)); }
.stat-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.modal-content { background: var(--bg-secondary); border-color: var(--border-color); }`,
        preview: { background: '#262335', accent: '#ff7edb', secondary: '#36f9f6', palette: ['#262335','#ff7edb','#36f9f6','#72f1b8','#fede5d','#fe4450'] },
        tags: ['dark','neon','retro','synthwave']
    },
    {
        id: 'ayu-dark', displayName: 'Ayu Dark', description: 'A simple, bright and elegant theme with carefully selected warm colors',
        author: 'Ayu', version: '3.0.0', category: 'themes', rating: 4.7, downloads: 1800000, enabled: false, type: 'marketplace',
        installType: 'themes',
        themeCSS: `:root { --bg-primary: #0b0e14; --bg-secondary: #0d1017; --bg-tertiary: #131721; --bg-hover: #161b26; --text-primary: #bfbdb6; --text-secondary: #636a76; --text-highlight: #e6e1cf; --accent-primary: #e6b450; --accent-secondary: #ffb454; --accent-hover: #d9a23d; --border-color: #1c2433; --success: #7fd962; --warning: #e6b450; --error: #d95757; --info: #39bae6; }
.sidebar { background: var(--bg-secondary); } .titlebar { background: var(--bg-secondary); }
.project-card, .extension-card, .ext-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.project-card:hover, .ext-card:hover { border-color: var(--accent-primary); box-shadow: 0 4px 20px rgba(230,180,80,0.15); }
.btn-primary, .ext-btn-primary { background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary)); }
.stat-card { background: var(--bg-tertiary); } .modal-content { background: var(--bg-secondary); }`,
        preview: { background: '#0b0e14', accent: '#e6b450', secondary: '#ffb454', palette: ['#0b0e14','#e6b450','#ffb454','#7fd962','#39bae6','#d95757'] },
        tags: ['dark','warm','minimal','elegant']
    },
    {
        id: 'solarized-dark', displayName: 'Solarized Dark', description: 'Precision colors for machines and people — the classic Solarized palette',
        author: 'Ethan Schoonover', version: '2.0.4', category: 'themes', rating: 4.6, downloads: 2400000, enabled: false, type: 'marketplace',
        installType: 'themes',
        themeCSS: `:root { --bg-primary: #002b36; --bg-secondary: #001e27; --bg-tertiary: #073642; --bg-hover: #0a4050; --text-primary: #839496; --text-secondary: #586e75; --text-highlight: #fdf6e3; --accent-primary: #268bd2; --accent-secondary: #2aa198; --accent-hover: #1a7abc; --border-color: #0d4654; --success: #859900; --warning: #b58900; --error: #dc322f; --info: #2aa198; }
.sidebar { background: var(--bg-secondary); } .titlebar { background: var(--bg-secondary); }
.project-card, .extension-card, .ext-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.project-card:hover, .ext-card:hover { border-color: var(--accent-primary); box-shadow: 0 4px 16px rgba(38,139,210,0.15); }
.btn-primary, .ext-btn-primary { background: var(--accent-primary); }
.stat-card { background: var(--bg-tertiary); } .modal-content { background: var(--bg-secondary); }`,
        preview: { background: '#002b36', accent: '#268bd2', secondary: '#2aa198', palette: ['#002b36','#268bd2','#2aa198','#859900','#b58900','#dc322f'] },
        tags: ['dark','classic','solarized','blue']
    },
    {
        id: 'rose-pine', displayName: 'Rose Pine', description: 'All natural pine, faux fur and a bit of soho vibes for the classy minimalist',
        author: 'Rose Pine', version: '2.8.0', category: 'themes', rating: 4.8, downloads: 1500000, enabled: false, type: 'marketplace',
        installType: 'themes',
        themeCSS: `:root { --bg-primary: #191724; --bg-secondary: #1f1d2e; --bg-tertiary: #26233a; --bg-hover: #2a2740; --text-primary: #e0def4; --text-secondary: #908caa; --text-highlight: #e0def4; --accent-primary: #c4a7e7; --accent-secondary: #ebbcba; --accent-hover: #b094d4; --border-color: #393552; --success: #9ccfd8; --warning: #f6c177; --error: #eb6f92; --info: #31748f; }
.sidebar { background: var(--bg-secondary); } .titlebar { background: var(--bg-secondary); }
.project-card, .extension-card, .ext-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.project-card:hover, .ext-card:hover { border-color: var(--accent-primary); box-shadow: 0 4px 20px rgba(196,167,231,0.15); }
.btn-primary, .ext-btn-primary { background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary)); }
.stat-card { background: var(--bg-tertiary); } .modal-content { background: var(--bg-secondary); }`,
        preview: { background: '#191724', accent: '#c4a7e7', secondary: '#ebbcba', palette: ['#191724','#c4a7e7','#ebbcba','#9ccfd8','#f6c177','#eb6f92'] },
        tags: ['dark','pastel','cozy','rose']
    },
    {
        id: 'everforest-dark', displayName: 'Everforest Dark', description: 'Comfortable and pleasant green-tinted theme designed for long coding sessions',
        author: 'Sainnhe Park', version: '1.4.0', category: 'themes', rating: 4.7, downloads: 980000, enabled: false, type: 'marketplace',
        installType: 'themes',
        themeCSS: `:root { --bg-primary: #2d353b; --bg-secondary: #272e33; --bg-tertiary: #343f44; --bg-hover: #3a464c; --text-primary: #d3c6aa; --text-secondary: #859289; --text-highlight: #e4dcc8; --accent-primary: #a7c080; --accent-secondary: #83c092; --accent-hover: #8fb573; --border-color: #475258; --success: #a7c080; --warning: #dbbc7f; --error: #e67e80; --info: #7fbbb3; }
.sidebar { background: var(--bg-secondary); } .titlebar { background: var(--bg-secondary); }
.project-card, .extension-card, .ext-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.project-card:hover, .ext-card:hover { border-color: var(--accent-primary); box-shadow: 0 4px 16px rgba(167,192,128,0.12); }
.btn-primary, .ext-btn-primary { background: var(--accent-primary); color: #2d353b; }
.stat-card { background: var(--bg-tertiary); } .modal-content { background: var(--bg-secondary); }`,
        preview: { background: '#2d353b', accent: '#a7c080', secondary: '#83c092', palette: ['#2d353b','#a7c080','#83c092','#7fbbb3','#dbbc7f','#e67e80'] },
        tags: ['dark','green','nature','soft']
    },
    {
        id: 'palenight', displayName: 'Palenight', description: 'An elegant and juicy Material-like theme with vivid purple and blue hues',
        author: 'Olaolu Olawuyi', version: '2.1.0', category: 'themes', rating: 4.8, downloads: 2100000, enabled: false, type: 'marketplace',
        installType: 'themes',
        themeCSS: `:root { --bg-primary: #292d3e; --bg-secondary: #232635; --bg-tertiary: #34324a; --bg-hover: #3b3a55; --text-primary: #a6accd; --text-secondary: #676e95; --text-highlight: #ffffff; --accent-primary: #82aaff; --accent-secondary: #c792ea; --accent-hover: #6e99ed; --border-color: #3e3d58; --success: #c3e88d; --warning: #ffcb6b; --error: #ff5370; --info: #89ddff; }
.sidebar { background: var(--bg-secondary); } .titlebar { background: var(--bg-secondary); }
.project-card, .extension-card, .ext-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.project-card:hover, .ext-card:hover { border-color: var(--accent-primary); box-shadow: 0 4px 20px rgba(130,170,255,0.15); }
.btn-primary, .ext-btn-primary { background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary)); }
.stat-card { background: var(--bg-tertiary); } .modal-content { background: var(--bg-secondary); }`,
        preview: { background: '#292d3e', accent: '#82aaff', secondary: '#c792ea', palette: ['#292d3e','#82aaff','#c792ea','#c3e88d','#ffcb6b','#ff5370'] },
        tags: ['dark','material','purple','vibrant']
    },
    {
        id: 'catppuccin-mocha', displayName: 'Catppuccin Mocha', description: 'A soothing pastel theme for the high-spirited — rich chocolate backgrounds with creamy pastel accents',
        author: 'Catppuccin', version: '3.1.0', category: 'themes', rating: 4.9, downloads: 4200000, enabled: false, type: 'marketplace',
        installType: 'themes',
        themeCSS: `:root { --bg-primary: #1e1e2e; --bg-secondary: #181825; --bg-tertiary: #313244; --bg-hover: #45475a; --text-primary: #cdd6f4; --text-secondary: #a6adc8; --text-highlight: #ffffff; --accent-primary: #cba6f7; --accent-secondary: #f5c2e7; --accent-hover: #b48bdb; --border-color: #45475a; --success: #a6e3a1; --warning: #f9e2af; --error: #f38ba8; --info: #89b4fa; }
.sidebar { background: var(--bg-secondary); } .titlebar { background: var(--bg-secondary); }
.project-card, .extension-card, .ext-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.project-card:hover, .ext-card:hover { border-color: var(--accent-primary); box-shadow: 0 4px 24px rgba(203,166,247,0.18); }
.btn-primary, .ext-btn-primary { background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary)); color: #1e1e2e; }
.stat-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.modal-content { background: var(--bg-secondary); border-color: var(--border-color); }`,
        preview: { background: '#1e1e2e', accent: '#cba6f7', secondary: '#f5c2e7', palette: ['#1e1e2e','#cba6f7','#f5c2e7','#a6e3a1','#f9e2af','#f38ba8'] },
        tags: ['dark','pastel','warm','catppuccin']
    },
    {
        id: 'nord-deep', displayName: 'Nord Deep', description: 'An arctic, north-bluish color palette inspired by the beauty of the Arctic with aurora-inspired accents',
        author: 'Arctic Ice Studio', version: '1.6.0', category: 'themes', rating: 4.7, downloads: 2900000, enabled: false, type: 'marketplace',
        installType: 'themes',
        themeCSS: `:root { --bg-primary: #2e3440; --bg-secondary: #272c36; --bg-tertiary: #3b4252; --bg-hover: #434c5e; --text-primary: #d8dee9; --text-secondary: #7b88a1; --text-highlight: #eceff4; --accent-primary: #88c0d0; --accent-secondary: #81a1c1; --accent-hover: #6fb3c2; --border-color: #4c566a; --success: #a3be8c; --warning: #ebcb8b; --error: #bf616a; --info: #5e81ac; }
.sidebar { background: var(--bg-secondary); } .titlebar { background: var(--bg-secondary); }
.project-card, .extension-card, .ext-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.project-card:hover, .ext-card:hover { border-color: var(--accent-primary); box-shadow: 0 4px 20px rgba(136,192,208,0.14); }
.btn-primary, .ext-btn-primary { background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary)); color: #2e3440; }
.stat-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.modal-content { background: var(--bg-secondary); border-color: var(--border-color); }`,
        preview: { background: '#2e3440', accent: '#88c0d0', secondary: '#81a1c1', palette: ['#2e3440','#88c0d0','#81a1c1','#a3be8c','#ebcb8b','#bf616a'] },
        tags: ['dark','blue','arctic','nord']
    },
    {
        id: 'gruvbox-dark', displayName: 'Gruvbox Dark', description: 'A retro groove color scheme with warm earthy tones — amber, burnt orange, and olive on soft charcoal',
        author: 'morhetz', version: '2.3.0', category: 'themes', rating: 4.8, downloads: 3400000, enabled: false, type: 'marketplace',
        installType: 'themes',
        themeCSS: `:root { --bg-primary: #282828; --bg-secondary: #1d2021; --bg-tertiary: #3c3836; --bg-hover: #504945; --text-primary: #ebdbb2; --text-secondary: #a89984; --text-highlight: #fbf1c7; --accent-primary: #fe8019; --accent-secondary: #fabd2f; --accent-hover: #d65d0e; --border-color: #504945; --success: #b8bb26; --warning: #fabd2f; --error: #fb4934; --info: #83a598; }
.sidebar { background: var(--bg-secondary); } .titlebar { background: var(--bg-secondary); }
.project-card, .extension-card, .ext-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.project-card:hover, .ext-card:hover { border-color: var(--accent-primary); box-shadow: 0 4px 20px rgba(254,128,25,0.18); }
.btn-primary, .ext-btn-primary { background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary)); color: #282828; }
.stat-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.modal-content { background: var(--bg-secondary); border-color: var(--border-color); }`,
        preview: { background: '#282828', accent: '#fe8019', secondary: '#fabd2f', palette: ['#282828','#fe8019','#fabd2f','#b8bb26','#83a598','#fb4934'] },
        tags: ['dark','retro','warm','gruvbox']
    },
    {
        id: 'tokyo-night', displayName: 'Tokyo Night', description: 'A clean dark theme that celebrates the lights of downtown Tokyo at night — neon blues and soft purples',
        author: 'enkia', version: '1.5.0', category: 'themes', rating: 4.9, downloads: 3800000, enabled: false, type: 'marketplace',
        installType: 'themes',
        themeCSS: `:root { --bg-primary: #1a1b26; --bg-secondary: #16161e; --bg-tertiary: #24283b; --bg-hover: #292e42; --text-primary: #c0caf5; --text-secondary: #565f89; --text-highlight: #e4e8fb; --accent-primary: #7aa2f7; --accent-secondary: #bb9af7; --accent-hover: #5d8af0; --border-color: #3b4261; --success: #9ece6a; --warning: #e0af68; --error: #f7768e; --info: #2ac3de; }
.sidebar { background: var(--bg-secondary); } .titlebar { background: var(--bg-secondary); }
.project-card, .extension-card, .ext-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.project-card:hover, .ext-card:hover { border-color: var(--accent-primary); box-shadow: 0 4px 24px rgba(122,162,247,0.16); }
.btn-primary, .ext-btn-primary { background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary)); }
.stat-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.modal-content { background: var(--bg-secondary); border-color: var(--border-color); }`,
        preview: { background: '#1a1b26', accent: '#7aa2f7', secondary: '#bb9af7', palette: ['#1a1b26','#7aa2f7','#bb9af7','#9ece6a','#e0af68','#f7768e'] },
        tags: ['dark','blue','neon','tokyo']
    },
    {
        id: 'dracula-pro', displayName: 'Dracula Pro', description: 'The iconic dark theme refined to perfection — deep purple backgrounds with signature Dracula palette',
        author: 'Zeno Rocha', version: '4.0.0', category: 'themes', rating: 4.9, downloads: 5100000, enabled: false, type: 'marketplace',
        installType: 'themes',
        themeCSS: `:root { --bg-primary: #282a36; --bg-secondary: #21222c; --bg-tertiary: #343746; --bg-hover: #3e4154; --text-primary: #f8f8f2; --text-secondary: #7e81a1; --text-highlight: #ffffff; --accent-primary: #ff79c6; --accent-secondary: #bd93f9; --accent-hover: #ff5cb5; --border-color: #44475a; --success: #50fa7b; --warning: #f1fa8c; --error: #ff5555; --info: #8be9fd; }
.sidebar { background: var(--bg-secondary); } .titlebar { background: var(--bg-secondary); }
.project-card, .extension-card, .ext-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.project-card:hover, .ext-card:hover { border-color: var(--accent-primary); box-shadow: 0 4px 24px rgba(255,121,198,0.18); }
.btn-primary, .ext-btn-primary { background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary)); }
.stat-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.modal-content { background: var(--bg-secondary); border-color: var(--border-color); }`,
        preview: { background: '#282a36', accent: '#ff79c6', secondary: '#bd93f9', palette: ['#282a36','#ff79c6','#bd93f9','#50fa7b','#f1fa8c','#ff5555'] },
        tags: ['dark','purple','iconic','dracula']
    },
    {
        id: 'one-dark-pro', displayName: 'One Dark Pro', description: 'Atom\'s iconic One Dark theme — perfectly balanced dark theme with soft blue-grey tones beloved by millions',
        author: 'binaryify', version: '3.16.0', category: 'themes', rating: 4.8, downloads: 7200000, enabled: false, type: 'marketplace',
        installType: 'themes',
        themeCSS: `:root { --bg-primary: #282c34; --bg-secondary: #21252b; --bg-tertiary: #2c313a; --bg-hover: #333842; --text-primary: #abb2bf; --text-secondary: #636d83; --text-highlight: #d7dae0; --accent-primary: #61afef; --accent-secondary: #c678dd; --accent-hover: #4d9de0; --border-color: #3e4452; --success: #98c379; --warning: #e5c07b; --error: #e06c75; --info: #56b6c2; }
.sidebar { background: var(--bg-secondary); } .titlebar { background: var(--bg-secondary); }
.project-card, .extension-card, .ext-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.project-card:hover, .ext-card:hover { border-color: var(--accent-primary); box-shadow: 0 4px 20px rgba(97,175,239,0.14); }
.btn-primary, .ext-btn-primary { background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary)); }
.stat-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.modal-content { background: var(--bg-secondary); border-color: var(--border-color); }`,
        preview: { background: '#282c34', accent: '#61afef', secondary: '#c678dd', palette: ['#282c34','#61afef','#c678dd','#98c379','#e5c07b','#e06c75'] },
        tags: ['dark','atom','balanced','classic']
    },
    {
        id: 'github-dark', displayName: 'GitHub Dark', description: 'GitHub\'s official dark theme — clean, professional aesthetic developers trust daily',
        author: 'GitHub', version: '6.4.0', category: 'themes', rating: 4.7, downloads: 4800000, enabled: false, type: 'marketplace',
        installType: 'themes',
        themeCSS: `:root { --bg-primary: #0d1117; --bg-secondary: #010409; --bg-tertiary: #161b22; --bg-hover: #1c2128; --text-primary: #c9d1d9; --text-secondary: #8b949e; --text-highlight: #f0f6fc; --accent-primary: #58a6ff; --accent-secondary: #bc8cff; --accent-hover: #388bfd; --border-color: #30363d; --success: #3fb950; --warning: #d29922; --error: #f85149; --info: #58a6ff; }
.sidebar { background: var(--bg-secondary); } .titlebar { background: var(--bg-secondary); }
.project-card, .extension-card, .ext-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.project-card:hover, .ext-card:hover { border-color: var(--accent-primary); box-shadow: 0 4px 20px rgba(88,166,255,0.12); }
.btn-primary, .ext-btn-primary { background: var(--accent-primary); }
.stat-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.modal-content { background: var(--bg-secondary); border-color: var(--border-color); }`,
        preview: { background: '#0d1117', accent: '#58a6ff', secondary: '#bc8cff', palette: ['#0d1117','#58a6ff','#bc8cff','#3fb950','#d29922','#f85149'] },
        tags: ['dark','clean','professional','github']
    },
    {
        id: 'kanagawa', displayName: 'Kanagawa', description: 'Inspired by Hokusai\'s Great Wave — deep ocean blues with warm ink-brush accents from Japanese ukiyo-e art',
        author: 'rebelot', version: '2.0.0', category: 'themes', rating: 4.8, downloads: 1200000, enabled: false, type: 'marketplace',
        installType: 'themes',
        themeCSS: `:root { --bg-primary: #1f1f28; --bg-secondary: #16161d; --bg-tertiary: #2a2a37; --bg-hover: #363646; --text-primary: #dcd7ba; --text-secondary: #727169; --text-highlight: #e6e0c2; --accent-primary: #7e9cd8; --accent-secondary: #957fb8; --accent-hover: #6a8bc7; --border-color: #3a3a4a; --success: #98bb6c; --warning: #e6c384; --error: #c34043; --info: #7fb4ca; }
.sidebar { background: var(--bg-secondary); } .titlebar { background: var(--bg-secondary); }
.project-card, .extension-card, .ext-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.project-card:hover, .ext-card:hover { border-color: var(--accent-primary); box-shadow: 0 4px 20px rgba(126,156,216,0.14); }
.btn-primary, .ext-btn-primary { background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary)); }
.stat-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.modal-content { background: var(--bg-secondary); border-color: var(--border-color); }`,
        preview: { background: '#1f1f28', accent: '#7e9cd8', secondary: '#957fb8', palette: ['#1f1f28','#7e9cd8','#957fb8','#98bb6c','#e6c384','#c34043'] },
        tags: ['dark','japanese','blue','artistic']
    },
    {
        id: 'vesper', displayName: 'Vesper', description: 'Warm amber tones evoking the golden hour before twilight — ultra-dark with curated warm highlights',
        author: 'Rauno Freiberg', version: '1.1.0', category: 'themes', rating: 4.8, downloads: 890000, enabled: false, type: 'marketplace',
        installType: 'themes',
        themeCSS: `:root { --bg-primary: #101010; --bg-secondary: #0a0a0a; --bg-tertiary: #1a1a1a; --bg-hover: #232323; --text-primary: #b8b8b8; --text-secondary: #6a6a6a; --text-highlight: #e0d0c0; --accent-primary: #ffc799; --accent-secondary: #d4a37a; --accent-hover: #e8b080; --border-color: #282828; --success: #99ffe4; --warning: #ffca85; --error: #ff6f6f; --info: #82d4bb; }
.sidebar { background: var(--bg-secondary); } .titlebar { background: var(--bg-secondary); }
.project-card, .extension-card, .ext-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.project-card:hover, .ext-card:hover { border-color: var(--accent-primary); box-shadow: 0 4px 20px rgba(255,199,153,0.12); }
.btn-primary, .ext-btn-primary { background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary)); color: #101010; }
.stat-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.modal-content { background: var(--bg-secondary); border-color: var(--border-color); }`,
        preview: { background: '#101010', accent: '#ffc799', secondary: '#d4a37a', palette: ['#101010','#ffc799','#d4a37a','#99ffe4','#ffca85','#ff6f6f'] },
        tags: ['dark','warm','amber','minimal']
    },
    // ── PRODUCTIVITY EXTENSIONS (with per-extension settings) ──
    {
        id: 'gitlens', displayName: 'GitLens', description: 'Supercharge Git with blame annotations, code lens, and powerful comparison commands',
        author: 'GitKraken', version: '14.5.0', category: 'productivity', rating: 4.8, downloads: 2500000, enabled: false, type: 'marketplace',
        settings: {
            showInlineBlame: { type: 'toggle', label: 'Show inline blame annotations', default: true },
            showCodeLens: { type: 'toggle', label: 'Show CodeLens above functions', default: true },
            dateFormat: { type: 'select', label: 'Date format', options: ['relative','absolute','short'], default: 'relative' }
        }
    },
    {
        id: 'prettier', displayName: 'Prettier', description: 'Code formatter using prettier with support for many languages',
        author: 'Prettier', version: '10.4.0', category: 'formatters', rating: 4.9, downloads: 8200000, enabled: false, type: 'marketplace',
        settings: {
            formatOnSave: { type: 'toggle', label: 'Format on save', default: true },
            tabWidth: { type: 'select', label: 'Tab width', options: ['2','4','8'], default: '2' },
            useSemicolons: { type: 'toggle', label: 'Use semicolons', default: true },
            singleQuote: { type: 'toggle', label: 'Use single quotes', default: false },
            trailingComma: { type: 'select', label: 'Trailing commas', options: ['none','es5','all'], default: 'es5' }
        }
    },
    {
        id: 'eslint', displayName: 'ESLint', description: 'Integrates ESLint JavaScript into your editor for real-time linting',
        author: 'Microsoft', version: '3.0.5', category: 'linters', rating: 4.7, downloads: 12300000, enabled: false, type: 'marketplace',
        settings: {
            autoFixOnSave: { type: 'toggle', label: 'Auto-fix on save', default: false },
            showInlineErrors: { type: 'toggle', label: 'Show inline error markers', default: true },
            lintOnType: { type: 'toggle', label: 'Lint as you type', default: true }
        }
    },
    {
        id: 'live-server', displayName: 'Live Server', description: 'Launch a development local server with live reload feature for static pages',
        author: 'Ritwick Dey', version: '5.7.9', category: 'productivity', rating: 4.9, downloads: 7400000, enabled: false, type: 'marketplace',
        settings: {
            port: { type: 'select', label: 'Default port', options: ['3000','5500','8080','8000'], default: '5500' },
            autoOpen: { type: 'toggle', label: 'Auto-open browser on start', default: true },
            liveReload: { type: 'toggle', label: 'Enable live reload', default: true }
        }
    },
    {
        id: 'path-intellisense', displayName: 'Path IntelliSense', description: 'Visual Studio Code plugin that autocompletes filenames',
        author: 'Christian Kohler', version: '2.9.0', category: 'productivity', rating: 4.8, downloads: 3900000, enabled: false, type: 'marketplace',
        settings: {
            showHiddenFiles: { type: 'toggle', label: 'Show hidden files', default: false },
            autoSlash: { type: 'toggle', label: 'Auto-append slash after directory', default: true }
        }
    },
    {
        id: 'docker', displayName: 'Docker', description: 'Makes it easy to create, manage, and debug containerized applications',
        author: 'Microsoft', version: '1.28.0', category: 'productivity', rating: 4.7, downloads: 5600000, enabled: false, type: 'marketplace',
        settings: {
            showExplorer: { type: 'toggle', label: 'Show Docker Explorer in sidebar', default: true },
            pruneConfirm: { type: 'toggle', label: 'Confirm before prune', default: true }
        }
    },
    {
        id: 'thunder-client', displayName: 'Thunder Client', description: 'Lightweight REST API client with beautiful UI for testing APIs',
        author: 'Thunder Client', version: '2.15.1', category: 'productivity', rating: 4.8, downloads: 3100000, enabled: false, type: 'marketplace',
        settings: {
            saveToWorkspace: { type: 'toggle', label: 'Save requests to workspace', default: false },
            followRedirects: { type: 'toggle', label: 'Follow redirects', default: true },
            timeout: { type: 'select', label: 'Request timeout (seconds)', options: ['10','30','60','120'], default: '30' }
        }
    },
    {
        id: 'auto-rename-tag', displayName: 'Auto Rename Tag', description: 'Automatically rename paired HTML/XML tags when editing',
        author: 'Jun Han', version: '0.1.10', category: 'productivity', rating: 4.6, downloads: 6800000, enabled: false, type: 'marketplace',
        settings: {
            activateOnLanguage: { type: 'select', label: 'Active for', options: ['html','html+xml','all'], default: 'all' }
        }
    },
    {
        id: 'bracket-colorizer', displayName: 'Bracket Pair Colorizer', description: 'Color matching brackets with distinct colors for easy identification',
        author: 'CoenraadS', version: '2.0.2', category: 'productivity', rating: 4.5, downloads: 4200000, enabled: false, type: 'marketplace',
        settings: {
            showVerticalLine: { type: 'toggle', label: 'Show vertical scope line', default: true },
            highlightActive: { type: 'toggle', label: 'Highlight active bracket pair', default: true }
        }
    },
    {
        id: 'python-ext', displayName: 'Python', description: 'Rich support for Python including IntelliSense, linting, debugging, and Jupyter',
        author: 'Microsoft', version: '2024.2.1', category: 'languages', rating: 4.7, downloads: 9800000, enabled: false, type: 'marketplace',
        settings: {
            linting: { type: 'toggle', label: 'Enable linting', default: true },
            formatting: { type: 'select', label: 'Formatter', options: ['autopep8','black','yapf'], default: 'black' },
            analysisType: { type: 'select', label: 'Analysis type', options: ['off','basic','strict'], default: 'basic' }
        }
    },
    {
        id: 'rust-analyzer', displayName: 'rust-analyzer', description: 'Rust language support with smart code completion, inline errors, and more',
        author: 'rust-lang', version: '0.3.1845', category: 'languages', rating: 4.9, downloads: 2100000, enabled: false, type: 'marketplace',
        settings: {
            checkOnSave: { type: 'toggle', label: 'Run cargo check on save', default: true },
            inlayHints: { type: 'toggle', label: 'Show inlay type hints', default: true },
            cargoFeatures: { type: 'select', label: 'Cargo features', options: ['default','all','none'], default: 'default' }
        }
    },
    {
        id: 'tailwind-css', displayName: 'Tailwind CSS IntelliSense', description: 'Intelligent Tailwind CSS tooling with autocomplete, linting, and hover previews',
        author: 'Tailwind Labs', version: '0.12.1', category: 'productivity', rating: 4.9, downloads: 4500000, enabled: false, type: 'marketplace',
        settings: {
            suggestions: { type: 'toggle', label: 'Enable class suggestions', default: true },
            validate: { type: 'toggle', label: 'Validate class names', default: true },
            hoverPreview: { type: 'toggle', label: 'Show CSS on hover', default: true }
        }
    }
];

// Current extensions state
let currentExtViewMode = 'grid';
let currentExtSort = 'popular';
let currentExtFilter = 'all';
let currentExtSearch = '';
let installedExtensionsCache = [];
let extensionsCacheDirty = true;
let extensionsLoadInFlight = false;
let extensionsLoadQueued = false;
let extensionsLoadQueuedForce = false;
let extensionsLastLoadedAt = 0;
let extensionsEventBridgeInstalled = false;
