const path = require('path');
const fs = require('fs').promises;

const DEFAULT_CACHE_TTL_MS = 5000;
const MAX_SCAN_DEPTH = 3;
const MAX_PROJECTS_PER_SCAN = 4000;
const MAX_WORKSPACE_CACHE_ENTRIES = 24;
const MAX_PACKAGE_JSON_SIZE_BYTES = 1024 * 1024;
const MAX_PROJECT_DESCRIPTION_LENGTH = 280;
const SKIPPED_DIRECTORIES = new Set([
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

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cloneProjects(projects) {
  return asArray(projects)
    .filter((project) => project && typeof project === 'object')
    .map((project) => ({
      ...project,
      lastModified: project?.lastModified instanceof Date
        ? project.lastModified.toISOString()
        : (typeof project?.lastModified === 'string' ? project.lastModified : null)
    }));
}

function normalizeRootPath(rootPath) {
  if (typeof rootPath !== 'string' || !rootPath.trim()) {
    return '';
  }
  return path.resolve(rootPath.trim());
}

function classifyProjectType(entryNames) {
  const hasPackageJson = entryNames.has('package.json');
  if (hasPackageJson) return 'nodejs';
  if (entryNames.has('requirements.txt') || entryNames.has('pyproject.toml')) return 'python';
  if (entryNames.has('pom.xml')) return 'java';
  if (entryNames.has('cmakelists.txt')) return 'cpp';
  if (entryNames.has('index.html')) return 'web';
  return 'unknown';
}

class ProjectDiscoveryService {
  constructor({ logger, cacheTtlMs = DEFAULT_CACHE_TTL_MS } = {}) {
    this.logger = logger;
    this.cacheTtlMs = Math.max(1000, Number(cacheTtlMs) || DEFAULT_CACHE_TTL_MS);
    this.workspaceCache = new Map();
    this.scanRequestsInFlight = new Map();
  }

  invalidate(rootPath = '') {
    const normalizedRoot = normalizeRootPath(rootPath);
    if (!normalizedRoot) {
      this.workspaceCache.clear();
      this.scanRequestsInFlight.clear();
      return;
    }
    const cacheKey = normalizedRoot.toLowerCase();
    this.workspaceCache.delete(cacheKey);
    this.scanRequestsInFlight.delete(cacheKey);
  }

  getCachedWorkspaceProjects(rootPath) {
    const normalizedRoot = normalizeRootPath(rootPath);
    if (!normalizedRoot) {
      return null;
    }

    const cacheKey = normalizedRoot.toLowerCase();
    const cached = this.workspaceCache.get(cacheKey);
    if (!cached) {
      return null;
    }

    if (Date.now() - cached.updatedAt > this.cacheTtlMs) {
      this.workspaceCache.delete(cacheKey);
      return null;
    }

    return cloneProjects(cached.projects);
  }

  setCachedWorkspaceProjects(rootPath, projects) {
    const normalizedRoot = normalizeRootPath(rootPath);
    if (!normalizedRoot) {
      return;
    }

    const cacheKey = normalizedRoot.toLowerCase();
    this.workspaceCache.set(cacheKey, {
      updatedAt: Date.now(),
      projects: cloneProjects(projects)
    });

    while (this.workspaceCache.size > MAX_WORKSPACE_CACHE_ENTRIES) {
      const oldestKey = this.workspaceCache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.workspaceCache.delete(oldestKey);
    }
  }

  async readDirectoryEntriesSafe(directoryPath) {
    try {
      const entries = await fs.readdir(directoryPath, { withFileTypes: true });
      entries.sort((left, right) => String(left.name || '').localeCompare(String(right.name || ''), undefined, {
        sensitivity: 'base',
        numeric: true
      }));
      return entries;
    } catch {
      return [];
    }
  }

  async detectPackageMetadata(projectPath) {
    const packagePath = path.join(projectPath, 'package.json');
    const metadata = {
      type: 'nodejs',
      hasPackageJson: true,
      description: ''
    };

    try {
      const stats = await fs.stat(packagePath);
      if (!stats.isFile() || stats.size > MAX_PACKAGE_JSON_SIZE_BYTES) {
        return metadata;
      }

      const raw = await fs.readFile(packagePath, 'utf8');
      const packageJson = JSON.parse(raw);
      metadata.description = typeof packageJson?.description === 'string'
        ? packageJson.description.trim().slice(0, MAX_PROJECT_DESCRIPTION_LENGTH)
        : '';
      const dependencies = {
        ...(packageJson?.dependencies || {}),
        ...(packageJson?.devDependencies || {})
      };
      if (dependencies.electron) metadata.type = 'electron';
      else if (dependencies.react) metadata.type = 'react';
      else if (dependencies.vue) metadata.type = 'vue';
      else if (dependencies.next) metadata.type = 'nextjs';
      else if (dependencies['@angular/core']) metadata.type = 'angular';
      else if (dependencies.svelte) metadata.type = 'svelte';
    } catch {
      metadata.type = 'nodejs';
    }

    return metadata;
  }

  async scanWorkspaceProjects(rootPath) {
    const normalizedRoot = normalizeRootPath(rootPath);
    if (!normalizedRoot) {
      return [];
    }

    const queue = [{ dir: normalizedRoot, depth: 0, entries: null }];
    let queueIndex = 0;
    const projects = [];
    const seenProjectPaths = new Set();

    while (queueIndex < queue.length && projects.length < MAX_PROJECTS_PER_SCAN) {
      const current = queue[queueIndex];
      queueIndex += 1;
      if (!current) {
        continue;
      }

      if (current.depth > MAX_SCAN_DEPTH) {
        continue;
      }

      const entries = Array.isArray(current.entries)
        ? current.entries
        : await this.readDirectoryEntriesSafe(current.dir);
      if (!entries.length) {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const entryName = String(entry.name || '').trim();
        if (!entryName) {
          continue;
        }

        const normalizedEntryName = entryName.toLowerCase();
        if (SKIPPED_DIRECTORIES.has(normalizedEntryName) || normalizedEntryName.startsWith('.')) {
          continue;
        }

        const childPath = path.join(current.dir, entryName);
        const childEntries = await this.readDirectoryEntriesSafe(childPath);
        const childNameSet = new Set(
          childEntries
            .map((childEntry) => String(childEntry.name || '').toLowerCase())
            .filter(Boolean)
        );

        if (childNameSet.size > 0) {
          let projectType = classifyProjectType(childNameSet);
          let packageMetadata = {
            type: projectType,
            hasPackageJson: false,
            description: ''
          };
          if (projectType === 'nodejs') {
            packageMetadata = await this.detectPackageMetadata(childPath);
            projectType = packageMetadata.type;
          }

          if (projectType !== 'unknown') {
            const key = childPath.toLowerCase();
            if (!seenProjectPaths.has(key)) {
              seenProjectPaths.add(key);
              let lastModified = null;
              try {
                const stats = await fs.stat(childPath);
                lastModified = stats?.mtime || null;
              } catch {
                lastModified = null;
              }
              projects.push({
                name: entryName,
                path: childPath,
                type: projectType,
                isGitRepo: childNameSet.has('.git'),
                hasPackageJson: packageMetadata.hasPackageJson,
                description: packageMetadata.description,
                lastModified: lastModified instanceof Date ? lastModified.toISOString() : null
              });
            }
          }
        }

        if (current.depth < MAX_SCAN_DEPTH) {
          queue.push({ dir: childPath, depth: current.depth + 1, entries: childEntries });
        }
      }
    }

    projects.sort((left, right) => {
      const leftTime = left?.lastModified ? new Date(left.lastModified).getTime() : 0;
      const rightTime = right?.lastModified ? new Date(right.lastModified).getTime() : 0;
      if (leftTime !== rightTime) {
        return rightTime - leftTime;
      }
      return String(left?.name || '').localeCompare(String(right?.name || ''), undefined, {
        sensitivity: 'base',
        numeric: true
      });
    });

    return projects;
  }

  async getProjects(rootPath, { force = false } = {}) {
    const normalizedRoot = normalizeRootPath(rootPath);
    if (!normalizedRoot) {
      return [];
    }

    if (!force) {
      const cached = this.getCachedWorkspaceProjects(normalizedRoot);
      if (cached) {
        return cached;
      }
    }

    const cacheKey = normalizedRoot.toLowerCase();
    const inFlight = this.scanRequestsInFlight.get(cacheKey);
    if (inFlight) {
      return inFlight.then((projects) => cloneProjects(projects));
    }

    const request = this.scanWorkspaceProjects(normalizedRoot)
      .then((projects) => {
        this.setCachedWorkspaceProjects(normalizedRoot, projects);
        return cloneProjects(projects);
      })
      .finally(() => {
        this.scanRequestsInFlight.delete(cacheKey);
      });

    this.scanRequestsInFlight.set(cacheKey, request);
    return request;
  }

  async searchProjects(rootPath, query = '', options = {}) {
    const projects = await this.getProjects(rootPath, options);
    const normalizedQuery = typeof query === 'string' ? query.trim().toLowerCase() : '';

    if (!normalizedQuery) {
      return projects;
    }

    return projects.filter((project) => {
      const name = String(project?.name || '').toLowerCase();
      const projectPath = String(project?.path || '').toLowerCase();
      const projectType = String(project?.type || '').toLowerCase();
      const description = String(project?.description || '').toLowerCase();
      return name.includes(normalizedQuery)
        || projectPath.includes(normalizedQuery)
        || projectType.includes(normalizedQuery)
        || description.includes(normalizedQuery);
    });
  }
}

module.exports = {
  ProjectDiscoveryService
};
