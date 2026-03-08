const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { ProjectDiscoveryService } = require('../main/project-discovery-service');

test('project discovery finds expected project types and supports query filtering', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'appmanager-discovery-'));
  const workspace = path.join(root, 'workspace');
  const nodeProject = path.join(workspace, 'node-app');
  const pythonProject = path.join(workspace, 'python-app');
  const javaProject = path.join(workspace, 'java-app');

  await fs.mkdir(nodeProject, { recursive: true });
  await fs.mkdir(pythonProject, { recursive: true });
  await fs.mkdir(javaProject, { recursive: true });

  await fs.writeFile(path.join(nodeProject, 'package.json'), JSON.stringify({
    name: 'node-app',
    description: 'Node test project'
  }), 'utf8');
  await fs.writeFile(path.join(pythonProject, 'requirements.txt'), 'flask==3.0.0', 'utf8');
  await fs.writeFile(path.join(javaProject, 'pom.xml'), '<project></project>', 'utf8');

  const service = new ProjectDiscoveryService();
  const allProjects = await service.searchProjects(workspace, '');

  assert.equal(allProjects.length >= 3, true);
  const discoveredNodeProject = allProjects.find((project) => project.path === nodeProject);
  assert.ok(discoveredNodeProject);
  assert.equal(discoveredNodeProject.type, 'nodejs');
  assert.equal(discoveredNodeProject.hasPackageJson, true);
  assert.equal(discoveredNodeProject.description, 'Node test project');
  assert.equal(allProjects.some((project) => project.path === pythonProject && project.type === 'python'), true);
  assert.equal(allProjects.some((project) => project.path === javaProject && project.type === 'java'), true);

  const filtered = await service.searchProjects(workspace, 'python');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].path, pythonProject);

  const descriptionFiltered = await service.searchProjects(workspace, 'node test project');
  assert.equal(descriptionFiltered.some((project) => project.path === nodeProject), true);
});

test('project discovery cache can be invalidated when workspace changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'appmanager-discovery-cache-'));
  const workspace = path.join(root, 'workspace');
  const firstProject = path.join(workspace, 'first-project');
  const secondProject = path.join(workspace, 'second-project');

  await fs.mkdir(firstProject, { recursive: true });
  await fs.writeFile(path.join(firstProject, 'package.json'), JSON.stringify({ name: 'first-project' }), 'utf8');

  const service = new ProjectDiscoveryService({ cacheTtlMs: 60000 });
  const initial = await service.searchProjects(workspace, '');
  assert.equal(initial.some((project) => project.path === firstProject), true);
  assert.equal(initial.some((project) => project.path === secondProject), false);

  await fs.mkdir(secondProject, { recursive: true });
  await fs.writeFile(path.join(secondProject, 'requirements.txt'), 'requests==2.0.0', 'utf8');

  const cached = await service.searchProjects(workspace, '');
  assert.equal(cached.some((project) => project.path === secondProject), false);
  cached.push({ path: 'mutated-entry' });
  const cachedAgain = await service.searchProjects(workspace, '');
  assert.equal(cachedAgain.some((project) => project.path === 'mutated-entry'), false);

  service.invalidate(workspace);
  const refreshed = await service.searchProjects(workspace, '');
  assert.equal(refreshed.some((project) => project.path === secondProject), true);
});

test('project discovery shares a single in-flight scan for concurrent requests', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'appmanager-discovery-inflight-'));
  const workspace = path.join(root, 'workspace');
  const projectA = path.join(workspace, 'project-a');

  await fs.mkdir(projectA, { recursive: true });
  await fs.writeFile(path.join(projectA, 'requirements.txt'), 'flask==3.0.0', 'utf8');

  const service = new ProjectDiscoveryService({ cacheTtlMs: 1000 });
  const originalScanWorkspaceProjects = service.scanWorkspaceProjects.bind(service);
  let scanCount = 0;

  service.scanWorkspaceProjects = async (...args) => {
    scanCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return originalScanWorkspaceProjects(...args);
  };

  const [firstResult, secondResult, thirdResult] = await Promise.all([
    service.getProjects(workspace, { force: true }),
    service.getProjects(workspace, { force: true }),
    service.getProjects(workspace, { force: true })
  ]);

  assert.equal(scanCount, 1);
  assert.equal(firstResult.length >= 1, true);
  assert.equal(secondResult.length, firstResult.length);
  assert.equal(thirdResult.length, firstResult.length);

  if (firstResult.length > 0) {
    const originalName = secondResult[0].name;
    firstResult[0].name = 'mutated-name';
    assert.equal(secondResult[0].name, originalName);
  }
});
