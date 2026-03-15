const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_CHANNELS = new Set([
  'cancel-app-close',
  'check-vscode',
  'clone-repository',
  'close-window',
  'confirm-app-close',
  'create-from-template',
  'create-project',
  'delete-project-files',
  'disable-extension',
  'enable-extension',
  'export-project',
  'clear-log-history',
  'get-app-version-info',
  'get-clipboard',
  'get-extension-settings',
  'get-installed-extensions',
  'get-license-status',
  'get-log-history',
  'get-projects',
  'get-projects-path',
  'get-project-artwork-candidates',
  'get-recent-projects',
  'get-settings',
  'get-system-info',
  'get-theme-extensions',
  'get-user-data-path',
  'git-add-remote',
  'git-branches',
  'git-checkout',
  'git-cherry-pick',
  'git-clean',
  'git-commit',
  'git-create-branch',
  'git-delete-branch',
  'git-diff',
  'git-diff-hunks',
  'git-apply-hunks',
  'git-fetch',
  'git-log',
  'git-merge',
  'git-list-conflicts',
  'git-resolve-conflict',
  'git-abort-merge',
  'git-continue-merge',
  'git-pull',
  'git-push',
  'git-rebase',
  'git-remote-list',
  'git-remove-remote',
  'git-reset',
  'git-revert',
  'git-stash',
  'git-status',
  'git-sync',
  'git-tag-create',
  'git-tag-delete',
  'git-tag-list',
  'github-disconnect',
  'github-get-user',
  'github-list-upload-candidates',
  'github-save-token',
  'github-upload-project',
  'import-project',
  'init-git',
  'install-extension',
  'load-theme-css',
  'maximize-window',
  'minimize-window',
  'open-external',
  'open-in-explorer',
  'open-in-vscode',
  'open-log-folder',
  'open-terminal',
  'open-user-data-folder',
  'path-exists',
  'is-git-repository',
  'report-renderer-fault',
  'submit-issue-report',
  'import-settings-file',
  'export-settings-file',
  'register-product-key',
  'rename-project',
  'run-command',
  'save-dialog',
  'save-extension-settings',
  'save-recent-projects',
  'save-settings',
  'search-projects',
  'select-file',
  'select-folder',
  'start-file-watcher',
  'undo-last-operation',
  'uninstall-extension',
  'check-for-updates',
  'set-update-channel',
  'download-update',
  'download-test-update',
  'install-update',
  'rollback-update',
  'get-update-state',
  'create-workspace-snapshot',
  'get-workspace-snapshots',
  'restore-workspace-snapshot',
  'save-project-task-profile',
  'get-project-task-profiles',
  'run-project-task-profile',
  'build-search-index',
  'query-search-index',
  'enqueue-operation',
  'get-operation-queue',
  'cancel-operation',
  'retry-operation'
]);

const RECEIVE_CHANNELS = new Set([
  'app-log-entry',
  'app-close-requested',
  'extension-disabled',
  'extension-enabled',
  'extension-installed',
  'extension-uninstalled',
  'git-history-updated',
  'git-status-changed',
  'clone-repository-progress',
  'github-upload-progress',
  'show-command-palette',
  'theme-changed',
  'update-status',
  'operation-queue-updated'
]);

function assertInvokeChannel(channel) {
  if (!INVOKE_CHANNELS.has(channel)) {
    throw new Error(`Blocked IPC invoke channel: ${channel}`);
  }
}

function assertReceiveChannel(channel) {
  if (!RECEIVE_CHANNELS.has(channel)) {
    throw new Error(`Blocked IPC receive channel: ${channel}`);
  }
}

const appBridge = Object.freeze({
  ipc: {
    invoke: (channel, ...args) => {
      assertInvokeChannel(channel);
      return ipcRenderer.invoke(channel, ...args);
    },
    on: (channel, listener) => {
      assertReceiveChannel(channel);
      if (typeof listener !== 'function') {
        throw new Error('IPC listener must be a function');
      }
      const wrapped = (_event, ...args) => listener(undefined, ...args);
      ipcRenderer.on(channel, wrapped);
      return () => ipcRenderer.removeListener(channel, wrapped);
    },
    once: (channel, listener) => {
      assertReceiveChannel(channel);
      if (typeof listener !== 'function') {
        throw new Error('IPC listener must be a function');
      }
      const wrapped = (_event, ...args) => listener(undefined, ...args);
      ipcRenderer.once(channel, wrapped);
      return () => ipcRenderer.removeListener(channel, wrapped);
    },
    removeAllListeners: (channel) => {
      assertReceiveChannel(channel);
      ipcRenderer.removeAllListeners(channel);
    }
  },
  process: {
    versions: {
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome
    },
    platform: process.platform,
    arch: process.arch
  }
});

Object.freeze(appBridge.ipc);
Object.freeze(appBridge.process.versions);
Object.freeze(appBridge.process);

contextBridge.exposeInMainWorld('AppBridge', appBridge);
