const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

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
  'get-app-version-info',
  'get-clipboard',
  'get-extension-settings',
  'get-installed-extensions',
  'get-license-status',
  'get-projects',
  'get-projects-path',
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
  'open-terminal',
  'open-user-data-folder',
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
  'app-close-requested',
  'git-history-updated',
  'git-status-changed',
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

contextBridge.exposeInMainWorld('AppBridge', {
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
  path: {
    join: (...parts) => path.join(...parts),
    basename: (targetPath) => path.basename(targetPath),
    resolve: (...parts) => path.resolve(...parts),
    isAbsolute: (targetPath) => path.isAbsolute(targetPath),
    normalize: (targetPath) => path.normalize(targetPath),
    dirname: (targetPath) => path.dirname(targetPath),
    extname: (targetPath) => path.extname(targetPath),
    sep: path.sep
  },
  fs: {
    existsSync: (targetPath) => fs.existsSync(targetPath),
    accessSync: (targetPath) => fs.accessSync(targetPath),
    readFileSync: (targetPath, encoding) => fs.readFileSync(targetPath, encoding),
    writeFileSync: (targetPath, content, encoding) => fs.writeFileSync(targetPath, content, encoding)
  },
  url: {
    pathToFileURL: (targetPath) => pathToFileURL(targetPath).toString()
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
