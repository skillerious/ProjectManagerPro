const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

const {
  parseAllowedRunCommand,
  isAllowedRunCommand,
  validateGitPath,
  validateGitRefName,
  validateGitHash,
  validateGitRemoteName,
  validateGitRemoteUrl,
  validateGitFilePathInput,
  validateCommandWorkingDirectory
} = require('../security-utils');
const { Logger } = require('../main/logger');
const { createWindowSecurityManager } = require('../main/window-security-manager');
const {
  buildWindowsCommandLine,
  executeWindowsCommand,
  MAX_WINDOWS_COMMAND_LENGTH
} = require('../main/windows-command-utils');
const { createVsCodeLauncherService } = require('../main/vscode-launcher-service');
const {
  GITHUB_TOKEN_ENCRYPTED_KEY,
  GITHUB_TOKEN_LEGACY_KEY,
  sanitizeAppSettings,
  getRendererSafeSettings
} = require('../main/settings/app-settings');

test('parseAllowedRunCommand returns executable and args for safe commands', () => {
  assert.deepEqual(
    parseAllowedRunCommand('npm run build'),
    {
      executable: 'npm',
      args: ['run', 'build'],
      normalizedCommand: 'npm run build'
    }
  );

  assert.deepEqual(
    parseAllowedRunCommand('git add "src/index.js"'),
    {
      executable: 'git',
      args: ['add', 'src/index.js'],
      normalizedCommand: 'git add "src/index.js"'
    }
  );

  assert.equal(parseAllowedRunCommand('git add "$(echo hacked)"'), null);
  assert.equal(parseAllowedRunCommand('npm install && whoami'), null);
});

test('isAllowedRunCommand accepts expected safe commands', () => {
  assert.equal(isAllowedRunCommand('npm install'), true);
  assert.equal(isAllowedRunCommand('npm run build'), true);
  assert.equal(isAllowedRunCommand('git add "."'), true);
  assert.equal(isAllowedRunCommand('git add "src/index.js"'), true);
  assert.equal(isAllowedRunCommand('git reset HEAD "src/index.js"'), true);
});

test('isAllowedRunCommand rejects command chaining and unknown commands', () => {
  assert.equal(isAllowedRunCommand('npm install && echo pwned'), false);
  assert.equal(isAllowedRunCommand('git add .; whoami'), false);
  assert.equal(isAllowedRunCommand('git add "$(echo pwned)"'), false);
  assert.equal(isAllowedRunCommand('git add "../escape.txt"'), false);
  assert.equal(isAllowedRunCommand('git reset HEAD "-option"'), false);
  assert.equal(parseAllowedRunCommand(`npm install ${'x'.repeat(3000)}`), null);
  assert.equal(isAllowedRunCommand('powershell -Command Get-ChildItem'), false);
});

test('validateGitPath validates existing directories only', () => {
  const valid = validateGitPath(process.cwd());
  assert.equal(valid.valid, true);
  assert.equal(valid.path, path.resolve(process.cwd()));

  assert.equal(validateGitPath('').valid, false);
  assert.equal(validateGitPath(path.join(os.tmpdir(), 'missing-appmanager-path')).valid, false);
});

test('validateGitRefName allows safe refs and rejects unsafe refs', () => {
  assert.deepEqual(validateGitRefName('feature/new-ui'), { valid: true, value: 'feature/new-ui' });
  assert.equal(validateGitRefName('bad branch').valid, false);
  assert.equal(validateGitRefName('../escape').valid, false);
  assert.equal(validateGitRefName('main;rm -rf').valid, false);
  assert.equal(validateGitRefName('-option-like').valid, false);
  assert.equal(validateGitRefName('main@{1}').valid, false);
  assert.equal(validateGitRefName('refs/.hidden').valid, false);
});

test('validateGitHash enforces hash format', () => {
  assert.deepEqual(validateGitHash('a1b2c3d'), { valid: true, value: 'a1b2c3d' });
  assert.deepEqual(validateGitHash('A1B2C3D4E5F6'), { valid: true, value: 'A1B2C3D4E5F6' });
  assert.equal(validateGitHash('xyz1234').valid, false);
  assert.equal(validateGitHash('abc').valid, false);
});

