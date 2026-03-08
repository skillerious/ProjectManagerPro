const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { OperationQueue } = require('../main/operation-queue');

async function waitForJobStatus(queue, jobId, expectedStatus, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = queue.findJob(jobId);
    if (job && job.status === expectedStatus) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for job ${jobId} to reach status ${expectedStatus}`);
}

async function waitForCondition(predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for condition');
}

test('operation queue marks explicit unsuccessful results as failed', async () => {
  const queue = new OperationQueue();
  queue.registerRunner('fails', async () => ({ success: false, error: 'planned failure' }));

  const job = queue.enqueue('fails', {});
  const failedJob = await waitForJobStatus(queue, job.id, 'failed');

  assert.equal(failedJob.error, 'planned failure');
  assert.equal(failedJob.attempts, 1);
});

test('operation queue supports retry after failed execution', async () => {
  const queue = new OperationQueue();
  let attempts = 0;
  queue.registerRunner('flaky', async () => {
    attempts += 1;
    if (attempts === 1) {
      return { success: false, error: 'first attempt failed' };
    }
    return { success: true, output: 'ok' };
  });

  const job = queue.enqueue('flaky', {});
  await waitForJobStatus(queue, job.id, 'failed');

  const retryResult = queue.retry(job.id);
  assert.equal(retryResult.success, true);

  const completedJob = await waitForJobStatus(queue, job.id, 'completed');
  assert.equal(completedJob.attempts, 2);
  assert.deepEqual(completedJob.result, { success: true, output: 'ok' });
});

test('operation queue persists and reloads job snapshots', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'appmanager-queue-test-'));
  const persistencePath = path.join(root, 'operation-queue.json');

  const queue = new OperationQueue({ persistencePath });
  queue.registerRunner('fails', async () => ({ success: false, error: 'planned failure' }));

  const job = queue.enqueue('fails', { attempt: 1 });
  await waitForJobStatus(queue, job.id, 'failed');

  await waitForCondition(async () => {
    try {
      const raw = await fs.readFile(persistencePath, 'utf8');
      return raw.includes(job.id);
    } catch {
      return false;
    }
  });

  const reloaded = new OperationQueue({ persistencePath });
  const restored = reloaded.findJob(job.id);

  assert.ok(restored);
  assert.equal(restored.status, 'failed');
  assert.equal(restored.error, 'planned failure');
  assert.deepEqual(restored.payload, { attempt: 1 });
});

test('operation queue snapshots do not leak mutable references', async () => {
  const queue = new OperationQueue();
  queue.registerRunner('noop', async () => ({ success: true }));

  const originalPayload = { nested: { count: 1 } };
  const job = queue.enqueue('noop', originalPayload);
  originalPayload.nested.count = 999;

  const liveJob = queue.findJob(job.id);
  assert.ok(liveJob);
  assert.equal(liveJob.payload.nested.count, 1);

  const snapshot = queue.getSnapshot();
  snapshot[0].payload.nested.count = 555;

  const afterMutation = queue.findJob(job.id);
  assert.ok(afterMutation);
  assert.equal(afterMutation.payload.nested.count, 1);
});

function createMockJob(id, status = 'queued') {
  const now = new Date().toISOString();
  return {
    id,
    type: 'noop',
    payload: {},
    status,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    result: null,
    error: '',
    cancelled: status === 'cancelled'
  };
}

test('operation queue rejects enqueue when full with non-terminal jobs', () => {
  const queue = new OperationQueue();
  queue.registerRunner('noop', async () => ({ success: true }));

  queue.jobs = Array.from({ length: 2000 }, (_, index) => createMockJob(`queued-${index}`, 'queued'));

  assert.throws(
    () => queue.enqueue('noop', {}),
    /queue is full/i
  );
});

test('operation queue prunes old terminal jobs before enqueueing new work', () => {
  const queue = new OperationQueue();
  queue.registerRunner('noop', async () => ({ success: true }));

  queue.jobs = Array.from({ length: 2000 }, (_, index) => createMockJob(`done-${index}`, 'completed'));

  const enqueued = queue.enqueue('noop', {});
  assert.equal(queue.jobs.length, 2000);
  assert.equal(queue.jobs.some((job) => job.id === 'done-1999'), false);
  assert.equal(queue.jobs[0].id, enqueued.id);
});
