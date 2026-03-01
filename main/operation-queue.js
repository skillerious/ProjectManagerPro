const { EventEmitter } = require('events');
const crypto = require('crypto');

class OperationQueue extends EventEmitter {
  constructor({ logger } = {}) {
    super();
    this.logger = logger;
    this.jobs = [];
    this.running = false;
    this.runners = new Map();
  }

  registerRunner(type, runner) {
    if (typeof type !== 'string' || !type.trim()) {
      throw new Error('Runner type is required.');
    }
    if (typeof runner !== 'function') {
      throw new Error('Runner must be a function.');
    }
    this.runners.set(type.trim(), runner);
  }

  getSnapshot() {
    return this.jobs.map((job) => ({
      id: job.id,
      type: job.type,
      status: job.status,
      payload: job.payload,
      attempts: job.attempts,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      result: job.result,
      error: job.error
    }));
  }

  emitUpdate() {
    this.emit('updated', this.getSnapshot());
  }

  enqueue(type, payload = {}) {
    const normalizedType = typeof type === 'string' ? type.trim() : '';
    if (!this.runners.has(normalizedType)) {
      throw new Error(`Unsupported queue operation: ${normalizedType}`);
    }

    const now = new Date().toISOString();
    const job = {
      id: crypto.randomUUID(),
      type: normalizedType,
      payload: payload && typeof payload === 'object' ? payload : {},
      status: 'queued',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      result: null,
      error: '',
      cancelled: false
    };

    this.jobs.unshift(job);
    this.emitUpdate();
    this.processNext();
    return job;
  }

  findJob(jobId) {
    return this.jobs.find((job) => job.id === jobId) || null;
  }

  cancel(jobId) {
    const job = this.findJob(jobId);
    if (!job) {
      return { success: false, error: 'Job not found' };
    }

    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.cancelled = true;
      job.updatedAt = new Date().toISOString();
      this.emitUpdate();
      return { success: true, job };
    }

    if (job.status === 'running') {
      job.cancelled = true;
      job.updatedAt = new Date().toISOString();
      this.emitUpdate();
      return { success: true, job };
    }

    return { success: false, error: `Cannot cancel job in status: ${job.status}` };
  }

  retry(jobId) {
    const job = this.findJob(jobId);
    if (!job) {
      return { success: false, error: 'Job not found' };
    }

    if (!['failed', 'cancelled'].includes(job.status)) {
      return { success: false, error: 'Only failed/cancelled jobs can be retried' };
    }

    job.status = 'queued';
    job.cancelled = false;
    job.error = '';
    job.result = null;
    job.updatedAt = new Date().toISOString();
    this.emitUpdate();
    this.processNext();
    return { success: true, job };
  }

  async processNext() {
    if (this.running) {
      return;
    }

    const nextJob = this.jobs.find((job) => job.status === 'queued');
    if (!nextJob) {
      return;
    }

    this.running = true;
    nextJob.status = 'running';
    nextJob.attempts += 1;
    nextJob.updatedAt = new Date().toISOString();
    this.emitUpdate();

    const runner = this.runners.get(nextJob.type);
    try {
      const result = await runner(nextJob.payload, {
        isCancelled: () => Boolean(nextJob.cancelled)
      });

      if (nextJob.cancelled || (result && typeof result === 'object' && result.cancelled)) {
        nextJob.status = 'cancelled';
        nextJob.result = result || null;
        nextJob.error = result?.error || '';
      } else if (result && typeof result === 'object' && result.success === false) {
        nextJob.status = 'failed';
        nextJob.result = result;
        nextJob.error = result.error || 'Operation failed';
      } else {
        nextJob.status = 'completed';
        nextJob.result = result || null;
        nextJob.error = '';
      }
    } catch (error) {
      nextJob.status = nextJob.cancelled ? 'cancelled' : 'failed';
      nextJob.error = error?.message || 'Operation failed';
      this.logger?.warn('Queue operation failed', {
        jobId: nextJob.id,
        type: nextJob.type,
        error: nextJob.error
      });
    } finally {
      nextJob.updatedAt = new Date().toISOString();
      this.running = false;
      this.emitUpdate();
      setImmediate(() => this.processNext());
    }
  }
}

module.exports = {
  OperationQueue
};
