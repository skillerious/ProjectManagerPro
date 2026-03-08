const path = require('path');
const crypto = require('crypto');

const MAX_TASK_PROFILE_PROJECT_ENTRIES = 2000;
const MAX_RECENT_PROJECT_ENTRIES = 300;
const SNAPSHOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_PROFILE_RUN_ON_VALUES = new Set(['manual']);

function tokenizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .match(/[a-z0-9._-]+/g) || [];
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeSnapshotName(name, fallback = 'Workspace Snapshot') {
  if (typeof name !== 'string') {
    return fallback;
  }
  const trimmed = name.trim();
  return trimmed ? trimmed.slice(0, 120) : fallback;
}

function sanitizeString(value, maxLength = 120) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().slice(0, maxLength);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPathWithinBase(basePath, candidatePath) {
  const resolvedBase = path.resolve(basePath);
  const resolvedCandidate = path.resolve(candidatePath);

  if (process.platform === 'win32') {
    const baseLower = resolvedBase.toLowerCase();
    const candidateLower = resolvedCandidate.toLowerCase();
    return candidateLower === baseLower || candidateLower.startsWith(`${baseLower}${path.sep}`);
  }

  return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
}

function normalizeSnapshotId(snapshotId) {
  const normalized = sanitizeString(snapshotId, 64).toLowerCase();
  return SNAPSHOT_ID_PATTERN.test(normalized) ? normalized : '';
}

function sanitizeRecentProjectEntry(projectEntry) {
  if (!isPlainObject(projectEntry)) {
    return null;
  }

  const projectPath = typeof projectEntry.path === 'string' ? projectEntry.path : '';
  const projectName = normalizeSnapshotName(projectEntry.name, path.basename(projectPath || '') || 'Project');
  if (!projectPath) {
    return null;
  }

  return {
    name: projectName,
    path: projectPath
  };
}

function sanitizeRecentProjects(recentProjects) {
  return asArray(recentProjects)
    .map((entry) => sanitizeRecentProjectEntry(entry))
    .filter(Boolean)
    .slice(0, MAX_RECENT_PROJECT_ENTRIES);
}

function sanitizeTaskProfileCwd(cwdInput) {
  const trimmed = sanitizeString(cwdInput, 500);
  if (!trimmed) {
    return '';
  }

  if (/[\0\r\n]/.test(trimmed) || path.isAbsolute(trimmed)) {
    return '';
  }

  const normalized = trimmed.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '..')) {
    return '';
  }

  return normalized;
}

function sanitizeTaskProfile(profile) {
  if (!isPlainObject(profile)) {
    return null;
  }

  const command = sanitizeString(profile.command, 300);
  if (!command) {
    return null;
  }

  const runOnCandidate = sanitizeString(profile.runOn, 32).toLowerCase();
  const runOn = TASK_PROFILE_RUN_ON_VALUES.has(runOnCandidate) ? runOnCandidate : 'manual';

  return {
    id: sanitizeString(profile.id, 64) || crypto.randomUUID(),
    name: normalizeSnapshotName(profile.name, 'Task'),
    command,
    cwd: sanitizeTaskProfileCwd(profile.cwd),
    runOn
  };
}

function sanitizeTaskProfiles(profiles) {
  const sanitized = [];
  const seenIds = new Set();

  for (const profile of asArray(profiles)) {
    const normalized = sanitizeTaskProfile(profile);
    if (!normalized) {
      continue;
    }

    if (seenIds.has(normalized.id)) {
      normalized.id = crypto.randomUUID();
    }

    seenIds.add(normalized.id);
    sanitized.push(normalized);
    if (sanitized.length >= 200) {
      break;
    }
  }

  return sanitized;
}

function sanitizeTaskProfilesDocument(data) {
  if (!isPlainObject(data)) {
    return {};
  }

  const next = {};
  const entries = Object.entries(data);
  for (const [projectPath, profiles] of entries) {
    if (typeof projectPath !== 'string' || !projectPath.trim()) {
      continue;
    }

    const resolvedProjectPath = path.resolve(projectPath.trim());
    next[resolvedProjectPath] = sanitizeTaskProfiles(profiles);
    if (Object.keys(next).length >= MAX_TASK_PROFILE_PROJECT_ENTRIES) {
      break;
    }
  }

  return next;
}

function cloneSearchQueryResult(payload) {
  return {
    success: Boolean(payload?.success),
    builtAt: typeof payload?.builtAt === 'string' ? payload.builtAt : null,
    total: Math.max(0, Number(payload?.total) || 0),
    hasMore: Boolean(payload?.hasMore),
    results: asArray(payload?.results).map((entry) => ({
      type: typeof entry?.type === 'string' ? entry.type : '',
      label: typeof entry?.label === 'string' ? entry.label : '',
      projectPath: typeof entry?.projectPath === 'string' ? entry.projectPath : '',
      filePath: typeof entry?.filePath === 'string' ? entry.filePath : '',
      hash: typeof entry?.hash === 'string' ? entry.hash : ''
    }))
  };
}

module.exports = {
  tokenizeSearchText,
  asArray,
  normalizeSnapshotName,
  sanitizeString,
  isPlainObject,
  isPathWithinBase,
  normalizeSnapshotId,
  sanitizeRecentProjects,
  sanitizeTaskProfiles,
  sanitizeTaskProfilesDocument,
  cloneSearchQueryResult
};
