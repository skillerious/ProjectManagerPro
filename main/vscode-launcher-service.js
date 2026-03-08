const path = require('path');
const fs = require('fs').promises;
const { spawn } = require('child_process');
const { createWindowsCommandUtils } = require('./windows-command-utils');

const DEFAULT_PROBE_TIMEOUT_MS = 4000;
const DEFAULT_LAUNCH_TIMEOUT_MS = 15000;

function createVsCodeLauncherService({
  platform = process.platform,
  env = process.env,
  pathModule = path,
  fsPromises = fs,
  spawnFn = spawn,
  windowsCommandUtils = createWindowsCommandUtils()
} = {}) {
  let cachedLauncher = null;

  function getVsCodeLaunchCandidates() {
    const candidates = [];

    if (platform === 'win32') {
      const localAppData = env.LOCALAPPDATA;
      const programFiles = env.ProgramFiles;
      const programFilesX86 = env['ProgramFiles(x86)'];

      [
        localAppData && pathModule.join(localAppData, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
        programFiles && pathModule.join(programFiles, 'Microsoft VS Code', 'bin', 'code.cmd'),
        programFilesX86 && pathModule.join(programFilesX86, 'Microsoft VS Code', 'bin', 'code.cmd'),
        localAppData && pathModule.join(localAppData, 'Programs', 'Microsoft VS Code Insiders', 'bin', 'code-insiders.cmd'),
        programFiles && pathModule.join(programFiles, 'Microsoft VS Code Insiders', 'bin', 'code-insiders.cmd'),
        programFilesX86 && pathModule.join(programFilesX86, 'Microsoft VS Code Insiders', 'bin', 'code-insiders.cmd')
      ]
        .filter(Boolean)
        .forEach((candidatePath) => {
          candidates.push({ command: candidatePath, requiresAbsolutePath: true });
        });

      candidates.push({ command: 'code.cmd' });
      candidates.push({ command: 'code' });
    } else if (platform === 'darwin') {
      candidates.push({ command: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', requiresAbsolutePath: true });
      candidates.push({ command: '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code', requiresAbsolutePath: true });
      candidates.push({ command: 'code' });
      candidates.push({ command: 'code-insiders' });
    } else {
      candidates.push({ command: '/usr/bin/code', requiresAbsolutePath: true });
      candidates.push({ command: '/snap/bin/code', requiresAbsolutePath: true });
      candidates.push({ command: 'code' });
      candidates.push({ command: 'code-insiders' });
    }

    return candidates;
  }

  async function probeCommand(commandConfig, args = ['--version']) {
    if (!commandConfig || typeof commandConfig.command !== 'string' || !commandConfig.command.trim()) {
      return false;
    }

    if (commandConfig.requiresAbsolutePath) {
      try {
        await fsPromises.access(commandConfig.command);
      } catch {
        return false;
      }
    }

    if (platform === 'win32') {
      const commandLine = windowsCommandUtils.buildWindowsCommandLine(commandConfig, args);
      const probeResult = await windowsCommandUtils.executeWindowsCommand(commandLine, DEFAULT_PROBE_TIMEOUT_MS);
      return probeResult.success;
    }

    return new Promise((resolve) => {
      let settled = false;
      const commandProcess = spawnFn(commandConfig.command, args, {
        windowsHide: true,
        stdio: 'ignore'
      });

      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          commandProcess.kill();
        } catch {
          // Ignore kill errors
        }
        resolve(false);
      }, DEFAULT_PROBE_TIMEOUT_MS);

      commandProcess.on('error', () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve(false);
      });

      commandProcess.on('close', (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve(code === 0);
      });
    });
  }

  async function resolveLauncher(forceRefresh = false) {
    if (!forceRefresh && cachedLauncher) {
      return cachedLauncher;
    }

    const candidates = getVsCodeLaunchCandidates();
    for (const candidate of candidates) {
      if (await probeCommand(candidate)) {
        cachedLauncher = candidate;
        return candidate;
      }
    }

    cachedLauncher = null;
    return null;
  }

  async function launchNonWindows(launcherCommand, targetPath) {
    return new Promise((resolve) => {
      const codeProcess = spawnFn(launcherCommand, [targetPath], {
        windowsHide: true,
        stdio: 'ignore'
      });

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          codeProcess.kill();
        } catch {
          // Ignore kill errors
        }
        resolve({ success: false, error: 'VS Code launch timed out' });
      }, DEFAULT_LAUNCH_TIMEOUT_MS);

      codeProcess.on('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({ success: false, error: error.message });
      });

      codeProcess.on('close', (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          resolve({ success: true });
        } else {
          resolve({ success: false, error: `VS Code exited with code ${code}` });
        }
      });
    });
  }

  async function openPathInVsCode(targetPath) {
    if (typeof targetPath !== 'string' || !targetPath.trim()) {
      return { success: false, error: 'Invalid target path' };
    }

    const launchers = [];
    const resolvedLauncher = await resolveLauncher();

    if (resolvedLauncher) {
      launchers.push(resolvedLauncher);
    }

    const fallbackCandidates = getVsCodeLaunchCandidates();
    fallbackCandidates.forEach((candidate) => {
      if (!launchers.some((existing) => existing.command === candidate.command)) {
        launchers.push(candidate);
      }
    });

    let lastError = '';
    for (const launcher of launchers) {
      if (launcher.requiresAbsolutePath) {
        try {
          await fsPromises.access(launcher.command);
        } catch {
          continue;
        }
      }

      let launchResult;
      if (platform === 'win32') {
        const commandLine = windowsCommandUtils.buildWindowsCommandLine(launcher, [targetPath]);
        launchResult = await windowsCommandUtils.executeWindowsCommand(commandLine, DEFAULT_LAUNCH_TIMEOUT_MS);
      } else {
        launchResult = await launchNonWindows(launcher.command, targetPath);
      }

      if (launchResult.success) {
        cachedLauncher = launcher;
        return { success: true, launcher: launcher.command };
      }

      if (launchResult.error) {
        lastError = launchResult.error;
      }
    }

    return {
      success: false,
      error: lastError || 'VS Code not found. Install VS Code and ensure the "code" command is available.'
    };
  }

  return {
    getVsCodeLaunchCandidates,
    probeCommand,
    resolveLauncher,
    openPathInVsCode
  };
}

module.exports = {
  createVsCodeLauncherService
};
