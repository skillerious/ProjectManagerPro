const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readRootJson(fileName) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', fileName), 'utf8'));
}

test('package version is the single app version source of truth', () => {
  const packageJson = readRootJson('package.json');
  const versionJson = readRootJson('version.json');

  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);
  assert.equal(Object.hasOwn(versionJson, 'version'), false);
  assert.match(String(versionJson.channel || ''), /^(stable|beta|alpha)$/);
});
