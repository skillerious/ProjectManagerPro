(() => {
    const WINDOWS_PATH_SEPARATOR = '\\';

    function normalizePathInput(targetPath) {
        if (typeof targetPath !== 'string') {
            return '';
        }

        const trimmed = targetPath.trim();
        if (!trimmed) {
            return '';
        }

        const startsWithUnc = /^\\\\/.test(trimmed) || /^\/\//.test(trimmed);
        let normalized = trimmed.replace(/\\/g, '/');

        if (startsWithUnc) {
            normalized = `//${normalized.replace(/^\/+/, '').replace(/\/{2,}/g, '/')}`;
        } else {
            normalized = normalized.replace(/\/{2,}/g, '/');
        }

        return normalized;
    }

    function pathIsAbsolute(targetPath) {
        const normalized = normalizePathInput(targetPath);
        if (!normalized) {
            return false;
        }

        return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//') || normalized.startsWith('/');
    }

    function joinPath(...parts) {
        const segments = parts
            .filter((part) => typeof part === 'string' && part.trim())
            .map((part) => normalizePathInput(part));

        if (segments.length === 0) {
            return '';
        }

        let combined = segments[0].replace(/\/+$/, '');
        for (let i = 1; i < segments.length; i += 1) {
            const next = segments[i].replace(/^\/+/, '').replace(/\/+$/, '');
            if (!next) {
                continue;
            }
            combined = combined ? `${combined}/${next}` : next;
        }

        return combined.replace(/\//g, WINDOWS_PATH_SEPARATOR);
    }

    function basenamePath(targetPath) {
        const normalized = normalizePathInput(targetPath).replace(/\/+$/, '');
        if (!normalized) {
            return '';
        }

        const parts = normalized.split('/');
        return parts[parts.length - 1] || '';
    }

    function dirnamePath(targetPath) {
        const normalized = normalizePathInput(targetPath).replace(/\/+$/, '');
        if (!normalized) {
            return '';
        }

        if (/^[A-Za-z]:$/.test(normalized)) {
            return `${normalized}${WINDOWS_PATH_SEPARATOR}`;
        }

        const lastSlash = normalized.lastIndexOf('/');
        if (lastSlash <= 0) {
            return normalized.startsWith('//') ? '//' : '';
        }

        return normalized.slice(0, lastSlash).replace(/\//g, WINDOWS_PATH_SEPARATOR);
    }

    function resolvePath(targetPath) {
        return normalizePathInput(targetPath).replace(/\//g, WINDOWS_PATH_SEPARATOR);
    }

    function buildFileUrl(targetPath) {
        const normalized = normalizePathInput(targetPath);
        if (!normalized) {
            return '';
        }

        if (/^[A-Za-z]:\//.test(normalized)) {
            return encodeURI(`file:///${normalized}`);
        }

        if (normalized.startsWith('//')) {
            return encodeURI(`file:${normalized}`);
        }

        if (normalized.startsWith('/')) {
            return encodeURI(`file://${normalized}`);
        }

        return encodeURI(`file:///${normalized}`);
    }

    function getCachedBooleanValue(cache, cacheKey, ttlMs) {
        const existing = cache.get(cacheKey);
        if (!existing) {
            return { hit: false, value: false };
        }

        if (Date.now() - existing.ts > ttlMs) {
            cache.delete(cacheKey);
            return { hit: false, value: false };
        }

        return { hit: true, value: existing.value === true };
    }

    function setCachedBooleanValue(cache, cacheKey, value) {
        cache.set(cacheKey, { value: Boolean(value), ts: Date.now() });
        if (cache.size > 3000) {
            const oldestKey = cache.keys().next().value;
            if (oldestKey) {
                cache.delete(oldestKey);
            }
        }
    }

    function parseVersionParts(versionValue) {
        const version = typeof versionValue === 'string' ? versionValue : String(versionValue || '');
        const parts = version.replace(/^v/i, '').match(/\d+/g);
        if (!parts) {
            return [0];
        }
        return parts.map((part) => Number(part) || 0);
    }

    function compareVersionDescending(leftVersion, rightVersion) {
        const leftParts = parseVersionParts(leftVersion);
        const rightParts = parseVersionParts(rightVersion);
        const maxLength = Math.max(leftParts.length, rightParts.length);
        for (let i = 0; i < maxLength; i += 1) {
            const left = leftParts[i] || 0;
            const right = rightParts[i] || 0;
            if (left !== right) {
                return right - left;
            }
        }
        return 0;
    }

    function createExpiringAsyncCache(options = {}) {
        const ttlMs = Math.max(0, Number(options.ttlMs) || 0);
        const maxEntries = Math.max(1, Number(options.maxEntries) || 100);
        const cache = new Map();
        const inFlight = new Map();

        function trim() {
            while (cache.size > maxEntries) {
                const oldestKey = cache.keys().next().value;
                if (!oldestKey) {
                    break;
                }
                cache.delete(oldestKey);
            }
        }

        function clear() {
            cache.clear();
            inFlight.clear();
        }

        async function get(key, loader) {
            if (typeof loader !== 'function') {
                throw new Error('createExpiringAsyncCache.get requires a loader function');
            }

            const now = Date.now();
            const cachedEntry = cache.get(key);
            if (cachedEntry && (ttlMs <= 0 || (now - cachedEntry.ts) < ttlMs)) {
                return cachedEntry.value;
            }

            const existingInFlight = inFlight.get(key);
            if (existingInFlight) {
                return existingInFlight;
            }

            const request = Promise.resolve()
                .then(() => loader())
                .then((value) => {
                    cache.set(key, { ts: Date.now(), value });
                    trim();
                    return value;
                })
                .finally(() => {
                    inFlight.delete(key);
                });

            inFlight.set(key, request);
            return request;
        }

        return {
            get,
            clear
        };
    }

    window.AppRendererModules = Object.assign({}, window.AppRendererModules, {
        pathUtils: {
            WINDOWS_PATH_SEPARATOR,
            normalizePathInput,
            pathIsAbsolute,
            joinPath,
            basenamePath,
            dirnamePath,
            resolvePath,
            buildFileUrl
        },
        cacheUtils: {
            getCachedBooleanValue,
            setCachedBooleanValue
        },
        versionUtils: {
            parseVersionParts,
            compareVersionDescending
        },
        asyncUtils: {
            createExpiringAsyncCache
        }
    });
})();
