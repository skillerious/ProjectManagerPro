(function (global) {
    'use strict';

    const UPDATE_SMART_DIALOG_EXIT_MS = 200;
    let updateDialogResolve = null;
    let updateDialogKeyHandler = null;
    let updateDialogMotionTimer = null;

    const UPDATE_SMART_DIALOG_MARKUP = `
<div class="update-smart-overlay" id="update-smart-overlay" aria-hidden="true">
    <div class="update-smart-shell" id="update-smart-shell" role="dialog" aria-modal="true" aria-labelledby="update-smart-title" tabindex="-1">
        <div class="update-smart-accent"></div>
        <button class="update-smart-close" id="update-smart-close" type="button" aria-label="Close update dialog">
            <i class="fas fa-times"></i>
        </button>
        <div class="update-smart-icon-wrap">
            <div class="update-smart-icon-ring"></div>
            <div class="update-smart-icon" id="update-smart-icon">
                <i class="fas fa-arrows-rotate"></i>
            </div>
        </div>
        <h3 id="update-smart-title">Checking for Updates</h3>
        <p id="update-smart-subtitle">Reviewing your configured update channel.</p>
        <p id="update-smart-detail">You can keep working while this check runs in the background.</p>

        <div class="update-smart-meta">
            <div class="update-smart-chip">
                <span class="update-smart-chip-label">Version</span>
                <span class="update-smart-chip-value" id="update-smart-version">--</span>
            </div>
            <div class="update-smart-chip">
                <span class="update-smart-chip-label">Channel</span>
                <span class="update-smart-chip-value" id="update-smart-channel">Stable</span>
            </div>
            <div class="update-smart-chip">
                <span class="update-smart-chip-label">Checked</span>
                <span class="update-smart-chip-value" id="update-smart-checked">Now</span>
            </div>
        </div>

        <div class="update-smart-progress-wrap" id="update-smart-progress-wrap" hidden>
            <div class="update-smart-progress-track">
                <div class="update-smart-progress-bar" id="update-smart-progress-bar"></div>
            </div>
            <div class="update-smart-progress-label" id="update-smart-progress-label">Preparing update...</div>
        </div>

        <div class="update-smart-notes-wrap" id="update-smart-notes-wrap" hidden>
            <p class="update-smart-notes-title">Release Highlights</p>
            <ul class="update-smart-notes" id="update-smart-notes"></ul>
        </div>

        <div class="update-smart-actions" id="update-smart-actions"></div>
    </div>
</div>`;

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
        return normalizedText.replace(/[&<>"']/g, (m) => map[m]);
    }

    function getUpdateDialogElements() {
        return {
            overlay: document.getElementById('update-smart-overlay'),
            shell: document.getElementById('update-smart-shell'),
            closeBtn: document.getElementById('update-smart-close'),
            iconEl: document.getElementById('update-smart-icon'),
            titleEl: document.getElementById('update-smart-title'),
            subtitleEl: document.getElementById('update-smart-subtitle'),
            detailEl: document.getElementById('update-smart-detail'),
            versionEl: document.getElementById('update-smart-version'),
            channelEl: document.getElementById('update-smart-channel'),
            checkedEl: document.getElementById('update-smart-checked'),
            progressWrapEl: document.getElementById('update-smart-progress-wrap'),
            progressBarEl: document.getElementById('update-smart-progress-bar'),
            progressLabelEl: document.getElementById('update-smart-progress-label'),
            notesWrapEl: document.getElementById('update-smart-notes-wrap'),
            notesEl: document.getElementById('update-smart-notes'),
            actionsEl: document.getElementById('update-smart-actions')
        };
    }

    function ensureDialogMarkup() {
        if (document.getElementById('update-smart-overlay')) {
            return;
        }

        if (!document.body) {
            throw new Error('UpdateSmartDialog requires document.body. Call it after DOMContentLoaded.');
        }

        document.body.insertAdjacentHTML('beforeend', UPDATE_SMART_DIALOG_MARKUP);
    }

    function formatUpdateChannelLabel(channel) {
        const normalized = typeof channel === 'string' ? channel.trim().toLowerCase() : '';
        if (!normalized) {
            return 'Stable';
        }

        return normalized.charAt(0).toUpperCase() + normalized.slice(1);
    }

    function formatUpdateDialogCheckedAt(value) {
        if (!value) {
            return 'Now';
        }

        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) {
            return 'Now';
        }

        return parsed.toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    function getUpdateDialogCancelValue(actions) {
        const safeActions = Array.isArray(actions) ? actions : [];
        const cancelAction = safeActions.find((action) => action && action.value === 'cancel')
            || safeActions.find((action) => action && action.variant === 'secondary')
            || safeActions[safeActions.length - 1];
        return cancelAction && cancelAction.value ? cancelAction.value : 'cancel';
    }

    function getDefaultUpdateDialogIconHtml(mode) {
        switch (mode) {
            case 'success':
                return '<i class="fas fa-circle-check"></i>';
            case 'warning':
                return '<i class="fas fa-triangle-exclamation"></i>';
            case 'danger':
                return '<i class="fas fa-circle-xmark"></i>';
            case 'progress':
                return '<i class="fas fa-cloud-arrow-down"></i>';
            default:
                return '<i class="fas fa-arrows-rotate"></i>';
        }
    }

    function normalizeUpdateDialogNotes(rawNotes) {
        if (Array.isArray(rawNotes)) {
            return rawNotes
                .map((line) => (typeof line === 'string' ? line.trim() : ''))
                .filter(Boolean)
                .slice(0, 6);
        }

        if (typeof rawNotes !== 'string') {
            return [];
        }

        return rawNotes
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => line.replace(/^[-*]\s+/, ''))
            .slice(0, 6);
    }

    function showUpdateSmartDialogFallback(options) {
        const safeOptions = options || {};
        const actions = Array.isArray(safeOptions.actions) && safeOptions.actions.length > 0
            ? safeOptions.actions
            : [{ label: 'OK', value: 'ok', variant: 'primary' }];
        const title = typeof safeOptions.title === 'string' ? safeOptions.title.trim() : '';
        const subtitle = typeof safeOptions.subtitle === 'string' ? safeOptions.subtitle.trim() : '';
        const detail = typeof safeOptions.detail === 'string' ? safeOptions.detail.trim() : '';
        const fallbackMessage = [title, subtitle, detail].filter(Boolean).join('\n\n') || 'Update action';

        if (actions.length <= 1) {
            alert(fallbackMessage);
            return Promise.resolve(actions[0].value);
        }

        const primaryAction = actions.find((action) => action.variant === 'primary') || actions[0];
        const cancelValue = getUpdateDialogCancelValue(actions);
        const cancelAction = actions.find((action) => action.value === cancelValue);
        const suffix = actions.length > 2
            ? `\n\nOK = ${primaryAction.label}\nCancel = ${cancelAction && cancelAction.label ? cancelAction.label : 'Cancel'}`
            : '';
        const accepted = confirm(`${fallbackMessage}${suffix}`);
        return Promise.resolve(accepted ? primaryAction.value : cancelValue);
    }

    function setUpdateDialogProgressState(progress, progressLabel) {
        const { progressWrapEl, progressBarEl, progressLabelEl } = getUpdateDialogElements();
        if (!progressWrapEl || !progressBarEl || !progressLabelEl) {
            return;
        }

        progressWrapEl.hidden = false;

        const hasNumericProgress = Number.isFinite(progress);
        if (!hasNumericProgress) {
            progressWrapEl.classList.add('indeterminate');
            progressBarEl.style.width = '42%';
            progressLabelEl.textContent = progressLabel || 'Processing update request...';
            return;
        }

        const clampedProgress = Math.max(0, Math.min(100, Number(progress)));
        progressWrapEl.classList.remove('indeterminate');
        progressBarEl.style.width = `${clampedProgress}%`;
        progressLabelEl.textContent = progressLabel || `Downloaded ${Math.round(clampedProgress)}%`;
    }

    function closeUpdateSmartDialog(result) {
        const finalResult = typeof result === 'string' ? result : 'cancel';
        const { overlay } = getUpdateDialogElements();
        const resolve = updateDialogResolve;
        updateDialogResolve = null;

        if (!overlay) {
            if (typeof resolve === 'function') {
                resolve(finalResult);
            }
            return;
        }

        if (updateDialogKeyHandler) {
            document.removeEventListener('keydown', updateDialogKeyHandler, true);
            updateDialogKeyHandler = null;
        }

        if (updateDialogMotionTimer) {
            clearTimeout(updateDialogMotionTimer);
            updateDialogMotionTimer = null;
        }

        overlay.onclick = null;
        overlay.classList.remove('update-smart-entering');
        overlay.classList.add('update-smart-closing');
        overlay.setAttribute('aria-hidden', 'true');

        updateDialogMotionTimer = setTimeout(() => {
            overlay.classList.remove(
                'active',
                'mode-info',
                'mode-success',
                'mode-warning',
                'mode-danger',
                'mode-progress',
                'update-smart-closing',
                'update-smart-entering'
            );
            overlay.dataset.context = '';
            overlay.dataset.mode = '';
            updateDialogMotionTimer = null;
        }, UPDATE_SMART_DIALOG_EXIT_MS);

        if (typeof resolve === 'function') {
            resolve(finalResult);
        }
    }

    function isUpdateSmartDialogActive() {
        const { overlay } = getUpdateDialogElements();
        return Boolean(overlay && overlay.classList.contains('active') && overlay.getAttribute('aria-hidden') !== 'true');
    }

    function showUpdateSmartDialog(options) {
        const safeOptions = options || {};

        ensureDialogMarkup();
        const {
            overlay,
            shell,
            closeBtn,
            iconEl,
            titleEl,
            subtitleEl,
            detailEl,
            versionEl,
            channelEl,
            checkedEl,
            progressWrapEl,
            notesWrapEl,
            notesEl,
            actionsEl
        } = getUpdateDialogElements();

        const coreElementsAvailable = overlay && shell && closeBtn && iconEl && titleEl && subtitleEl && detailEl
            && versionEl && channelEl && checkedEl && progressWrapEl && notesWrapEl && notesEl && actionsEl;
        if (!coreElementsAvailable) {
            return showUpdateSmartDialogFallback(safeOptions);
        }

        if (typeof updateDialogResolve === 'function') {
            closeUpdateSmartDialog('cancel');
        }

        const mode = ['success', 'warning', 'danger', 'progress'].includes(safeOptions.mode)
            ? safeOptions.mode
            : 'info';

        const rawActions = Array.isArray(safeOptions.actions) ? safeOptions.actions : [];
        const allowEmptyActions = safeOptions.allowEmptyActions === true;
        const actions = rawActions.length > 0
            ? rawActions
            : (allowEmptyActions ? [] : [{ label: 'Done', value: 'done', variant: 'primary', icon: 'fa-check' }]);

        const dismissible = safeOptions.dismissible !== false;
        const allowEscape = dismissible && safeOptions.allowEscape !== false;
        const dismissOnBackdrop = dismissible && safeOptions.dismissOnBackdrop === true;
        const hasProgress = Object.prototype.hasOwnProperty.call(safeOptions, 'progress');
        const notes = normalizeUpdateDialogNotes(safeOptions.notes);

        if (updateDialogMotionTimer) {
            clearTimeout(updateDialogMotionTimer);
            updateDialogMotionTimer = null;
        }

        overlay.classList.remove(
            'active',
            'mode-info',
            'mode-success',
            'mode-warning',
            'mode-danger',
            'mode-progress',
            'update-smart-entering',
            'update-smart-closing'
        );
        overlay.classList.add(`mode-${mode}`);
        overlay.dataset.context = typeof safeOptions.context === 'string' ? safeOptions.context : '';
        overlay.dataset.mode = mode;
        overlay.setAttribute('aria-hidden', 'false');

        iconEl.innerHTML = typeof safeOptions.iconHtml === 'string' && safeOptions.iconHtml.trim()
            ? safeOptions.iconHtml
            : getDefaultUpdateDialogIconHtml(mode);

        titleEl.textContent = safeOptions.title || 'App Update';
        subtitleEl.textContent = safeOptions.subtitle || '';
        detailEl.textContent = safeOptions.detail || '';
        versionEl.textContent = safeOptions.version || '--';
        channelEl.textContent = formatUpdateChannelLabel(safeOptions.channel || 'stable');
        checkedEl.textContent = formatUpdateDialogCheckedAt(safeOptions.checkedAt || new Date().toISOString());

        progressWrapEl.hidden = !hasProgress;
        progressWrapEl.classList.remove('indeterminate');
        if (hasProgress) {
            setUpdateDialogProgressState(safeOptions.progress, safeOptions.progressLabel || '');
        }

        notesWrapEl.hidden = notes.length === 0;
        notesEl.innerHTML = notes.map((line) => `<li>${escapeHtml(line)}</li>`).join('');

        actionsEl.innerHTML = '';
        actionsEl.hidden = actions.length === 0;
        actions.forEach((action) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `update-smart-btn ${action && action.variant ? action.variant : 'secondary'}`;
            button.style.setProperty('--update-smart-btn-index', String(actionsEl.children.length));

            const safeLabel = action && action.label ? String(action.label) : 'Action';
            const safeIcon = action && action.icon ? String(action.icon) : '';
            button.innerHTML = safeIcon
                ? `<i class="fas ${escapeHtml(safeIcon)}"></i> ${escapeHtml(safeLabel)}`
                : escapeHtml(safeLabel);

            button.disabled = Boolean(action && action.disabled);
            button.addEventListener('click', () => {
                const value = action && action.value ? String(action.value) : 'done';
                closeUpdateSmartDialog(value);
            });
            actionsEl.appendChild(button);
        });

        closeBtn.hidden = !dismissible;
        closeBtn.disabled = !dismissible;
        closeBtn.onclick = dismissible
            ? () => closeUpdateSmartDialog(getUpdateDialogCancelValue(actions))
            : null;

        overlay.onclick = dismissOnBackdrop
            ? (event) => {
                if (event.target === overlay) {
                    closeUpdateSmartDialog(getUpdateDialogCancelValue(actions));
                }
            }
            : null;

        void overlay.offsetWidth;
        overlay.classList.add('active');

        requestAnimationFrame(() => {
            overlay.classList.add('update-smart-entering');
            const firstAction = actionsEl.querySelector('.update-smart-btn');
            if (firstAction) {
                firstAction.focus({ preventScroll: true });
            } else if (dismissible) {
                closeBtn.focus({ preventScroll: true });
            } else {
                shell.focus({ preventScroll: true });
            }
        });

        return new Promise((resolve) => {
            updateDialogResolve = resolve;
            updateDialogKeyHandler = (event) => {
                if (event.key !== 'Escape' || !allowEscape) {
                    return;
                }
                event.preventDefault();
                event.stopPropagation();
                closeUpdateSmartDialog(getUpdateDialogCancelValue(actions));
            };
            document.addEventListener('keydown', updateDialogKeyHandler, true);
        });
    }

    global.UpdateSmartDialog = {
        mount: ensureDialogMarkup,
        show: showUpdateSmartDialog,
        close: closeUpdateSmartDialog,
        setProgress: setUpdateDialogProgressState,
        isActive: isUpdateSmartDialogActive
    };
}(window));
