const path = require('path');
const fs = require('fs').promises;
const { execFile } = require('child_process');
const crypto = require('crypto');

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

class WorkspaceServices {
  constructor({ app, logger }) {
    this.app = app;
    this.logger = logger;
    this.searchIndex = {
      builtAt: null,
      workspacePath: '',
      entries: []
    };
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

  async ensureSnapshotsDir() {
    await fs.mkdir(this.getSnapshotsDir(), { recursive: true });
  }

  async readJsonSafe(filePath, fallback) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  async writeJson(filePath, data) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  async listSnapshots() {
    await this.ensureSnapshotsDir();
    const index = await this.readJsonSafe(this.getSnapshotIndexPath(), []);
    return asArray(index)
      .filter((item) => item && typeof item.id === 'string')
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
      settings: settings && typeof settings === 'object' ? settings : {},
      recentProjects: asArray(recentProjects)
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
    ].slice(0, 100);
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
    if (typeof snapshotId !== 'string' || !snapshotId.trim()) {
      throw new Error('Snapshot id is required.');
    }
    const snapshotPath = path.join(this.getSnapshotsDir(), `${snapshotId.trim()}.json`);
    const snapshot = await this.readJsonSafe(snapshotPath, null);
    if (!snapshot || typeof snapshot !== 'object') {
      throw new Error('Snapshot not found.');
    }
    return snapshot;
  }

  async saveTaskProfiles(projectPath, profiles) {
    if (typeof projectPath !== 'string' || !projectPath.trim()) {
      throw new Error('Project path is required.');
    }

    const normalizedProjectPath = path.resolve(projectPath);
    const normalizedProfiles = asArray(profiles)
      .filter((profile) => profile && typeof profile === 'object')
      .map((profile) => ({
        id: typeof profile.id === 'string' && profile.id.trim()
          ? profile.id.trim().slice(0, 64)
          : crypto.randomUUID(),
        name: normalizeSnapshotName(profile.name, 'Task'),
        command: typeof profile.command === 'string' ? profile.command.trim().slice(0, 300) : '',
        cwd: typeof profile.cwd === 'string' ? profile.cwd.trim().slice(0, 500) : '',
        runOn: typeof profile.runOn === 'string' ? profile.runOn.trim().slice(0, 32) : 'manual'
      }))
      .filter((profile) => profile.command);

    const data = await this.readJsonSafe(this.getTaskProfilesPath(), {});
    data[normalizedProjectPath] = normalizedProfiles;
    await this.writeJson(this.getTaskProfilesPath(), data);

    return normalizedProfiles;
  }

  async getTaskProfiles(projectPath) {
    if (typeof projectPath !== 'string' || !projectPath.trim()) {
      return [];
    }

    const normalizedProjectPath = path.resolve(projectPath);
    const data = await this.readJsonSafe(this.getTaskProfilesPath(), {});
    return asArray(data[normalizedProjectPath]);
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
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));

    return directories.slice(0, 400);
  }

  async collectProjectFiles(projectPath, limit = 120) {
    const files = [];
    const queue = [projectPath];
    const excluded = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'coverage']);

    while (queue.length > 0 && files.length < limit) {
      const current = queue.shift();
      let entries = [];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (files.length >= limit) break;
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (!excluded.has(entry.name.toLowerCase())) {
            queue.push(fullPath);
          }
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
    return new Promise((resolve) => {
      execFile(
        'git',
        ['log', `-n${limit}`, '--pretty=format:%h|%s'],
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
    const root = typeof workspacePath === 'string' ? workspacePath : '';
    const projectPaths = await this.discoverProjects(root);
    const entries = [];

    for (const projectPath of projectPaths) {
      const projectName = path.basename(projectPath);
      entries.push({
        type: 'project',
        projectPath,
        label: projectName,
        text: `${projectName} ${projectPath}`.toLowerCase()
      });

      const files = await this.collectProjectFiles(projectPath, 80);
      files.forEach((filePath) => {
        const fileName = path.basename(filePath);
        entries.push({
          type: 'file',
          projectPath,
          label: fileName,
          filePath,
          text: `${fileName} ${filePath} ${projectName}`.toLowerCase()
        });
      });

      const commits = await this.collectGitCommits(projectPath, 20);
      commits.forEach((commit) => {
        entries.push({
          type: 'commit',
          projectPath,
          label: `${commit.hash} ${commit.message}`,
          hash: commit.hash,
          text: `${commit.hash} ${commit.message} ${projectName}`.toLowerCase()
        });
      });
    }

    this.searchIndex = {
      builtAt: new Date().toISOString(),
      workspacePath: root,
      entries
    };

    return {
      success: true,
      builtAt: this.searchIndex.builtAt,
      workspacePath: root,
      totalEntries: entries.length,
      projectCount: projectPaths.length
    };
  }

  querySearchIndex(query, limit = 60) {
    const normalizedQuery = typeof query === 'string' ? query.trim().toLowerCase() : '';
    if (!normalizedQuery) {
      return {
        success: true,
        builtAt: this.searchIndex.builtAt,
        total: 0,
        results: []
      };
    }

    const matches = this.searchIndex.entries
      .filter((entry) => entry.text.includes(normalizedQuery))
      .slice(0, Math.max(1, Math.min(300, Number(limit) || 60)))
      .map((entry) => ({
        type: entry.type,
        label: entry.label,
        projectPath: entry.projectPath,
        filePath: entry.filePath || '',
        hash: entry.hash || ''
      }));

    return {
      success: true,
      builtAt: this.searchIndex.builtAt,
      total: matches.length,
      results: matches
    };
  }
}

module.exports = {
  WorkspaceServices
};
