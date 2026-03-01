const path = require('path');
const fs = require('fs');

const FIXED_ALLOWED_RUN_COMMANDS = new Map([
  ['npm install', { executable: 'npm', args: ['install'] }],
  ['npm start', { executable: 'npm', args: ['start'] }],
  ['npm update', { executable: 'npm', args: ['update'] }],
  ['npm run build', { executable: 'npm', args: ['run', 'build'] }],
  ['pip install -r requirements.txt', { executable: 'pip', args: ['install', '-r', 'requirements.txt'] }],
  ['pip install --upgrade -r requirements.txt', { executable: 'pip', args: ['install', '--upgrade', '-r', 'requirements.txt'] }],
  ['python setup.py build', { executable: 'python', args: ['setup.py', 'build'] }],
  ['python main.py', { executable: 'python', args: ['main.py'] }],
  ['./main', { executable: './main', args: [] }],
  ['make build', { executable: 'make', args: ['build'] }],
  ['mvn compile', { executable: 'mvn', args: ['compile'] }],
  ['mvn install', { executable: 'mvn', args: ['install'] }],
  ['mvn versions:use-latest-releases', { executable: 'mvn', args: ['versions:use-latest-releases'] }],
  ['java Main', { executable: 'java', args: ['Main'] }],
  ['git add .', { executable: 'git', args: ['add', '.'] }],
  ['git add "."', { executable: 'git', args: ['add', '.'] }],
  ['git reset HEAD', { executable: 'git', args: ['reset', 'HEAD'] }],
  ['git checkout -- .', { executable: 'git', args: ['checkout', '--', '.'] }]
]);

const ALLOWED_RUN_COMMAND_PATTERNS = Array.from(
  FIXED_ALLOWED_RUN_COMMANDS.keys(),
  (command) => new RegExp(`^${escapeRegExp(command)}$`)
);

const GIT_FILE_COMMAND_PATTERNS = [
  {
    pattern: /^git add \"([^\"\r\n]+)\"$/,
    toArgs: (filePath) => ['add', filePath]
  },
  {
    pattern: /^git reset HEAD \"([^\"\r\n]+)\"$/,
    toArgs: (filePath) => ['reset', 'HEAD', filePath]
  },
  {
    pattern: /^git checkout -- \"([^\"\r\n]+)\"$/,
    toArgs: (filePath) => ['checkout', '--', filePath]
  }
];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseAllowedRunCommand(command) {
  if (typeof command !== 'string') {
    return null;
  }

  const normalizedCommand = command.trim();
  if (!normalizedCommand) {
    return null;
  }

  const fixedCommand = FIXED_ALLOWED_RUN_COMMANDS.get(normalizedCommand);
  if (fixedCommand) {
    return {
      executable: fixedCommand.executable,
      args: [...fixedCommand.args],
      normalizedCommand
    };
  }

  for (const rule of GIT_FILE_COMMAND_PATTERNS) {
    const match = normalizedCommand.match(rule.pattern);
    if (!match) {
      continue;
    }

    const fileValidation = validateGitFilePathInput(match[1]);
    if (!fileValidation.valid) {
      return null;
    }

    return {
      executable: 'git',
      args: rule.toArgs(fileValidation.value),
      normalizedCommand
    };
  }

  return null;
}

function isAllowedRunCommand(command) {
  return Boolean(parseAllowedRunCommand(command));
}

function validateGitPath(projectPath) {
  if (!projectPath || typeof projectPath !== 'string') {
    return { valid: false, error: 'Invalid project path' };
  }

  const resolvedPath = path.resolve(projectPath);
  if (!resolvedPath || resolvedPath.length < 2) {
    return { valid: false, error: 'Invalid project path' };
  }

  try {
    const stats = fs.statSync(resolvedPath);
    if (!stats.isDirectory()) {
      return { valid: false, error: 'Project path is not a directory' };
    }
  } catch {
    return { valid: false, error: 'Project path does not exist' };
  }

  return { valid: true, path: resolvedPath };
}

