const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readRootFile(fileName) {
  return fs.readFileSync(path.join(__dirname, '..', fileName), 'utf8');
}

function readRendererRuntimeSource() {
  const parts = [readRootFile('renderer.js')];
  const rendererDir = path.join(__dirname, '..', 'renderer');
  const modularRuntimePath = path.join(rendererDir, 'app.js');
  assert.ok(fs.existsSync(modularRuntimePath), 'Expected renderer modular runtime at renderer/app.js');
  parts.push(fs.readFileSync(modularRuntimePath, 'utf8'));

  const runtimeDir = path.join(rendererDir, 'runtime');
  assert.ok(fs.existsSync(runtimeDir), 'Expected renderer runtime modules directory at renderer/runtime');
  const runtimeFiles = [];
  const walk = (dirPath) => {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    entries.forEach((entry) => {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        return;
      }
      if (entry.isFile() && entry.name.endsWith('.js')) {
        runtimeFiles.push(fullPath);
      }
    });
  };
  walk(runtimeDir);
  runtimeFiles.sort((left, right) => left.localeCompare(right));
  assert.ok(runtimeFiles.length > 0, 'Expected at least one renderer runtime module');
  runtimeFiles.forEach((fullPath) => {
    parts.push(fs.readFileSync(fullPath, 'utf8'));
  });
  return parts.join('\n');
}

test('preload allowlist includes newly added secure IPC channels', () => {
  const preloadSource = readRootFile('preload.js');
  const requiredChannels = [
    'set-update-channel',
    'rollback-update',
    'path-exists',
    'is-git-repository',
    'import-settings-file',
    'export-settings-file',
    'git-diff-hunks',
    'git-apply-hunks',
    'git-list-conflicts',
    'git-resolve-conflict',
    'git-abort-merge',
    'git-continue-merge',
    'get-log-history',
    'clear-log-history',
    'open-log-folder',
    'report-renderer-fault',
    'app-log-entry',
    'extension-installed',
    'extension-uninstalled',
    'extension-enabled',
    'extension-disabled'
  ];

  requiredChannels.forEach((channel) => {
    assert.match(preloadSource, new RegExp(`'${channel}'`), `Missing preload channel: ${channel}`);
  });
});

test('preload bridge does not expose direct filesystem access helpers', () => {
  const preloadSource = readRootFile('preload.js');
  assert.doesNotMatch(preloadSource, /fs:\s*\{/);
  assert.doesNotMatch(preloadSource, /readFileSync/);
  assert.doesNotMatch(preloadSource, /writeFileSync/);
});

test('main process registers handlers for update channels, hunk staging, and conflict assistant', () => {
  const mainSource = readRootFile('main.js');
  const requiredHandlers = [
    "ipcMain.handle('set-update-channel'",
    "ipcMain.handle('rollback-update'",
    "ipcMain.handle('path-exists'",
    "ipcMain.handle('is-git-repository'",
    "ipcMain.handle('import-settings-file'",
    "ipcMain.handle('export-settings-file'",
    "ipcMain.handle('git-diff-hunks'",
    "ipcMain.handle('git-apply-hunks'",
    "ipcMain.handle('git-list-conflicts'",
    "ipcMain.handle('git-resolve-conflict'",
    "ipcMain.handle('git-abort-merge'",
    "ipcMain.handle('git-continue-merge'",
    "ipcMain.handle('get-log-history'",
    "ipcMain.handle('clear-log-history'",
    "ipcMain.handle('open-log-folder'",
    "ipcMain.handle('report-renderer-fault'"
  ];

  requiredHandlers.forEach((handlerSnippet) => {
    assert.match(mainSource, new RegExp(handlerSnippet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

test('project creation contract uses explicit base-path mode across renderer and main', () => {
  const rendererSource = readRendererRuntimeSource();
  const mainSource = readRootFile('main.js');

  assert.match(rendererSource, /ipcRenderer\.invoke\('create-project',[\s\S]*pathMode:\s*'base'/);
  assert.match(rendererSource, /ipcRenderer\.invoke\('create-from-template',[\s\S]*pathMode:\s*'base'/);
  assert.match(mainSource, /function resolveProjectCreationPath\([\s\S]*pathMode/);
  assert.match(mainSource, /if \(pathMode === 'base'\)/);
});
