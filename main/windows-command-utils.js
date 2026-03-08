const { exec } = require('child_process');

const MAX_WINDOWS_COMMAND_LENGTH = 32760;

function quoteWindowsShellArg(value) {
  return `"${String(value).replace(/"/g, '""').replace(/%/g, '%%')}"`;
}

function buildWindowsCommandLine(commandConfig, args = []) {
  const commandValue = commandConfig && typeof commandConfig.command === 'string'
    ? commandConfig.command
    : '';
  const shouldQuoteCommand = Boolean(commandConfig?.requiresAbsolutePath) || /\s/.test(commandValue);
  const commandToken = shouldQuoteCommand
    ? quoteWindowsShellArg(commandValue)
    : commandValue;
  const argTokens = Array.isArray(args)
    ? args.map((arg) => quoteWindowsShellArg(arg))
    : [];
  return [commandToken, ...argTokens].join(' ');
}

function executeWindowsCommand(commandLine, timeout = 4000, options = {}) {
  const normalizedCommandLine = typeof commandLine === 'string' ? commandLine.trim() : '';
  if (!normalizedCommandLine) {
    return Promise.resolve({ success: false, error: 'Command is required', stdout: '', stderr: '' });
  }
  if (normalizedCommandLine.length > MAX_WINDOWS_COMMAND_LENGTH) {
    return Promise.resolve({ success: false, error: 'Command is too long', stdout: '', stderr: '' });
  }

  const normalizedTimeout = Math.max(500, Math.min(10 * 60 * 1000, Number(timeout) || 4000));
  const execFn = typeof options.execFn === 'function' ? options.execFn : exec;
  const commandOptions = {
    windowsHide: true,
    timeout: normalizedTimeout,
    ...(options.execOptions && typeof options.execOptions === 'object' ? options.execOptions : {})
  };

  return new Promise((resolve) => {
    execFn(normalizedCommandLine, commandOptions, (error, stdout = '', stderr = '') => {
      if (error) {
        resolve({
          success: false,
          error: (stderr && stderr.trim()) || error.message,
          stdout,
          stderr
        });
        return;
      }

      resolve({ success: true, stdout, stderr, error: '' });
    });
  });
}

function createWindowsCommandUtils() {
  return {
    quoteWindowsShellArg,
    buildWindowsCommandLine,
    executeWindowsCommand
  };
}

module.exports = {
  MAX_WINDOWS_COMMAND_LENGTH,
  quoteWindowsShellArg,
  buildWindowsCommandLine,
  executeWindowsCommand,
  createWindowsCommandUtils
};
