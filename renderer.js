(() => {
    const RUNTIME_SCRIPT_PATH = 'renderer/app.js';
    const RUNTIME_SCRIPT_ID = 'appmanager-renderer-runtime';

    function injectRuntimeScript() {
        return new Promise((resolve, reject) => {
            const existing = document.getElementById(RUNTIME_SCRIPT_ID);
            if (existing) {
                resolve(false);
                return;
            }

            const runtimeScript = document.createElement('script');
            runtimeScript.id = RUNTIME_SCRIPT_ID;
            runtimeScript.src = RUNTIME_SCRIPT_PATH;
            runtimeScript.async = false;
            runtimeScript.defer = false;

            runtimeScript.addEventListener('load', () => {
                resolve(true);
            });
            runtimeScript.addEventListener('error', () => {
                reject(new Error(`Failed to load renderer runtime from ${RUNTIME_SCRIPT_PATH}`));
            });

            const host = document.head || document.documentElement;
            host.appendChild(runtimeScript);
        });
    }

    function reportBootstrapFailure(error) {
        const message = error?.message || 'Renderer runtime failed to initialize';
        console.error(message, error);

        const toastMessage = document.getElementById('toast-message');
        if (toastMessage) {
            toastMessage.textContent = message;
        }
    }

    void injectRuntimeScript().catch(reportBootstrapFailure);
})();