test('validate remote values and file path inputs', () => {
  assert.deepEqual(validateGitRemoteName('origin'), { valid: true, value: 'origin' });
  assert.equal(validateGitRemoteName('origin dev').valid, false);
  assert.equal(validateGitRemoteName('-origin').valid, false);

  assert.deepEqual(
    validateGitRemoteUrl('https://github.com/user/repo.git'),
    { valid: true, value: 'https://github.com/user/repo.git' }
  );
  assert.deepEqual(
    validateGitRemoteUrl('git@github.com:user/repo.git'),
    { valid: true, value: 'git@github.com:user/repo.git' }
  );
  assert.equal(validateGitRemoteUrl('javascript:alert(1)').valid, false);
  assert.equal(validateGitRemoteUrl('https://example.com/"bad"').valid, false);
  assert.equal(validateGitRemoteUrl('git@github.com:user/repo.git with-space').valid, false);
  assert.equal(validateGitRemoteUrl('https://github.com/user/repo.git$(touch hacked)').valid, false);

  assert.deepEqual(validateGitFilePathInput('src/app.js'), { valid: true, value: 'src/app.js' });
  assert.deepEqual(validateGitFilePathInput('src\\app.js'), { valid: true, value: 'src/app.js' });
  assert.equal(validateGitFilePathInput('src/$(echo pwn).js').valid, false);
  assert.equal(validateGitFilePathInput('../evil/path').valid, false);
  assert.equal(validateGitFilePathInput('-option-like').valid, false);
  assert.equal(validateGitFilePathInput(':(glob)**/*.js').valid, false);
  assert.equal(validateGitFilePathInput(path.resolve('src/app.js')).valid, false);
});

test('validateCommandWorkingDirectory checks directory existence', async () => {
  const valid = await validateCommandWorkingDirectory(process.cwd());
  assert.equal(valid.valid, true);
  assert.equal(valid.path, path.resolve(process.cwd()));

  const invalid = await validateCommandWorkingDirectory(path.join(os.tmpdir(), 'missing-workdir'));
  assert.equal(invalid.valid, false);
});

test('logger safely handles unserializable payloads', async () => {
  const logger = new Logger({
    app: { getPath: () => os.tmpdir() },
    fsPromises: {
      async mkdir() {},
      async appendFile() {}
    },
    consoleRef: {
      log() {},
      warn() {},
      error() {}
    }
  });

  const circular = {};
  circular.self = circular;
  await assert.doesNotReject(async () => logger.info('unserializable payload', circular));
});

test('logger keeps filterable history snapshots and supports live listeners', async () => {
  const logger = new Logger({
    app: { getPath: () => os.tmpdir() },
    fsPromises: {
      async mkdir() {},
      async appendFile() {}
    },
    consoleRef: {
      log() {},
      warn() {},
      error() {}
    },
    maxHistoryEntries: 12
  });

  const capturedEntries = [];
  const unsubscribe = logger.onEntry((entry) => capturedEntries.push(entry));

  await logger.info('startup complete', { source: 'bootstrap' });
  await logger.warn('network timeout', { source: 'sync', attempts: 2 });
  await logger.error('fatal sync failure', { source: 'sync' });
  unsubscribe();

  assert.equal(capturedEntries.length, 3);
  assert.equal(capturedEntries[0].source, 'bootstrap');
  assert.equal(capturedEntries[2].level, 'error');

  const faultSnapshot = logger.getHistorySnapshot({
    faultOnly: true,
    sort: 'desc',
    limit: 10
  });

  assert.equal(faultSnapshot.totalEntries, 3);
  assert.equal(faultSnapshot.filteredEntries, 2);
  assert.equal(faultSnapshot.entries[0].level, 'error');
  assert.equal(faultSnapshot.entries[1].level, 'warn');
  assert.equal(faultSnapshot.stats.faultCount, 2);

  logger.clearHistory();
  const cleared = logger.getHistorySnapshot({ limit: 5 });
  assert.equal(cleared.totalEntries, 0);
  assert.equal(cleared.entries.length, 0);
});

test('window security manager validates and rejects unsafe URLs', () => {
  const manager = createWindowSecurityManager({
    baseDir: process.cwd(),
    logger: { warn() {} },
    session: null,
    shell: null
  });

  assert.equal(manager.validateExternalUrl('https://example.com').valid, true);
  assert.equal(manager.validateExternalUrl('javascript:alert(1)').valid, false);
  const blockedFile = manager.validateExternalUrl('file:///tmp/test.txt');
  assert.equal(blockedFile.valid, false);
  assert.equal(blockedFile.error, 'Unsupported URL protocol');
});

