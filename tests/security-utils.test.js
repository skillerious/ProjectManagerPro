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
  assert.equal(validateGitFilePathInput(path.resolve('src/app.js')).valid, false);
});

test('validateCommandWorkingDirectory checks directory existence', async () => {
  const valid = await validateCommandWorkingDirectory(process.cwd());
  assert.equal(valid.valid, true);
  assert.equal(valid.path, path.resolve(process.cwd()));

  const invalid = await validateCommandWorkingDirectory(path.join(os.tmpdir(), 'missing-workdir'));
  assert.equal(invalid.valid, false);
});
