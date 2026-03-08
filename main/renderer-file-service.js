const path = require('path');
const fs = require('fs').promises;

function createRendererFileService({
  validateGitPath,
  sanitizeAppSettings,
  getRendererSafeSettings,
  getProjectsBasePath,
  getCurrentSettings,
  maxSettingsFileSizeBytes,
  maxSettingsPathLength,
  logger
}) {
  function resolveSafeJsonFilePath(filePath) {
    if (typeof filePath !== 'string') {
      return { valid: false, error: 'Invalid file path.' };
    }

    const trimmed = filePath.trim();
    if (!trimmed || trimmed.length > maxSettingsPathLength) {
      return { valid: false, error: 'Invalid file path.' };
    }

    if (!path.isAbsolute(trimmed)) {
      return { valid: false, error: 'Use an absolute file path.' };
    }

    const resolvedPath = path.resolve(trimmed);
    const extension = path.extname(resolvedPath).toLowerCase();
    if (extension !== '.json') {
      return { valid: false, error: 'Only JSON files are supported.' };
    }

    return { valid: true, path: resolvedPath };
  }

  async function checkPathExists(targetPath) {
    if (typeof targetPath !== 'string') {
      return false;
    }

    const trimmed = targetPath.trim();
    if (!trimmed || trimmed.length > maxSettingsPathLength || !path.isAbsolute(trimmed)) {
      return false;
    }

    const resolvedPath = path.resolve(trimmed);
    try {
      await fs.access(resolvedPath);
      return true;
    } catch {
      return false;
    }
  }

  async function checkGitRepositoryPath(targetPath) {
    const validation = validateGitPath(targetPath);
    if (!validation.valid) {
      return false;
    }

    try {
      const gitMetadataPath = path.join(validation.path, '.git');
      const stats = await fs.stat(gitMetadataPath);
      return stats.isDirectory() || stats.isFile();
    } catch {
      return false;
    }
  }

  async function importSettingsFromJsonFile(filePath) {
    const filePathValidation = resolveSafeJsonFilePath(filePath);
    if (!filePathValidation.valid) {
      return { success: false, error: filePathValidation.error };
    }

    try {
      const stats = await fs.stat(filePathValidation.path);
      if (!stats.isFile()) {
        return { success: false, error: 'Selected path is not a file.' };
      }

      if (stats.size > maxSettingsFileSizeBytes) {
        return { success: false, error: 'Settings file is too large to import.' };
      }

      const rawContent = await fs.readFile(filePathValidation.path, 'utf8');
      let parsed;
      try {
        parsed = JSON.parse(rawContent);
      } catch {
        return { success: false, error: 'Settings file contains invalid JSON.' };
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { success: false, error: 'Invalid settings payload. Expected a JSON object.' };
      }

      return {
        success: true,
        settings: sanitizeAppSettings(parsed, getProjectsBasePath())
      };
    } catch (error) {
      logger?.warn('Failed to import settings file', { path: filePathValidation.path, error: error.message });
      return { success: false, error: 'Unable to read settings file.' };
    }
  }

  async function exportSettingsToJsonFile(filePath, settingsPayload) {
    const filePathValidation = resolveSafeJsonFilePath(filePath);
    if (!filePathValidation.valid) {
      return { success: false, error: filePathValidation.error };
    }

    const incomingSettings = settingsPayload && typeof settingsPayload === 'object' && !Array.isArray(settingsPayload)
      ? settingsPayload
      : {};
    const sanitizedPayload = sanitizeAppSettings(
      { ...getCurrentSettings(), ...incomingSettings },
      getProjectsBasePath()
    );
    const serializedPayload = JSON.stringify(getRendererSafeSettings(sanitizedPayload), null, 2);
    const targetDirectory = path.dirname(filePathValidation.path);
    const tempFilePath = path.join(
      targetDirectory,
      `.${path.basename(filePathValidation.path)}.${process.pid}.${Date.now()}.tmp`
    );

    try {
      await fs.mkdir(targetDirectory, { recursive: true });
      await fs.writeFile(tempFilePath, serializedPayload, 'utf8');
      await fs.rename(tempFilePath, filePathValidation.path);
      return { success: true };
    } catch (error) {
      await fs.unlink(tempFilePath).catch(() => {});
      logger?.warn('Failed to export settings file', { path: filePathValidation.path, error: error.message });
      return { success: false, error: 'Unable to write settings file.' };
    }
  }

  return {
    checkPathExists,
    checkGitRepositoryPath,
    importSettingsFromJsonFile,
    exportSettingsToJsonFile
  };
}

module.exports = {
  createRendererFileService
};
