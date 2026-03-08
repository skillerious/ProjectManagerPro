const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PERSISTED_QUEUE_VERSION = 1;
const MAX_PERSISTED_JOBS = 500;
const MAX_IN_MEMORY_JOBS = 2000;
const MAX_JOB_ATTEMPTS = 1000;
const MAX_JOB_ID_LENGTH = 128;
const VALID_STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneSerializable(value, fallbackValue = null) {
  if (value === undefined) {
    return fallbackValue;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallbackValue;
  }
}

function normalizeAttempts(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.min(MAX_JOB_ATTEMPTS, Math.trunc(numeric)));
}

function serializeJob(job) {
  if (!isPlainObject(job)) {
    return null;
  }

  return {
    id: typeof job.id === 'string' ? job.id : '',
    type: typeof job.type === 'string' ? job.type : '',
    status: typeof job.status === 'string' ? job.status : 'queued',
    payload: cloneSerializable(job.payload, {}),
    attempts: normalizeAttempts(job.attempts),
    createdAt: typeof job.createdAt === 'string' ? job.createdAt : '',
    updatedAt: typeof job.updatedAt === 'string' ? job.updatedAt : '',
    result: cloneSerializable(job.result, null),
    error: typeof job.error === 'string' ? job.error : '',
    cancelled: Boolean(job.cancelled)
  };
}

function normalizeJobId(jobId) {
  if (typeof jobId !== 'string') {
    return '';
  }
  const trimmed = jobId.trim();
  if (!trimmed || trimmed.length > MAX_JOB_ID_LENGTH || /[\0\r\n]/.test(trimmed)) {
    return '';
  }
  return trimmed;
}

function sanitizePersistedJobs(inputJobs) {
  if (!Array.isArray(inputJobs)) {
    return [];
  }

  const sanitized = [];
  for (const rawJob of inputJobs) {
    if (sanitized.length >= MAX_PERSISTED_JOBS) {
      break;
    }

    if (!rawJob || typeof rawJob !== 'object') {
      continue;
    }

    const rawStatus = typeof rawJob.status === 'string' ? rawJob.status : 'queued';
    const normalizedStatus = VALID_STATUSES.has(rawStatus) ? rawStatus : 'queued';
    const hydratedStatus = normalizedStatus === 'running' ? 'queued' : normalizedStatus;
    const now = new Date().toISOString();

    sanitized.push({
      id: typeof rawJob.id === 'string' && rawJob.id.trim() ? rawJob.id.trim() : crypto.randomUUID(),
      type: typeof rawJob.type === 'string' ? rawJob.type.trim() : '',
      payload: isPlainObject(rawJob.payload)
        ? cloneSerializable(rawJob.payload, {})
        : {},
      status: hydratedStatus,
      attempts: normalizeAttempts(rawJob.attempts),
      createdAt: typeof rawJob.createdAt === 'string' && rawJob.createdAt ? rawJob.createdAt : now,
      updatedAt: typeof rawJob.updatedAt === 'string' && rawJob.updatedAt ? rawJob.updatedAt : now,
      result: cloneSerializable(rawJob.result, null),
      error: typeof rawJob.error === 'string' ? rawJob.error : '',
      cancelled: hydratedStatus === 'cancelled' || Boolean(rawJob.cancelled)
    });
  }

  return sanitized;
}

class OperationQueue extends EventEmitter {
  constructor({ logger, persistencePath = '' } = {}) {
    super();
    this.logger = logger;
    this.jobs = [];
    this.running = false;
    this.runners = new Map();
    this.persistencePath = '';
    this.persistenceWriteInFlight = false;
    this.persistenceWriteQueued = false;

    if (typeof persistencePath === 'string' && persistencePath.trim()) {
      this.setPersistencePath(persistencePath);
    }
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

  setPersistencePath(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      this.persistencePath = '';
      return;
    }

    this.persistencePath = path.resolve(filePath.trim());
    this.loadPersistedQueue();
    this.pruneJobsIfNeeded();
    this.emitUpdate();
  }

  getSnapshot() {
    return this.jobs
      .map((job) => serializeJob(job))
      .filter(Boolean);
  }

  emitUpdate() {
    this.emit('updated', this.getSnapshot());
    this.persistQueueSnapshot();
  }

