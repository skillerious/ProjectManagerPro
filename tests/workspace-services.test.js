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
