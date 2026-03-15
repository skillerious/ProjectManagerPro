# Changelog

> Daily release notes for AppManager.  
> If multiple updates happen on the same date, they are grouped under one release entry.

## Release Index

| Date | Version | Focus |
| --- | --- | --- |
| [2026-03-14](#2026-03-14---v280) | `v2.8.0` | Major update: security, performance, bug fixes, and email issue reporting |
| [2026-03-14](#2026-03-14---v273) | `v2.7.3` | Status bar progress fix and project card visual refresh |
| [2026-03-14](#2026-03-14---v272) | `v2.7.2` | Security hardening, memory leak fixes, and test coverage expansion |
| [2026-03-13](#2026-03-13---v271) | `v2.7.1` | Update download UX polish and background progress visibility |
| [2026-03-12](#2026-03-12---v270) | `v2.7.0` | Reliability and security hardening, architecture decomposition |
| [2026-03-11](#2026-03-11---v262) | `v2.6.2` | UX and stability improvements, settings and Git reliability |
| [2026-03-10](#2026-03-10) | - | Diagnostics Log Viewer visual and UX improvements |

---

## 2026-03-14 - v2.8.0

> **Release focus:** Major update addressing critical security vulnerabilities, performance bottlenecks, bug fixes, and new features including direct email issue reporting via SMTP.

### Bug Fixes

- **Close-to-tray not working after settings change:** When a user toggled "Close to Tray" ON in settings and clicked the window close button without saving first, the app would close completely instead of minimizing to the system tray. The `close-window` IPC handler now accepts a `closeToTray` hint from the renderer so the main process respects the unsaved UI state. Both the IPC handler and the renderer's `attemptAppClose()` now cooperate correctly regardless of whether the setting has been persisted yet.
- **System tray icon too small:** The tray icon was being resized to 16×16 pixels, appearing blurry and tiny on modern displays. Changed to 32×32 with `quality: 'best'`, and the app now prefers the multi-resolution `.ico` file on Windows for crisp rendering at any DPI.

### Security

- **Command injection in project export:** `performExportProject()` used `exec()` with string interpolation to run a PowerShell `Compress-Archive` command, allowing path-based injection. Replaced with `execFile('powershell', [...])` using `$args[]` parameter passing — no shell interpolation, no injection vector. Added `--NoProfile`, `--NonInteractive` flags and a 120-second timeout.
- **SMTP credentials excluded from renderer:** The new `smtpPass` setting is stripped from `getRendererSafeSettings()` so it never leaves the main process, matching the existing pattern for GitHub tokens.

### Performance

- **Debounced GitHub upload file search:** The file tree search input in the GitHub upload panel now debounces at 180ms instead of firing on every keystroke, preventing redundant tree re-renders during fast typing.
- **Event listener leak in custom dropdowns:** `initializeCustomDropdowns()` registered a new global `document.addEventListener('click', ...)` on every call without removing previous listeners. Now tracks and deduplicates the handler across re-initializations.
- **Status bar timer cleanup on unload:** The `statusBarRefreshTimer` (debounced refresh) is now cleared alongside the clock interval timer during `beforeunload`, preventing orphaned timeouts.

### Error Handling

- **Silent window control catches now log warnings:** `minimize-window` and `maximize-window` IPC calls previously swallowed errors with `.catch(() => {})`. They now log the failure reason via `console.warn` for debuggability.
- **Unhandled promise rejections logged to console:** The renderer's `unhandledrejection` handler now writes to `console.error` in addition to reporting faults to the main process, making rejections visible in DevTools.
- **Extension handler error context:** Extension install/uninstall error logs now include `extensionId`, `extensionName`, and `stack` trace for faster diagnosis.
- **Workspace project limit warning:** When a workspace exceeds `MAX_DISCOVERED_PROJECTS` (400), a warning is now logged with the actual count and root path, making it clear when the cap is hit.

### Accessibility

- **Project list loading state:** The projects list container now sets `aria-busy="true"` during loading and removes it when complete, allowing screen readers to announce the loading state.

### New Features

- **Direct SMTP email for issue reports:** Added `nodemailer` dependency and SMTP transport for the Report Issue dialog. Reports are sent directly from the main process without opening the user's email client. SMTP settings (`smtpHost`, `smtpPort`, `smtpUser`, `smtpPass`, `reportRecipient`) are configurable in app settings with Gmail defaults. Error messages distinguish authentication failures from connection issues.

### Code Change Overview

| File | Summary |
| --- | --- |
| `main.js` | Tray icon uses `.ico` on Windows at 32×32; `close-window` IPC respects `closeToTray` hint; `performExportProject` uses `execFile` instead of `exec`. |
| `main/settings/app-settings.js` | Added SMTP settings (`smtpHost`, `smtpPort`, `smtpUser`, `smtpPass`, `reportRecipient`) with sanitization; `smtpPass` excluded from renderer-safe settings. |
| `main/ipc/update-workspace-system-handlers.js` | `submit-issue-report` handler uses `nodemailer` SMTP transport with HTML email body and structured error handling. |
| `main/ipc/extension-handlers.js` | Install/uninstall error logs include extension ID, name, and stack trace. |
| `main/workspace-services.js` | Logs warning when discovered projects exceed `MAX_DISCOVERED_PROJECTS`. |
| `renderer/runtime/core/10-shell-update-queue.js` | Window control catches log warnings; `unhandledrejection` handler logs to `console.error`. |
| `renderer/runtime/core/20-navigation-status-about.js` | `statusBarRefreshTimer` cleaned up on `beforeunload`. |
| `renderer/runtime/core/30-settings-model-ui.js` | `attemptAppClose` passes `closeToTray` hint; dropdown click handler deduplicated. |
| `renderer/runtime/git/10-github-upload-and-tabs.js` | File search input debounced at 180ms. |
| `renderer/runtime/projects/00-project-selection-and-favorites.js` | Project list sets `aria-busy` during loading. |
| `package.json` | Added `nodemailer` dependency. |

### Validation

- All 63 existing tests pass with zero failures.

---

## 2026-03-14 - v2.7.3

> **Release focus:** Status bar download progress indicator fix and project card visual refresh aligned with smart dialog design language.

### Status Bar Progress Fix

- **Progress indicator visibility:** Changed `renderStatusUpdateProgressIndicator()` to require `downloadProgress > 0` (not `>= 0`) so the status bar progress chip is never visible when no download has started reporting progress.
- **Background download status message:** Fixed the status message builder to also require `downloadProgress > 0` for the "Downloading in background" busy state.
- **Progress state cleanup:** Download completion and error paths now explicitly reset `downloadProgress` to `0` alongside `backgroundDownloadActive: false`, preventing stale progress values from leaking into future status bar renders.
- **Main process error handler:** `autoUpdater` error handler now resets `downloadProgress` to `0`, preventing stale values after download failures.

### Project Card Visual Refresh

- **Flattened card surface:** Replaced heavy radial+linear gradient backgrounds with the smart dialog's subtle `linear-gradient(165deg, ...)` treatment.
- **Reduced elevation:** Replaced deep `box-shadow: 0 16px 30px` with subtle `0 2px 8px` shadows matching VS Code panel depth.
- **Removed hover lift:** Replaced `translateY(-2px)` hover transform with subtle border brightening — no more floating card effect.
- **Removed glow overlay:** Removed the `::before` pseudo-element radial gradient glow that appeared on hover/focus/selection.
- **Muted accent bar:** Reduced accent bar opacity from `0.94` to `0.5` for a subtler top edge.
- **Smaller icons:** Reduced project icon from 52×52px to 44×44px with softer shadows and borders.
- **Tighter typography:** Reduced project name from 22px/33px to 15px/18px, muted color from `#f3f7ff` to `#e8edf6`.
- **Chip-style elements:** Updated type badges, inline pills, path bar, and action buttons to use the smart dialog chip palette (`rgba(26, 34, 48, 0.82)` backgrounds, `rgba(120, 160, 206, ...)` borders).
- **Flatter action buttons:** Replaced gradient primary button with translucent accent fill; removed hover lift transforms from all buttons.
- **Muted favorites:** Softened favorite pill and button active state colors/opacity.

### Code Change Overview

| File | Summary |
| --- | --- |
| `renderer/runtime/core/20-navigation-status-about.js` | Progress indicator requires `downloadProgress > 0`; background status message uses same guard. |
| `renderer/runtime/core/10-shell-update-queue.js` | Download completion and error paths reset `downloadProgress` to `0`. |
| `main/update-manager.js` | `autoUpdater` error handler resets `downloadProgress` to `0`. |
| `styles.css` | Full project card restyle: flattened surfaces, reduced shadows, removed glow, smaller icons, tighter typography, chip-style controls. |
| `package.json` | Version bump to `2.7.3`. |

### Validation

```sh
npm run test:safety
```

[Back to Release Index](#release-index)

---

## 2026-03-14 - v2.7.2

> **Release focus:** Comprehensive security hardening, memory leak elimination, race condition fixes, and test coverage expansion.

### Security Hardening

- **Removed dead `executeGitCommand`:** Removed the legacy `exec()`-based Git command wrapper (shell injection risk). All Git operations now use `executeGitArgs` via `execFile()` (no shell).
- **CSP tightened:** Removed `'unsafe-inline'` from `style-src`, added `base-uri 'self'` and `frame-ancestors 'none'` to Content Security Policy.
- **Theme download URL whitelist:** `downloadThemeFromURL` now only accepts downloads from trusted hosts (`raw.githubusercontent.com`, `gist.githubusercontent.com`, `github.com`) with a 512 KB size limit.
- **Theme CSS path traversal prevention:** `getThemeCSS` now validates that `manifest.main` resolves within the theme directory, preventing path traversal attacks.
- **Restricted environment variables in git patch:** `applyGitPatchToIndex` now passes only essential env vars (`PATH`, `SYSTEMROOT`, `HOME`, `USERPROFILE`, `LANG`) instead of the full `process.env`.
- **Extension manifest validation:** Strengthened extension `manifest.main` path checks with `path.resolve()` and containment validation.
- **Legacy GitHub token deprecation:** Legacy unencrypted `githubToken` now emits a `_legacyTokenWarning` guiding users to re-authenticate for encrypted storage.
- **innerHTML replaced with DOM methods:** Replaced `innerHTML` assignments in settings error messages, settings breadcrumbs, and git confirm buttons with `createElement`/`textContent` to eliminate XSS surface area.
- **`fileURLToPath` result validation:** `isTrustedLocalAppUrl` now explicitly validates the `fileURLToPath` return value before proceeding.

### Memory Leak Fixes

- **MutationObserver cleanup:** The legacy inline action bridge observer is now stored and disconnected on `beforeunload`.
- **File watcher listener cleanup:** `stopFileWatcher` now calls `removeAllListeners()` on chokidar watchers before closing.
- **App initialization retry prevention:** `initializeAppIfNeeded` no longer resets its promise on error, preventing duplicate event listeners and IPC handlers on re-initialization.

### Race Condition & Logic Fixes

- **OperationQueue cancellation race:** `processNext` now checks the `cancelled` flag after finding a queued job but before transitioning to `running`.
- **UUID-based temp files:** Queue persistence now uses `crypto.randomUUID()` for temp file names instead of `pid.timestamp` to prevent collisions.
- **OperationQueue `destroy()` method:** Added explicit cleanup method that removes all listeners and clears runners.
- **Artwork lookup timeout:** `fetchProjectArtworkScan` now wraps IPC calls with a 30-second `Promise.race` timeout to prevent indefinite in-flight cache entries.
- **Symlink detection improvement:** Project discovery now uses `entry.isSymbolicLink?.() === true` for more robust symlink detection.

### Error Handling Improvements

- **IPC error handling for window controls:** `minimize-window` and `maximize-window` IPC calls now have `.catch()` handlers.
- **IPC error handling for file open actions:** `open-in-vscode` and `open-in-explorer` now show error notifications on failure.
- **`run-command` handler wrapped in try-catch:** Catches unexpected errors and returns structured error responses.
- **File watcher cleanup:** Watchers now have `removeAllListeners()` called before `close()`.

### Accessibility

- **ARIA label refresh on view switch:** Sidebar accessibility labels are now refreshed via `refreshSidebarAccessibilityLabels()` whenever the active view changes.

### Test Coverage Expansion (55 → 63 tests)

- **Operation queue cancellation:** Added test for cancelling a queued job before it runs.
- **Operation queue runner exception:** Added test verifying that runner exceptions result in `failed` status.
- **Operation queue destroy:** Added test for `destroy()` cleanup behavior.
- **Project discovery symlink exclusion:** Added test verifying symlinked directories are skipped during scan.
- **Security: null bytes and CRLF injection:** Added tests for `validateGitRefName` and `validateGitFilePathInput` with null bytes, CRLF, and boundary lengths.
- **Security: command injection variants:** Added tests for nested quote injection, pipe attacks, and backtick injection.
- **Security: `fileURLToPath` edge case:** Added test for `isTrustedLocalAppUrl` with empty `fileURLToPath` results.
- **Discovery assertion accuracy:** Changed fragile `>= 3` assertion to exact `=== 3` equality.

### Code Change Overview

| File | Summary |
| --- | --- |
| `main.js` | Removed dead `executeGitCommand`, added theme URL whitelist + size limit, theme CSS path traversal guard, restricted git patch env vars, watcher listener cleanup. |
| `index.html` | Tightened CSP: removed `'unsafe-inline'`, added `base-uri` and `frame-ancestors`. |
| `main/operation-queue.js` | UUID temp files, cancellation race fix, added `destroy()` method. |
| `main/settings/app-settings.js` | Legacy token deprecation warning. |
| `main/project-discovery-service.js` | Improved symlink detection. |
| `main/window-security-manager.js` | `fileURLToPath` result validation. |
| `main/ipc/update-workspace-system-handlers.js` | `run-command` handler try-catch. |
| `renderer/runtime/core/00-foundation-and-startup.js` | MutationObserver cleanup, init retry prevention. |
| `renderer/runtime/core/10-shell-update-queue.js` | IPC error handling for window controls and file open actions. |
| `renderer/runtime/core/20-navigation-status-about.js` | ARIA label refresh on view switch. |
| `renderer/runtime/core/30-settings-model-ui.js` | innerHTML → DOM methods for error messages and breadcrumbs. |
| `renderer/runtime/git/00-git-workflows.js` | innerHTML → DOM methods for confirm button. |
| `renderer/runtime/projects/00-project-selection-and-favorites.js` | Artwork lookup timeout. |
| `tests/security-utils.test.js` | 4 new security edge case tests. |
| `tests/operation-queue.test.js` | 3 new tests (cancel, exception, destroy). |
| `tests/project-discovery-service.test.js` | 1 new symlink exclusion test, fixed fragile assertion. |

### Validation

```sh
npm run test:safety   # 63 tests, 63 pass, 0 fail
```

[Back to Release Index](#release-index)

---

## 2026-03-13 - v2.7.1

> **Release focus:** Update download flow clarity, background progress visibility, and completion handoff UX.

### Update Download UX Improvements

- **Background progress in status bar:** Added a dedicated live progress chip to the status bar when update downloads are moved to background mode.
- **Automatic completion handoff:** Background downloads now clear the status-bar progress indicator when complete and reopen the completion dialog.
- **Download completion action:** Added **Open Download Folder** button to the test download completion dialog.
- **Progress animation polish:** Replaced harsh progress highlight behavior with a smoother, lower-flash animated treatment.

### Version

- Bumped application version from `2.7.0` to `2.7.1`.

### Validation

```sh
npm run lint
node --test tests/update-manager.test.js tests/ipc-contract.test.js
```

[Back to Release Index](#release-index)

---

## 2026-03-12 - v2.7.0

> **Release focus:** Main application reliability, security hardening, and main-process decomposition.

### Reliability and Security Hardening

- **Operation queue hydration:** Sanitized invalid job IDs, prevented duplicate IDs, and normalized resumed `running` jobs back to `queued`.
- **Queue snapshot persistence:** Added fallback write behavior when atomic rename fails under restrictive Windows file-lock conditions (`EEXIST`/`EPERM`/`EXDEV`).
- **Workspace search pagination:** Fixed indexed search correctness so `hasMore` is only `true` when additional matching rows exist beyond the requested limit.
- **Project discovery hygiene:** Rejected malformed workspace roots (control characters and oversized paths) before scanning.
- **Symlink traversal safety:** Added skip guards for symlink directories during project discovery traversal.
- **External URL safety:** Restricted renderer-driven external opens to web protocols only (`http`/`https`).
- **Settings sanitization:** Hardened with:
  - **Case-insensitive normalization** for enum-like values (`terminalApp`, `updateChannel`, editor/display/update interval modes).
  - **Credential-bearing URL rejection** for URL settings.
  - **Stricter branch validation** for `defaultBranch` using Git-safe naming rules.

### Architecture Refactor: Main Process Decomposition

- **IPC extraction (settings/file dialogs):** Moved handlers from `main.js` to `main/ipc/settings-file-dialog-handlers.js`.
- **IPC extraction (update/workspace/system):** Moved handlers from `main.js` to `main/ipc/update-workspace-system-handlers.js`.
- **IPC extraction (extensions):** Moved handlers from `main.js` to `main/ipc/extension-handlers.js`.
- **Template builder extraction:** Moved project scaffolding builders (Electron/Python/Web/Node/React/Vue/C++/Java/Empty) to `main/project-template-builders.js`.
- **Contract coverage:** Updated `tests/ipc-contract.test.js` to validate handler registration across `main.js` and `main/ipc/*`.
- **Main process footprint:** Reduced `main.js` from 6528 lines to 5305 lines via dependency-injected registrar modules.
- **Post-refactor verification:** Re-ran `npm run lint` and `npm run test:safety`.

### Test Coverage Expansion

- **Operation queue regressions:** Added persisted-ID sanitization and uniqueness coverage.
- **Workspace pagination regressions:** Added exact-limit behavior coverage (`hasMore === false` when no extra matches exist).
- **Project discovery robustness:** Added malformed-root-path coverage.
- **Security/settings assertions:** Expanded tests for blocked `file:` external URLs and stricter settings sanitization.

### Version

- Bumped application version from `2.6.2` to `2.7.0`.

### Validation

```sh
npm run lint
npm run test:safety
```

[Back to Release Index](#release-index)

---

## 2026-03-11 - v2.6.2

> **Release focus:** UX consistency, runtime safety guards, and settings/update reliability.

### UX and Stability Updates

- **About dialog motion parity:** Migrated About dialog to the smart-overlay state model used by Update (`active`, entering, closing).
- **Presentation consistency:** Aligned About dialog shell transitions and staged reveal timing with update-style behavior.
- **Race-condition handling:** Fixed About close/open timing races by resolving pending close timers before reopen.
- **DOM safety:** Added element-existence guards for About runtime population to avoid null-reference crashes in partial state transitions.
- **Shared UI hardening:** Added missing null guards in sidebar and status-bar helpers.
- **Project settings guardrails:** Prevented `currentProject` null-reference errors and surfaced a safe informational message when no project is selected.
- **Settings rollback safety:** Added save-failure rollback so in-memory settings stay aligned with disk on `save-settings` failures.
- **Update channel rollback safety:** Hardened channel persistence and rollback persistence with explicit failure handling and restoration.
- **Updater re-entrancy controls:** Added in-flight guards for update checks and downloads.
- **Git behavior parity with settings:** Updated handlers to honor `gitSignCommits`, `gitUsePullRebase`, `gitAutoStash`, and `gitPruneOnFetch`.
- **Upstream detection robustness:** Improved push/sync behavior for additional upstream-missing error variants.
- **Terminal launch resilience:** Hardened launch path resolution with fallback directories and support for configured extra terminal args.

### Settings and Theming Enhancements

- **Themed URL inputs:** Fixed settings URL fields so they no longer render as default white controls in dark theme.
- **Expanded settings surface:** Extended Terminal, Git, Extensions, and Advanced settings with workflow, safety, diagnostics, and trust controls.

### Code Change Overview

| File | Summary |
| --- | --- |
| `main.js` | Settings rollback safety, update channel safeguards, rollback persistence safeguards, Git flow updates (pull/fetch/push/sync/commit), and terminal launch hardening. |
| `main/update-manager.js` | Re-entrancy guards for `checkForUpdates()` and `downloadUpdate()`. |
| `renderer/runtime/core/20-navigation-status-about.js` | About smart-dialog lifecycle improvements, close/open stability, and DOM safety guards. |
| `renderer/runtime/shared/10-ui-shell-modal-toast.js` | Null-safe UI helper behavior and safer project-settings notification handling. |
| `index.html` | About dialog smart-overlay markup alignment. |
| `styles.css` | About dialog motion/styling alignment with the update dialog and staged animation behavior. |
| `package.json`, `package-lock.json` | Version bump to `2.6.2`. |
| `CHANGELOG.md` | Release notes and tracked file summary update. |

### Version

- Bumped application version from `2.6.1` to `2.6.2`.

### Validation

```sh
npm run lint
npm run test:safety
```

[Back to Release Index](#release-index)

---

## 2026-03-10

> **Release focus:** Diagnostics Log Viewer visual refresh, UX polish, and accessibility improvements.

### Visual Upgrade

- **Filter controls:** Restyled with stronger card treatment, clearer labels, improved contrast, and clearer focus states.
- **Checkbox toggles:** Rebuilt `Faults only`, `Live stream`, and `Auto scroll` with custom indicators and refined checked/hover/focus states.
- **Select styling:** Upgraded Level/Source dropdowns with custom arrow treatment, hover/focus feedback, and consistent dark panel theming.
- **Footer action hierarchy:** Overhauled `Open Log Folder`, `Refresh`, `Copy Selected`, `Export Visible`, and `Clear Session Logs` with improved hierarchy, icon badges, accent/danger variants, disabled states, and mobile responsiveness.
- **Keyboard focus treatment:** Added clearer focus styling for log rows.

### UX and Code Improvements

- **Search performance:** Added debounced search filtering to reduce unnecessary re-filtering while typing.
- **Refresh safety:** Added in-flight refresh handling to prevent overlapping refresh calls and disable actions while loading.
- **Async action resilience:** Added safer async error handling for copy/export/open-folder/clear actions with user-visible failure notifications.
- **Dropdown stability:** Added source-filter option signature caching to avoid unnecessary DOM rebuilds during high-frequency live updates.
- **Selection continuity:** Added resilient synthetic ID progression for live log rows to keep selection stable.
- **Accessibility semantics:** Added listbox accessibility attributes for rows (`role="option"`, `aria-selected`, `aria-label`, `aria-activedescendant`).
- **Keyboard shortcut:** `Ctrl/Cmd + F` now focuses Diagnostics search.
- **Keyboard shortcut:** `Enter` in search triggers immediate filtering.
- **Keyboard shortcut:** `Escape` in search clears current query.
- **Screen reader updates:** Added `role="status"` and `aria-live` to the smart summary region.

### Markup Cleanup

- **Button intent safety:** Added explicit `type="button"` to Diagnostics action buttons to prevent accidental form submits.
- **Structural semantics:** Added wrappers for control fields/selects to support clearer styling and structure.
- **Toolbar semantics:** Added toolbar semantics to the footer action group.

### Validation

```sh
npm run lint
npm run test:safety
npx eslint renderer-log-viewer.js
```

[Back to Release Index](#release-index)