  pruneJobsIfNeeded(targetSize = MAX_IN_MEMORY_JOBS, { allowHardTrim = true } = {}) {
    const normalizedTarget = Math.max(0, Number(targetSize) || 0);
    if (this.jobs.length <= normalizedTarget) {
      return;
    }

    while (this.jobs.length > normalizedTarget) {
      let terminalIndex = -1;
      for (let index = this.jobs.length - 1; index >= 0; index -= 1) {
        if (TERMINAL_STATUSES.has(this.jobs[index]?.status)) {
          terminalIndex = index;
          break;
        }
      }

      if (terminalIndex < 0) {
        break;
      }

      this.jobs.splice(terminalIndex, 1);
    }

    if (allowHardTrim && this.jobs.length > normalizedTarget) {
      this.jobs = this.jobs.slice(0, normalizedTarget);
    }
  }

  loadPersistedQueue() {
    if (!this.persistencePath) {
      return;
    }

    try {
      const raw = fs.readFileSync(this.persistencePath, 'utf8');
      const parsed = JSON.parse(raw);
      const loadedJobs = sanitizePersistedJobs(parsed?.jobs);
      this.jobs = loadedJobs.filter((job) => job.type);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger?.warn('Failed to load persisted operation queue', {
          error: error.message,
          path: this.persistencePath
        });
      }
    }
  }

  persistQueueSnapshot() {
    if (!this.persistencePath) {
      return;
    }

    if (this.persistenceWriteInFlight) {
      this.persistenceWriteQueued = true;
      return;
    }

    const payload = JSON.stringify({
      version: PERSISTED_QUEUE_VERSION,
      updatedAt: new Date().toISOString(),
      jobs: this.getSnapshot().slice(0, MAX_PERSISTED_JOBS)
    }, null, 2);
    const tempPath = `${this.persistencePath}.${process.pid}.${Date.now()}.tmp`;

    this.persistenceWriteInFlight = true;
    fs.promises.mkdir(path.dirname(this.persistencePath), { recursive: true })
      .then(() => fs.promises.writeFile(tempPath, payload, 'utf8'))
      .then(() => fs.promises.rename(tempPath, this.persistencePath))
      .catch((error) => {
        fs.promises.unlink(tempPath).catch(() => {});
        this.logger?.warn('Failed to persist operation queue snapshot', {
          error: error.message,
          path: this.persistencePath
        });
      })
      .finally(() => {
        this.persistenceWriteInFlight = false;
        if (this.persistenceWriteQueued) {
          this.persistenceWriteQueued = false;
          this.persistQueueSnapshot();
        }
      });
  }

  enqueue(type, payload = {}) {
    const normalizedType = typeof type === 'string' ? type.trim() : '';
    if (!this.runners.has(normalizedType)) {
      throw new Error(`Unsupported queue operation: ${normalizedType}`);
    }

    this.pruneJobsIfNeeded(MAX_IN_MEMORY_JOBS - 1, { allowHardTrim: false });
    if (this.jobs.length >= MAX_IN_MEMORY_JOBS) {
      throw new Error('Operation queue is full. Wait for existing jobs to finish.');
    }

    const now = new Date().toISOString();
    const job = {
      id: crypto.randomUUID(),
      type: normalizedType,
      payload: isPlainObject(payload) ? cloneSerializable(payload, {}) : {},
      status: 'queued',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      result: null,
      error: '',
      cancelled: false
    };

    this.jobs.unshift(job);
    this.pruneJobsIfNeeded();
    this.emitUpdate();
    this.processNext();
    return serializeJob(job);
  }

  findJob(jobId) {
    const normalizedJobId = normalizeJobId(jobId);
    if (!normalizedJobId) {
      return null;
    }
    return this.jobs.find((job) => job.id === normalizedJobId) || null;
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
      return { success: true, job: serializeJob(job) };
    }

    if (job.status === 'running') {
      job.cancelled = true;
      job.updatedAt = new Date().toISOString();
      this.emitUpdate();
      return { success: true, job: serializeJob(job) };
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
    return { success: true, job: serializeJob(job) };
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
    if (typeof runner !== 'function') {
      nextJob.status = 'failed';
      nextJob.error = `No runner is registered for operation type "${nextJob.type}"`;
      nextJob.updatedAt = new Date().toISOString();
      this.running = false;
      this.emitUpdate();
      setImmediate(() => this.processNext());
      return;
    }

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
      this.pruneJobsIfNeeded();
      this.emitUpdate();
      setImmediate(() => this.processNext());
    }
  }
}

module.exports = {
  OperationQueue
};
