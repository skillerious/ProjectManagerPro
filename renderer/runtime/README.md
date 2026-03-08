# Renderer Runtime Modules

This directory contains the phase-3 semantic renderer runtime modules.

## Load Order

Modules are loaded in strict order by [`renderer/app.js`](../app.js):

1. `shared/00-environment-state-services.js`
2. `shared/10-ui-shell-modal-toast.js`
3. `core/00-foundation-and-startup.js`
4. `core/10-shell-update-queue.js`
5. `core/20-navigation-status-about.js`
6. `core/30-settings-model-ui.js`
7. `git/00-git-workflows.js`
8. `git/10-github-upload-and-tabs.js`
9. `extensions/00-extensions-catalog-and-settings.js`
10. `extensions/10-command-modals-shortcuts.js`
11. `projects/00-project-selection-and-favorites.js`
12. `projects/10-projects-and-recent-view.js`
13. `projects/20-github-auth-and-delete-dialogs.js`
14. `projects/30-tips-and-scroll-effects.js`

These files intentionally share the same global script scope. Keep the load order stable unless you also validate cross-module symbol usage.

## Safety Rules

- Keep module files as classic scripts (not ESM) unless the loader is updated.
- Any new top-level initialization should be idempotent.
- Startup should continue to work when `DOMContentLoaded` has already fired.
- Run `npm run test:safety` and `npm run lint` after changes.
