const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { execFile } = require('child_process');
const crypto = require('crypto');
const {
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
} = require('./workspace/workspace-utils');

const MAX_SEARCH_INDEX_ENTRIES = 60000;
const MAX_SEARCH_LOOKUP_BUCKET_SIZE = 20000;
const MAX_SEARCH_QUERY_CACHE_ENTRIES = 160;
const MAX_SEARCH_QUERY_TOKEN_COUNT = 8;
const SEARCH_ENTRY_TEXT_MAX_LENGTH = 4096;
const MAX_JSON_READ_BYTES = 64 * 1024 * 1024;
const MAX_DISCOVERED_PROJECTS = 400;
const MAX_PROJECT_FILE_SCAN_LIMIT = 2000;
const MAX_GIT_COMMIT_SCAN_LIMIT = 200;
const MAX_SNAPSHOT_INDEX_ENTRIES = 100;
const SEARCH_DISCOVERY_EXCLUDED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo'
]);

class WorkspaceServices {
  constructor({ app, logger }) {
    this.app = app;
    this.logger = logger;
    this.searchIndex = this.loadSearchIndex();
    this.searchLookup = new Map();
    this.searchQueryCache = new Map();
    this.rebuildSearchLookup();
  }

  getSnapshotsDir() {
    return path.join(this.app.getPath('userData'), 'workspace-snapshots');
  }

  getSnapshotIndexPath() {
    return path.join(this.getSnapshotsDir(), 'index.json');
  }

  getTaskProfilesPath() {
    return path.join(this.app.getPath('userData'), 'task-profiles.json');
  }

  getSearchIndexPath() {
    return path.join(this.app.getPath('userData'), 'search-index.json');
  }

  sanitizeSearchIndex(input) {
    if (!input || typeof input !== 'object') {
      return {
        builtAt: null,
        workspacePath: '',
        entries: []
      };
    }

    const entries = asArray(input.entries)
      .slice(0, MAX_SEARCH_INDEX_ENTRIES)
      .filter((entry) => entry && typeof entry === 'object' && typeof entry.text === 'string')
      .map((entry) => ({
        type: typeof entry.type === 'string' ? entry.type : 'project',
        projectPath: typeof entry.projectPath === 'string' ? entry.projectPath : '',
        label: typeof entry.label === 'string' ? entry.label : '',
        filePath: typeof entry.filePath === 'string' ? entry.filePath : '',
        hash: typeof entry.hash === 'string' ? entry.hash : '',
        text: entry.text.slice(0, SEARCH_ENTRY_TEXT_MAX_LENGTH).toLowerCase()
      }));

    return {
      builtAt: typeof input.builtAt === 'string' ? input.builtAt : null,
      workspacePath: typeof input.workspacePath === 'string' ? input.workspacePath : '',
      entries
    };
  }

  loadSearchIndex() {
    const fallback = {
      builtAt: null,
      workspacePath: '',
      entries: []
    };

    try {
      const stats = fsSync.statSync(this.getSearchIndexPath());
      if (!stats.isFile() || stats.size > MAX_JSON_READ_BYTES) {
        return fallback;
      }
      const raw = fsSync.readFileSync(this.getSearchIndexPath(), 'utf8');
      const parsed = JSON.parse(raw);
      return this.sanitizeSearchIndex(parsed);
    } catch {
      return fallback;
    }
  }

  async persistSearchIndex() {
    try {
      await this.writeJson(this.getSearchIndexPath(), this.searchIndex);
    } catch (error) {
      this.logger?.warn('Failed to persist search index', { error: error.message });
    }
  }

  rebuildSearchLookup() {
    this.searchLookup = new Map();
    this.searchQueryCache = new Map();

    const entries = asArray(this.searchIndex?.entries);
    entries.forEach((entry, index) => {
      if (!entry || typeof entry.text !== 'string') {
        return;
      }

      const tokens = new Set(tokenizeSearchText(entry.text).slice(0, 40));
      tokens.forEach((token) => {
        if (token.length < 2) {
          return;
        }

        const existing = this.searchLookup.get(token) || [];
        if (existing.length >= MAX_SEARCH_LOOKUP_BUCKET_SIZE) {
          return;
        }
        existing.push(index);
        this.searchLookup.set(token, existing);
      });
    });
  }

  cacheSearchQueryResult(cacheKey, payload) {
    this.searchQueryCache.set(cacheKey, cloneSearchQueryResult(payload));
    if (this.searchQueryCache.size <= MAX_SEARCH_QUERY_CACHE_ENTRIES) {
      return;
    }

    const oldestKey = this.searchQueryCache.keys().next().value;
    if (oldestKey) {
      this.searchQueryCache.delete(oldestKey);
    }
  }

