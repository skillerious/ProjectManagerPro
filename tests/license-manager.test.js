const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs').promises;
const crypto = require('node:crypto');

const { createLicenseManager } = require('../main/license/license-manager');
const { generateProductKey } = require('../license-utils');

function createAppStub(userDataPath) {
  return {
    getName() {
      return 'Project Manager Pro Test';
    },
    getPath(name) {
      if (name === 'userData') {
        return userDataPath;
      }
      throw new Error(`Unsupported app path request: ${name}`);
    }
  };
}

function createManager(userDataPath) {
  return createLicenseManager({
    app: createAppStub(userDataPath),
    fsPromises: fs,
    cryptoModule: crypto,
    osModule: os,
    safeStorageRef: {
      isEncryptionAvailable() {
        return false;
      }
    },
    processRef: process,
    consoleRef: {
      log() {},
      warn() {},
      error() {}
    }
  });
}

test('license manager registers a key and reloads encrypted state', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'appmanager-license-manager-'));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const manager = createManager(tempDir);
  const key = generateProductKey(undefined, { tier: 'enterprise' });
  const registered = await manager.registerProductKey(key);

  assert.equal(registered.success, true);
  assert.equal(registered.status.isProUnlocked, true);
  assert.equal(registered.status.tierCode, '30');

  const licenseFilePath = path.join(tempDir, 'license.dat');
  const parsedFile = JSON.parse(await fs.readFile(licenseFilePath, 'utf8'));
  assert.equal(parsedFile.formatVersion, 2);
  assert.equal(typeof parsedFile.integrity, 'string');
  assert.equal(typeof parsedFile.payload, 'object');

  const reloaded = createManager(tempDir);
  await reloaded.loadLicenseState();
  const status = reloaded.getLicenseStatus();
  assert.equal(status.isProUnlocked, true);
  assert.equal(status.maskedKey, registered.status.maskedKey);
  assert.equal(status.tierCode, '30');
});

test('license manager applies registration cooldown after repeated invalid attempts', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'appmanager-license-rate-limit-'));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const manager = createManager(tempDir);
  const first = await manager.registerProductKey('not-a-valid-key');
  const second = await manager.registerProductKey('not-a-valid-key');

  assert.equal(first.success, false);
  assert.equal(second.success, false);
  assert.match(second.error, /wait/i);
  assert.ok(Number(second.retryAfterMs) > 0);
});

test('license manager rejects tampered integrity payloads on load', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'appmanager-license-integrity-'));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const manager = createManager(tempDir);
  const key = generateProductKey();
  const registered = await manager.registerProductKey(key);
  assert.equal(registered.success, true);

  const licenseFilePath = path.join(tempDir, 'license.dat');
  const parsedFile = JSON.parse(await fs.readFile(licenseFilePath, 'utf8'));
  parsedFile.integrity = parsedFile.integrity.startsWith('0')
    ? `1${parsedFile.integrity.slice(1)}`
    : `0${parsedFile.integrity.slice(1)}`;
  await fs.writeFile(licenseFilePath, JSON.stringify(parsedFile, null, 2), 'utf8');

  const reloaded = createManager(tempDir);
  await reloaded.loadLicenseState();
  const status = reloaded.getLicenseStatus();
  assert.equal(status.isProUnlocked, false);
  assert.equal(status.maskedKey, '');
});

test('license manager starts locked when no license file exists', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'appmanager-license-empty-'));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const manager = createManager(tempDir);
  await manager.loadLicenseState();
  const status = manager.getLicenseStatus();
  assert.equal(status.isProUnlocked, false);
  assert.equal(status.maskedKey, '');
});
