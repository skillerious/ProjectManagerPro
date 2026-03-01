const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readRootFile(fileName) {
  return fs.readFileSync(path.join(__dirname, '..', fileName), 'utf8');
}

test('preload allowlist includes newly added secure IPC channels', () => {
  const preloadSource = readRootFile('preload.js');
  const requiredChannels = [
    'set-update-channel',
    'rollback-update',
    'git-diff-hunks',
    'git-apply-hunks',
    'git-list-conflicts',
    'git-resolve-conflict',
    'git-abort-merge',
    'git-continue-merge'
  ];

  requiredChannels.forEach((channel) => {
    assert.match(preloadSource, new RegExp(`'${channel}'`), `Missing preload channel: ${channel}`);
  });
});

test('main process registers handlers for update channels, hunk staging, and conflict assistant', () => {
  const mainSource = readRootFile('main.js');
  const requiredHandlers = [
    "ipcMain.handle('set-update-channel'",
    "ipcMain.handle('rollback-update'",
    "ipcMain.handle('git-diff-hunks'",
    "ipcMain.handle('git-apply-hunks'",
    "ipcMain.handle('git-list-conflicts'",
    "ipcMain.handle('git-resolve-conflict'",
    "ipcMain.handle('git-abort-merge'",
    "ipcMain.handle('git-continue-merge'"
  ];

  requiredHandlers.forEach((handlerSnippet) => {
    assert.match(mainSource, new RegExp(handlerSnippet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});
