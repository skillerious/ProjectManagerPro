const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { WorkspaceServices } = require('../main/workspace-services');

const gitAvailable = (() => {
  const probe = spawnSync('git', ['--version'], { windowsHide: true });
  return probe.status === 0;
})();

test('workspace services snapshot and task-profile roundtrip', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'appmanager-ws-test-'));
  const userData = path.join(root, 'userdata');
  const workspace = path.join(root, 'workspace');
  const projectPath = path.join(workspace, 'sample-project');
  await fs.mkdir(projectPath, { recursive: true });

  const services = new WorkspaceServices({
    app: { getPath: () => userData },
    logger: null
  });

  const snapshot = await services.createSnapshot({
    name: 'Checkpoint A',
    workspacePath: workspace,
    settings: { theme: 'dark' },
    recentProjects: [{ name: 'sample-project', path: projectPath }]
  });
  assert.equal(typeof snapshot.id, 'string');
  assert.equal(snapshot.name, 'Checkpoint A');

  const loaded = await services.loadSnapshot(snapshot.id);
  assert.equal(loaded.workspacePath, workspace);
  assert.equal(Array.isArray(loaded.recentProjects), true);
  assert.equal(loaded.recentProjects.length, 1);

  const savedProfiles = await services.saveTaskProfiles(projectPath, [
    { id: 'build', name: 'Build', command: 'npm run build', cwd: '.', runOn: 'manual' }
  ]);
  assert.equal(savedProfiles.length, 1);
  assert.equal(savedProfiles[0].name, 'Build');

  const reloadedProfiles = await services.getTaskProfiles(projectPath);
  assert.equal(reloadedProfiles.length, 1);
  assert.equal(reloadedProfiles[0].command, 'npm run build');
});

test('workspace services builds indexed search with git commits', { skip: !gitAvailable }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'appmanager-index-test-'));
  const userData = path.join(root, 'userdata');
  const workspace = path.join(root, 'workspace');
  const projectPath = path.join(workspace, 'indexed-project');
  await fs.mkdir(projectPath, { recursive: true });

  const filePath = path.join(projectPath, 'README.md');
  await fs.writeFile(filePath, '# Indexed Project\n', 'utf8');

  const runGit = (args) => {
    const result = spawnSync('git', args, {
      cwd: projectPath,
      windowsHide: true,
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  };

  runGit(['init']);
  runGit(['config', 'user.name', 'AppManager Tests']);
  runGit(['config', 'user.email', 'tests@appmanager.local']);
  runGit(['add', 'README.md']);
  runGit(['commit', '-m', 'initial index commit']);

  const services = new WorkspaceServices({
    app: { getPath: () => userData },
    logger: null
  });

  const buildResult = await services.buildSearchIndex({ workspacePath: workspace });
  assert.equal(buildResult.success, true);
  assert.equal(buildResult.projectCount, 1);
  assert.equal(buildResult.totalEntries > 0, true);

  const commitQuery = services.querySearchIndex('initial index commit', 20);
  assert.equal(commitQuery.success, true);
  assert.equal(commitQuery.results.some((entry) => entry.type === 'commit'), true);

  const fileQuery = services.querySearchIndex('readme', 20);
  assert.equal(fileQuery.results.some((entry) => entry.type === 'file'), true);
});

test('workspace search index persists across service instances', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'appmanager-search-persist-'));
  const userData = path.join(root, 'userdata');
  const workspace = path.join(root, 'workspace');
  const projectPath = path.join(workspace, 'persisted-project');
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(projectPath, 'notes.txt'), 'persist me', 'utf8');

  const firstInstance = new WorkspaceServices({
    app: { getPath: () => userData },
    logger: null
  });

  const buildResult = await firstInstance.buildSearchIndex({ workspacePath: workspace });
  assert.equal(buildResult.success, true);
  assert.equal(buildResult.totalEntries > 0, true);

  const secondInstance = new WorkspaceServices({
    app: { getPath: () => userData },
    logger: null
  });

  const queryResult = secondInstance.querySearchIndex('notes', 20);
  assert.equal(queryResult.success, true);
  assert.equal(queryResult.results.some((entry) => entry.type === 'file'), true);
});

test('workspace services validates snapshot ids and sanitizes task profiles', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'appmanager-ws-sanitize-'));
  const userData = path.join(root, 'userdata');
  const workspace = path.join(root, 'workspace');
  const projectPath = path.join(workspace, 'safe-project');
  await fs.mkdir(projectPath, { recursive: true });

  const services = new WorkspaceServices({
    app: { getPath: () => userData },
    logger: null
  });

  await assert.rejects(
    async () => services.loadSnapshot('../escape'),
    /Snapshot id is required|Invalid snapshot id/
  );

  const savedProfiles = await services.saveTaskProfiles(projectPath, [
    { id: 'dup', name: 'Build', command: 'npm run build', cwd: '../outside', runOn: 'startup' },
    { id: 'dup', name: 'Start', command: 'npm start', cwd: path.resolve(projectPath), runOn: 'manual' }
  ]);

  assert.equal(savedProfiles.length, 2);
  assert.equal(savedProfiles[0].runOn, 'manual');
  assert.equal(savedProfiles[0].cwd, '');
  assert.equal(savedProfiles[1].cwd, '');
  assert.notEqual(savedProfiles[0].id, savedProfiles[1].id);
});

test('workspace search query cache returns immutable payloads with hasMore flag', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'appmanager-ws-query-cache-'));
  const userData = path.join(root, 'userdata');
  const workspace = path.join(root, 'workspace');
  const projectPath = path.join(workspace, 'query-project');
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(projectPath, 'note-one.txt'), 'alpha', 'utf8');
  await fs.writeFile(path.join(projectPath, 'note-two.txt'), 'beta', 'utf8');

  const services = new WorkspaceServices({
    app: { getPath: () => userData },
    logger: null
  });

  const buildResult = await services.buildSearchIndex({ workspacePath: workspace });
  assert.equal(buildResult.success, true);

  const firstQuery = services.querySearchIndex('note', 1);
  assert.equal(firstQuery.success, true);
  assert.equal(firstQuery.results.length, 1);
  assert.equal(firstQuery.hasMore, true);
  firstQuery.results[0].label = 'mutated-result';

  const secondQuery = services.querySearchIndex('note', 1);
  assert.equal(secondQuery.success, true);
  assert.equal(secondQuery.results.length, 1);
  assert.notEqual(secondQuery.results[0].label, 'mutated-result');
});