test('windows command utils quote and reject oversized commands', async () => {
  const commandLine = buildWindowsCommandLine(
    { command: 'C:\\Program Files\\Tool\\tool.cmd', requiresAbsolutePath: true },
    ['alpha', '100%']
  );
  assert.match(commandLine, /^"/);
  assert.match(commandLine, /%%/);

  const oversized = await executeWindowsCommand('x'.repeat(MAX_WINDOWS_COMMAND_LENGTH + 10));
  assert.equal(oversized.success, false);
  assert.match(oversized.error, /too long/i);
});

test('vscode launcher service caches successful launcher resolution', async () => {
  let executeCallCount = 0;
  const service = createVsCodeLauncherService({
    platform: 'win32',
    env: {},
    windowsCommandUtils: {
      buildWindowsCommandLine() {
        return 'code --version';
      },
      async executeWindowsCommand() {
        executeCallCount += 1;
        return { success: true, stdout: '1.0.0', stderr: '' };
      }
    },
    fsPromises: {
      async access() {}
    }
  });

  const first = await service.resolveLauncher();
  const second = await service.resolveLauncher();
  assert.ok(first);
  assert.ok(second);
  assert.equal(executeCallCount, 1);
});

test('validateGitRefName rejects null bytes and CRLF injection attempts', () => {
  assert.equal(validateGitRefName('main\0evil').valid, false);
  assert.equal(validateGitRefName('main\r\nevil').valid, false);
  assert.equal(validateGitRefName('main\nevil').valid, false);
  assert.equal(validateGitRefName('a'.repeat(300)).valid, false);
  assert.equal(validateGitRefName('').valid, false);
});

test('validateGitFilePathInput rejects null bytes and encoded traversal', () => {
  assert.equal(validateGitFilePathInput('src/\0evil.js').valid, false);
  assert.equal(validateGitFilePathInput('src/..\\..\\etc\\passwd').valid, false);
  assert.equal(validateGitFilePathInput('a'.repeat(1025)).valid, false);
  // Exactly at the limit should still be valid
  assert.equal(validateGitFilePathInput('a'.repeat(1024)).valid, true);
});

test('parseAllowedRunCommand rejects nested quote injection and pipe attacks', () => {
  assert.equal(parseAllowedRunCommand('git add "src/\'$(echo pwned)\'.js"'), null);
  assert.equal(parseAllowedRunCommand('npm install | cat /etc/passwd'), null);
  assert.equal(parseAllowedRunCommand('git add `whoami`'), null);
  assert.equal(parseAllowedRunCommand('npm install; rm -rf /'), null);
  assert.equal(parseAllowedRunCommand(''), null);
});

test('window security manager rejects invalid fileURLToPath results', () => {
  const manager = createWindowSecurityManager({
    baseDir: process.cwd(),
    logger: { warn() {} },
    session: null,
    shell: null,
    fileURLToPathFn: () => ''  // simulate empty result
  });

  assert.equal(manager.isTrustedLocalAppUrl('file:///test.html'), false);
});

test('settings sanitization enforces allowed values and strips renderer secrets', () => {
  const sanitized = sanitizeAppSettings({
    theme: 'ext:my-theme',
    terminalApp: 'PoWeRsHeLl',
    updateChannel: 'BeTa',
    extensionUpdateCheck: 'WEEKLY',
    repoUrl: 'https://user:secret@example.com/private',
    defaultBranch: 'feature/.hidden',
    [GITHUB_TOKEN_ENCRYPTED_KEY]: 'ZmFrZQ==',
    [GITHUB_TOKEN_LEGACY_KEY]: 'legacytoken'
  }, process.cwd());

  assert.equal(sanitized.theme, 'ext:my-theme');
  assert.equal(sanitized.terminalApp, 'powershell');
  assert.equal(sanitized.updateChannel, 'beta');
  assert.equal(sanitized.extensionUpdateCheck, 'weekly');
  assert.equal(sanitized.repoUrl, '');
  assert.equal(sanitized.defaultBranch, 'main');
  assert.equal(typeof sanitized[GITHUB_TOKEN_ENCRYPTED_KEY], 'string');
  assert.equal(typeof sanitized[GITHUB_TOKEN_LEGACY_KEY], 'undefined');

  const rendererSafe = getRendererSafeSettings(sanitized);
  assert.equal(Object.hasOwn(rendererSafe, GITHUB_TOKEN_ENCRYPTED_KEY), false);
  assert.equal(Object.hasOwn(rendererSafe, GITHUB_TOKEN_LEGACY_KEY), false);
});
