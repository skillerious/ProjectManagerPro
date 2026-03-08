# High-Impact Improvement Roadmap

This roadmap turns the current priorities into executable phases with clear outcomes.

## Phase 1: Safety Baseline (Now)

- [x] Stop non-Git branch/status calls from spamming errors when selecting project cards.
- [x] Add CI workflow for safety tests and syntax validation.
- [ ] Add linting (`eslint`) and enforce in CI.
- [ ] Add renderer integration tests for key IPC flows (project select, git status, branch list).

Success criteria:
- Selecting non-Git projects produces no `git branch -a` error spam.
- Every PR runs tests automatically.

## Phase 2: Security Hardening

- [ ] Introduce a dedicated preload bridge for the main window.
- [ ] Migrate renderer from direct Electron/Node access to preload APIs.
- [ ] Flip main window to `nodeIntegration: false`, `contextIsolation: true`.
- [ ] Reduce unsafe `innerHTML` usage in high-risk surfaces first (dynamic lists and modal bodies).

Success criteria:
- Main window runs with Node disabled in renderer.
- IPC access is explicit and allowlisted.

## Phase 3: Real Update System

- [ ] Integrate `electron-updater` in the main process.
- [ ] Replace simulated update checks in renderer with real update state and progress.
- [ ] Add update channel handling (`stable`, `beta`) and rollback-safe UX.

Success criteria:
- "Check for updates" performs real provider-based checks.
- User can see/download/install update status from UI.

## Phase 4: Modularization

- [ ] Split `main.js` by domain: `ipc/git`, `ipc/projects`, `ipc/settings`, `github`, `license`, `updates`.
- [ ] Split `renderer.js` by view/feature: `settings`, `projects`, `git`, `extensions`, `github`, `ui-core`.
- [ ] Extract major CSS domains into files (`settings.css`, `projects.css`, `git.css`, `extensions.css`).

Success criteria:
- No single file carries the majority of app behavior.
- Feature changes can be made in isolated modules.

## Phase 5: Product Value Features

- [ ] Workspace snapshots/checkpoints with restore.
- [ ] Per-project task profiles (build/run/test/deploy commands).
- [ ] Indexed global search across project metadata/git state.
- [ ] Git UX upgrades: hunk staging, conflict assistant, guided merge resolution.

Success criteria:
- New workflows save meaningful time for daily project operations.

## Phase 6: UX Cleanup

- [ ] Replace placeholder support URLs with configurable app settings.
- [ ] Add first-run setup wizard (paths, git identity, editor integration).
- [ ] Add cancel/retry queue for long operations (clone/export/upload).

Success criteria:
- No placeholder links in production UI.
- New users can configure essentials in one guided flow.
