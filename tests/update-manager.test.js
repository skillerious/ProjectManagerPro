const test = require('node:test');
const assert = require('node:assert/strict');
const { UpdateManager } = require('../main/update-manager');

function createManager() {
  return new UpdateManager({
    logger: {
      info() {},
      warn() {},
      error() {}
    },
    app: {
      getVersion() {
        return '2.6.1';
      },
      isPackaged: true
    },
    BrowserWindow: {
      getAllWindows() {
        return [];
      }
    }
  });
}

test('normalizeVersionString supports Vx_x_x tag format', () => {
  const manager = createManager();
  assert.equal(manager.normalizeVersionString('V2_6_4'), '2.6.4');
  assert.equal(manager.normalizeVersionString('v2_7_0-beta_1'), '2.7.0-beta.1');
});

test('isVersionGreater compares underscore tags against dotted current versions', () => {
  const manager = createManager();
  assert.equal(manager.isVersionGreater('V2_6_4', '2.6.1'), true);
  assert.equal(manager.isVersionGreater('V2_6_1', '2.6.1'), false);
});

test('checkForUpdates falls back to manual-only update when GitHub tag is newer than auto-updater result', async () => {
  const manager = createManager();
  manager.autoUpdater = {
    async checkForUpdates() {}
  };
  manager.state.supported = true;
  manager.state.currentVersion = '2.6.1';

  manager.runManualReleaseCheck = async () => ({
    success: true,
    state: {
      available: true,
      latestVersion: 'V2_6_4',
      releaseDate: '2026-03-03T00:00:00.000Z',
      releaseNotes: '- Feature improvements',
      lastCheckedAt: '2026-03-03T00:00:00.000Z',
      releasePageUrl: 'https://github.com/skillerious/ProjectManagerPro/releases/tag/V2_6_4'
    }
  });

  const result = await manager.checkForUpdates();

  assert.equal(result.success, true);
  assert.equal(result.manualOnly, true);
  assert.equal(result.state.available, true);
  assert.equal(result.state.latestVersion, 'V2_6_4');
  assert.equal(result.state.supported, false);
});

test('normalizeReleaseNotes trims and limits long release notes', () => {
  const manager = createManager();
  const longNotes = 'x'.repeat(20000);
  const normalized = manager.normalizeReleaseNotes(longNotes);

  assert.equal(normalized.length, 12000);
  assert.equal(normalized.startsWith('x'), true);
});
