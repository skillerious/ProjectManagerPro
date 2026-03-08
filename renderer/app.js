(() => {
    const RUNTIME_MODULES = [
        'renderer/runtime/shared/00-environment-state-services.js',
        'renderer/runtime/shared/10-ui-shell-modal-toast.js',
        'renderer/runtime/core/00-foundation-and-startup.js',
        'renderer/runtime/core/10-shell-update-queue.js',
        'renderer/runtime/core/20-navigation-status-about.js',
        'renderer/runtime/core/30-settings-model-ui.js',
        'renderer/runtime/git/00-git-workflows.js',
        'renderer/runtime/git/10-github-upload-and-tabs.js',
        'renderer/runtime/extensions/00-extensions-catalog-and-settings.js',
        'renderer/runtime/extensions/10-command-modals-shortcuts.js',
        'renderer/runtime/projects/00-project-selection-and-favorites.js',
        'renderer/runtime/projects/10-projects-and-recent-view.js',
        'renderer/runtime/projects/20-github-auth-and-delete-dialogs.js',
        'renderer/runtime/projects/30-tips-and-scroll-effects.js'
    ];

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const existing = document.querySelector(`script[data-app-runtime-src="${src}"]`);
            if (existing) {
                if (existing.dataset.loaded === 'true') {
                    resolve(false);
                    return;
                }

                existing.addEventListener('load', () => resolve(false), { once: true });
                existing.addEventListener('error', () => reject(new Error(`Failed to load runtime module: ${src}`)), { once: true });
                return;
            }

            const script = document.createElement('script');
            script.src = src;
            script.async = false;
            script.defer = false;
            script.dataset.appRuntimeSrc = src;
            script.addEventListener('load', () => {
                script.dataset.loaded = 'true';
                resolve(true);
            }, { once: true });
            script.addEventListener('error', () => {
                reject(new Error(`Failed to load runtime module: ${src}`));
            }, { once: true });

            const host = document.head || document.documentElement;
            host.appendChild(script);
        });
    }

    async function bootstrapRuntimeModules() {
        for (const runtimeModule of RUNTIME_MODULES) {
            await loadScript(runtimeModule);
        }
    }

    if (!window.__APP_MANAGER_RUNTIME_BOOT_PROMISE) {
        window.__APP_MANAGER_RUNTIME_BOOT_PROMISE = bootstrapRuntimeModules().catch((error) => {
            console.error('Renderer runtime bootstrap failed', error);
            const toastMessage = document.getElementById('toast-message');
            if (toastMessage) {
                toastMessage.textContent = error?.message || 'Renderer runtime bootstrap failed';
            }
            return false;
        });
    }
})();
