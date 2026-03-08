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

test('index does not use inline onclick handlers', () => {
  const html = readRootFile('index.html');
  assert.doesNotMatch(html, /\sonclick=/i);
});

test('CSP disallows inline scripts', () => {
  const html = readRootFile('index.html');
  const cspMatch = html.match(/Content-Security-Policy"\s+content="([^"]+)"/i);
  assert.ok(cspMatch);
  assert.match(cspMatch[1], /script-src 'self'/);
  assert.doesNotMatch(cspMatch[1], /script-src[^;]*'unsafe-inline'/);
});

test('renderer installs legacy inline action bridge for CSP-safe dynamic actions', () => {
  const rendererRuntimeSource = readRendererRuntimeSource();
  assert.match(rendererRuntimeSource, /function initializeLegacyInlineActionBridge\(\)/);
  assert.match(rendererRuntimeSource, /initializeLegacyInlineActionBridge\(\);/);
});

test('renderer shared modules are loaded before renderer startup', () => {
  const html = readRootFile('index.html');
  assert.match(html, /<script src="renderer-shared-modules\.js"><\/script>/i);
  assert.match(html, /<script src="renderer\.js"><\/script>/i);
  assert.ok(
    html.indexOf('renderer-shared-modules.js') < html.indexOf('renderer.js'),
    'renderer-shared-modules.js should load before renderer.js'
  );

  const rendererBootstrapSource = readRootFile('renderer.js');
  assert.match(rendererBootstrapSource, /renderer\/app\.js/);

  const rendererRuntimeSource = readRendererRuntimeSource();
  assert.match(rendererRuntimeSource, /window\.AppRendererModules/);
  assert.match(rendererRuntimeSource, /Renderer shared modules are unavailable/);
  assert.match(rendererRuntimeSource, /rendererModules\?\.asyncUtils/);
  assert.match(rendererRuntimeSource, /createExpiringAsyncCache/);
});