  async ensureSnapshotsDir() {
    await fs.mkdir(this.getSnapshotsDir(), { recursive: true });
  }

  async readJsonSafe(filePath, fallback) {
    try {
      const stats = await fs.stat(filePath);
      if (!stats.isFile() || stats.size > MAX_JSON_READ_BYTES) {
        return fallback;
      }
      const raw = await fs.readFile(filePath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  async writeJson(filePath, data) {
    const directoryPath = path.dirname(filePath);
    const payload = JSON.stringify(data, null, 2);
    const tempPath = path.join(
      directoryPath,
      `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
    );

    await fs.mkdir(directoryPath, { recursive: true });
    await fs.writeFile(tempPath, payload, 'utf8');
    try {
      await fs.rename(tempPath, filePath);
    } catch (error) {
      if (['EEXIST', 'EPERM', 'EXDEV'].includes(error?.code)) {
        await fs.writeFile(filePath, payload, 'utf8');
        await fs.unlink(tempPath).catch(() => {});
        return;
      }
      await fs.unlink(tempPath).catch(() => {});
      throw error;
    }
  }

  async listSnapshots() {
    await this.ensureSnapshotsDir();
    const index = await this.readJsonSafe(this.getSnapshotIndexPath(), []);
    return asArray(index)
      .map((item) => {
        if (!isPlainObject(item)) {
          return null;
        }
        const id = normalizeSnapshotId(item.id);
        if (!id) {
          return null;
        }
        return {
          id,
          name: normalizeSnapshotName(item.name, 'Workspace Snapshot'),
          createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
          workspacePath: typeof item.workspacePath === 'string' ? item.workspacePath : '',
          recentCount: Math.max(0, Number(item.recentCount) || 0)
        };
      })
      .filter(Boolean)
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }

  async createSnapshot({ name, workspacePath, settings, recentProjects }) {
    await this.ensureSnapshotsDir();
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const snapshotName = normalizeSnapshotName(name, `Snapshot ${createdAt.slice(0, 10)}`);
    const snapshot = {
      id,
      name: snapshotName,
      createdAt,
      workspacePath: typeof workspacePath === 'string' ? workspacePath : '',
      settings: isPlainObject(settings) ? settings : {},
      recentProjects: sanitizeRecentProjects(recentProjects)
    };

    const snapshotPath = path.join(this.getSnapshotsDir(), `${id}.json`);
    await this.writeJson(snapshotPath, snapshot);

    const index = await this.listSnapshots();
    const nextIndex = [
      {
        id,
        name: snapshot.name,
        createdAt: snapshot.createdAt,
        workspacePath: snapshot.workspacePath,
        recentCount: snapshot.recentProjects.length
      },
      ...index
    ].slice(0, MAX_SNAPSHOT_INDEX_ENTRIES);
    await this.writeJson(this.getSnapshotIndexPath(), nextIndex);

    return {
      id,
      name: snapshot.name,
      createdAt,
      workspacePath: snapshot.workspacePath,
      recentCount: snapshot.recentProjects.length
    };
  }

  async loadSnapshot(snapshotId) {
    const normalizedSnapshotId = normalizeSnapshotId(snapshotId);
    if (!normalizedSnapshotId) {
      throw new Error('Snapshot id is required.');
    }

    const snapshotsDir = this.getSnapshotsDir();
    const snapshotPath = path.resolve(path.join(snapshotsDir, `${normalizedSnapshotId}.json`));
    if (!isPathWithinBase(snapshotsDir, snapshotPath)) {
      throw new Error('Invalid snapshot id.');
    }

    const snapshot = await this.readJsonSafe(snapshotPath, null);
    if (!isPlainObject(snapshot)) {
      throw new Error('Snapshot not found.');
    }

    return {
      id: normalizedSnapshotId,
      name: normalizeSnapshotName(snapshot.name, 'Workspace Snapshot'),
      createdAt: typeof snapshot.createdAt === 'string' ? snapshot.createdAt : '',
      workspacePath: typeof snapshot.workspacePath === 'string' ? snapshot.workspacePath : '',
      settings: isPlainObject(snapshot.settings) ? snapshot.settings : {},
      recentProjects: sanitizeRecentProjects(snapshot.recentProjects)
    };
  }

  async saveTaskProfiles(projectPath, profiles) {
    if (typeof projectPath !== 'string' || !projectPath.trim()) {
      throw new Error('Project path is required.');
    }

    const normalizedProjectPath = path.resolve(projectPath);
    const normalizedProfiles = sanitizeTaskProfiles(profiles);
    const data = sanitizeTaskProfilesDocument(await this.readJsonSafe(this.getTaskProfilesPath(), {}));
    data[normalizedProjectPath] = normalizedProfiles;
    await this.writeJson(this.getTaskProfilesPath(), data);

    return normalizedProfiles;
  }

  async getTaskProfiles(projectPath) {
    if (typeof projectPath !== 'string' || !projectPath.trim()) {
      return [];
    }

    const normalizedProjectPath = path.resolve(projectPath);
    const data = sanitizeTaskProfilesDocument(await this.readJsonSafe(this.getTaskProfilesPath(), {}));
    return sanitizeTaskProfiles(data[normalizedProjectPath]);
  }

  async discoverProjects(workspacePath) {
    if (typeof workspacePath !== 'string' || !workspacePath.trim()) {
      return [];
    }

    const root = path.resolve(workspacePath);
    let entries = [];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }

    const directories = entries
      .filter((entry) => {
        if (!entry.isDirectory()) {
          return false;
        }
        const normalizedName = String(entry.name || '').toLowerCase();
        if (!normalizedName) {
          return false;
        }
        if (normalizedName.startsWith('.')) {
          return false;
        }
        return !SEARCH_DISCOVERY_EXCLUDED_DIRECTORIES.has(normalizedName);
      })
      .sort((left, right) => String(left.name || '').localeCompare(String(right.name || ''), undefined, {
        sensitivity: 'base',
        numeric: true
      }))
      .map((entry) => path.join(root, entry.name));

    return directories.slice(0, MAX_DISCOVERED_PROJECTS);
  }

  async collectProjectFiles(projectPath, limit = 120) {
    const normalizedLimit = Math.max(1, Math.min(MAX_PROJECT_FILE_SCAN_LIMIT, Number(limit) || 120));
    const files = [];
    const queue = [projectPath];
    let queueIndex = 0;

    while (queueIndex < queue.length && files.length < normalizedLimit) {
      const current = queue[queueIndex];
      queueIndex += 1;
      let entries = [];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((left, right) => String(left.name || '').localeCompare(String(right.name || ''), undefined, {
        sensitivity: 'base',
        numeric: true
      }));

      for (const entry of entries) {
        if (files.length >= normalizedLimit) break;
        const entryName = String(entry.name || '').trim();
        if (!entryName) {
          continue;
        }

        const normalizedName = entryName.toLowerCase();
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.isSymbolicLink && entry.isSymbolicLink()) {
            continue;
          }
          if (normalizedName.startsWith('.') || SEARCH_DISCOVERY_EXCLUDED_DIRECTORIES.has(normalizedName)) {
            continue;
          }
          queue.push(fullPath);
          continue;
        }

        if (entry.isFile()) {
          files.push(fullPath);
        }
      }
    }

    return files;
  }

  async collectGitCommits(projectPath, limit = 20) {
    const normalizedLimit = Math.max(1, Math.min(MAX_GIT_COMMIT_SCAN_LIMIT, Number(limit) || 20));
    return new Promise((resolve) => {
      execFile(
        'git',
        ['log', `-n${normalizedLimit}`, '--pretty=format:%h|%s'],
        { cwd: projectPath, timeout: 5000, windowsHide: true },
        (error, stdout) => {
          if (error || !stdout) {
            resolve([]);
            return;
          }

          const commits = stdout
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
              const [hash, ...messageParts] = line.split('|');
              return {
                hash: (hash || '').trim(),
                message: messageParts.join('|').trim()
              };
            })
            .filter((item) => item.hash && item.message);

          resolve(commits);
        }
      );
    });
  }

  async buildSearchIndex({ workspacePath }) {
    const root = typeof workspacePath === 'string' && workspacePath.trim()
      ? path.resolve(workspacePath.trim())
      : '';
    const projectPaths = await this.discoverProjects(root);
    const entries = [];
    const addEntry = (entry) => {
      if (!isPlainObject(entry) || entries.length >= MAX_SEARCH_INDEX_ENTRIES) {
        return false;
      }

      const text = sanitizeString(entry.text, SEARCH_ENTRY_TEXT_MAX_LENGTH).toLowerCase();
      if (!text) {
        return true;
      }

      entries.push({
        type: sanitizeString(entry.type, 24) || 'project',
        projectPath: typeof entry.projectPath === 'string' ? entry.projectPath : '',
        label: sanitizeString(entry.label, 240),
        filePath: typeof entry.filePath === 'string' ? entry.filePath : '',
        hash: sanitizeString(entry.hash, 40),
        text
      });
      return entries.length < MAX_SEARCH_INDEX_ENTRIES;
    };

    for (const projectPath of projectPaths) {
      const projectName = path.basename(projectPath);
      const shouldContinue = addEntry({
        type: 'project',
        projectPath,
        label: projectName,
        text: `${projectName} ${projectPath}`.toLowerCase()
      });
      if (!shouldContinue) {
        break;
      }

      const files = await this.collectProjectFiles(projectPath, 80);
      for (const filePath of files) {
        const fileName = path.basename(filePath);
        const keepAdding = addEntry({
          type: 'file',
          projectPath,
          label: fileName,
          filePath,
          text: `${fileName} ${filePath} ${projectName}`.toLowerCase()
        });
        if (!keepAdding) {
          break;
        }
      }
      if (entries.length >= MAX_SEARCH_INDEX_ENTRIES) {
        break;
      }

      const commits = await this.collectGitCommits(projectPath, 20);
      for (const commit of commits) {
        const keepAdding = addEntry({
          type: 'commit',
          projectPath,
          label: `${commit.hash} ${commit.message}`,
          hash: commit.hash,
          text: `${commit.hash} ${commit.message} ${projectName}`.toLowerCase()
        });
        if (!keepAdding) {
          break;
        }
      }
      if (entries.length >= MAX_SEARCH_INDEX_ENTRIES) {
        break;
      }
    }

    this.searchIndex = this.sanitizeSearchIndex({
      builtAt: new Date().toISOString(),
      workspacePath: root,
      entries
    });
    this.rebuildSearchLookup();
    await this.persistSearchIndex();

    return {
      success: true,
      builtAt: this.searchIndex.builtAt,
      workspacePath: root,
      totalEntries: this.searchIndex.entries.length,
      projectCount: projectPaths.length
    };
  }

  querySearchIndex(query, limit = 60) {
    const normalizedQuery = typeof query === 'string' ? query.trim().toLowerCase() : '';
    const normalizedLimit = Math.max(1, Math.min(300, Number(limit) || 60));
    if (!normalizedQuery) {
      return {
        success: true,
        builtAt: this.searchIndex.builtAt,
        total: 0,
        results: []
      };
    }

    const cacheKey = `${normalizedQuery}|${normalizedLimit}`;
    const cached = this.searchQueryCache.get(cacheKey);
    if (cached) {
      return cloneSearchQueryResult(cached);
    }

    const entries = asArray(this.searchIndex.entries);
    const queryTokens = tokenizeSearchText(normalizedQuery).slice(0, MAX_SEARCH_QUERY_TOKEN_COUNT);
    let candidateEntries = entries;

    if (queryTokens.length > 0) {
      const buckets = [];
      for (const token of queryTokens) {
        const bucket = this.searchLookup.get(token);
        if (!bucket || bucket.length === 0) {
          buckets.length = 0;
          break;
        }
        buckets.push(bucket);
      }

      if (buckets.length === queryTokens.length) {
        buckets.sort((left, right) => left.length - right.length);
        let intersectedIndexes = [...buckets[0]];

        for (let index = 1; index < buckets.length && intersectedIndexes.length > 0; index += 1) {
          const bucketSet = new Set(buckets[index]);
          intersectedIndexes = intersectedIndexes.filter((entryIndex) => bucketSet.has(entryIndex));
        }

        candidateEntries = intersectedIndexes.map((index) => entries[index]).filter(Boolean);
      } else {
        candidateEntries = [];
      }
    }

    if (candidateEntries.length === 0 && queryTokens.length > 0) {
      candidateEntries = entries;
    }

    const matches = [];
    let hasMore = false;
    for (const entry of candidateEntries) {
      if (!entry || typeof entry.text !== 'string') {
        continue;
      }

      if (!entry.text.includes(normalizedQuery)) {
        continue;
      }

      matches.push({
        type: entry.type,
        label: entry.label,
        projectPath: entry.projectPath,
        filePath: entry.filePath || '',
        hash: entry.hash || ''
      });

      if (matches.length >= normalizedLimit) {
        hasMore = true;
        break;
      }
    }

    const result = {
      success: true,
      builtAt: this.searchIndex.builtAt,
      total: matches.length,
      hasMore,
      results: matches
    };

    this.cacheSearchQueryResult(cacheKey, result);
    return cloneSearchQueryResult(result);
  }
}

module.exports = {
  WorkspaceServices
};
