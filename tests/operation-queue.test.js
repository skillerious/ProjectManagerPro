const test = require('node:test');
const assert = require('node:assert/strict');

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