function validateGitRefName(refName, label = 'Git reference') {
  if (!refName || typeof refName !== 'string') {
    return { valid: false, error: `${label} is required` };
  }

  const trimmedRef = refName.trim();
  if (!trimmedRef) {
    return { valid: false, error: `${label} is required` };
  }

  if (
    !/^[A-Za-z0-9._/-]+$/.test(trimmedRef) ||
    trimmedRef.includes('..') ||
    trimmedRef.includes('//') ||
    trimmedRef.includes('@{') ||
    trimmedRef.startsWith('/') ||
    trimmedRef.endsWith('/') ||
    trimmedRef.endsWith('.') ||
    trimmedRef.startsWith('-') ||
    trimmedRef.endsWith('.lock')
  ) {
    return { valid: false, error: `Invalid ${label.toLowerCase()}` };
  }

  const segments = trimmedRef.split('/');
  if (segments.some((segment) => !segment || segment.startsWith('.'))) {
    return { valid: false, error: `Invalid ${label.toLowerCase()}` };
  }

  return { valid: true, value: trimmedRef };
}

function validateGitHash(hash) {
  if (!hash || typeof hash !== 'string') {
    return { valid: false, error: 'Commit hash is required' };
  }

  const trimmedHash = hash.trim();
  if (!/^[a-fA-F0-9]{7,40}$/.test(trimmedHash)) {
    return { valid: false, error: 'Invalid commit hash format' };
  }

  return { valid: true, value: trimmedHash };
}

function validateGitRemoteName(remoteName) {
  if (!remoteName || typeof remoteName !== 'string') {
    return { valid: false, error: 'Remote name is required' };
  }

  const trimmedName = remoteName.trim();
  if (!trimmedName || !/^[A-Za-z0-9._-]+$/.test(trimmedName) || trimmedName.startsWith('-')) {
    return { valid: false, error: 'Invalid remote name' };
  }

  return { valid: true, value: trimmedName };
}

function validateGitRemoteUrl(url) {
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'Remote URL is required' };
  }

  const trimmedUrl = url.trim();
  const hasUnsafeChars = /["'`<>\r\n\s$&|;()\\]/.test(trimmedUrl);

  if (hasUnsafeChars) {
    return { valid: false, error: 'Invalid remote URL' };
  }

  if (trimmedUrl.startsWith('git@')) {
    if (!/^git@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+(?:\.git)?$/.test(trimmedUrl)) {
      return { valid: false, error: 'Invalid remote URL' };
    }
    return { valid: true, value: trimmedUrl };
  }

  try {
    const parsed = new URL(trimmedUrl);
    if (!['http:', 'https:', 'ssh:'].includes(parsed.protocol) || !parsed.hostname) {
      return { valid: false, error: 'Invalid remote URL' };
    }
  } catch {
    return { valid: false, error: 'Invalid remote URL' };
  }

  return { valid: true, value: trimmedUrl };
}

function validateGitFilePathInput(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return { valid: false, error: 'Invalid file path' };
  }

  const trimmedPath = filePath.trim();
  if (!trimmedPath || /["'`$&|;()<>\r\n\0]/.test(trimmedPath)) {
    return { valid: false, error: 'Invalid file path' };
  }

  if (path.isAbsolute(trimmedPath)) {
    return { valid: false, error: 'Invalid file path' };
  }

  const normalizedPath = trimmedPath.replace(/\\/g, '/');
  const segments = normalizedPath.split('/').filter(Boolean);
  if (segments.length === 0) {
    return { valid: false, error: 'Invalid file path' };
  }

  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return { valid: false, error: 'Invalid file path' };
  }

  if (normalizedPath.startsWith('-')) {
    return { valid: false, error: 'Invalid file path' };
  }

  return { valid: true, value: normalizedPath };
}

async function validateCommandWorkingDirectory(projectPath) {
  if (!projectPath || typeof projectPath !== 'string') {
    return { valid: false, error: 'Invalid project path' };
  }

  const resolvedPath = path.resolve(projectPath);

  try {
    const stats = await fs.promises.stat(resolvedPath);
    if (!stats.isDirectory()) {
      return { valid: false, error: 'Project path is not a directory' };
    }
  } catch {
    return { valid: false, error: 'Project path does not exist' };
  }

  return { valid: true, path: resolvedPath };
}

module.exports = {
  ALLOWED_RUN_COMMAND_PATTERNS,
  parseAllowedRunCommand,
  isAllowedRunCommand,
  validateGitPath,
  validateGitRefName,
  validateGitHash,
  validateGitRemoteName,
  validateGitRemoteUrl,
  validateGitFilePathInput,
  validateCommandWorkingDirectory
};
