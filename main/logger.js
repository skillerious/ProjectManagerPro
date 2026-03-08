const path = require('path');
const fs = require('fs').promises;

function safeStringify(value) {
  try {
    const seen = new WeakSet();
    return JSON.stringify(value, (_key, currentValue) => {
      if (typeof currentValue === 'bigint') {
        return `${String(currentValue)}n`;
      }

      if (typeof currentValue === 'function') {
        return `[function:${currentValue.name || 'anonymous'}]`;
      }

      if (currentValue instanceof Error) {
        return {
          name: currentValue.name,
          message: currentValue.message,
          stack: currentValue.stack || null
        };
      }

      if (currentValue && typeof currentValue === 'object') {
        if (seen.has(currentValue)) {
          return '[circular-reference]';
        }
        seen.add(currentValue);
      }

      return currentValue;
    });
  } catch (error) {
    const fallbackMessage = error && error.message ? error.message : 'unknown-stringify-error';
    return `"[unserializable-data:${fallbackMessage}]"`;
  }
}

function normalizeLevel(level) {
  const normalized = typeof level === 'string' ? level.trim().toLowerCase() : '';
  if (normalized === 'warn' || normalized === 'warning') {
    return 'warn';
  }
  if (normalized === 'error' || normalized === 'info' || normalized === 'debug') {
    return normalized;
  }
  return 'info';
}

function normalizeMessage(message) {
  if (typeof message === 'string') {
    const cleaned = message.replace(/\s+/g, ' ').trim();
    return cleaned || '[empty-message]';
  }
  if (message === null || message === undefined) {
    return '[empty-message]';
  }
  const casted = String(message).replace(/\s+/g, ' ').trim();
  return casted || '[empty-message]';
}

function truncateText(value, maxLength) {
  const text = typeof value === 'string' ? value : String(value || '');
  if (text.length <= maxLength) {
    return text;
  }

  const omitted = text.length - maxLength;
  return `${text.slice(0, maxLength)}...[truncated:${omitted}]`;
}

function extractSource(data) {
  if (!data || typeof data !== 'object') {
    return 'main';
  }

  const candidates = [
    data.source,
    data.component,
    data.module,
    data.context
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return truncateText(candidate.trim(), 64);
    }
  }

  return 'main';
}

function detectFault(level, message, context) {
  if (level === 'error' || level === 'warn') {
    return true;
  }

  const combined = `${message} ${context}`.toLowerCase();
  return /(error|fail|exception|timeout|denied|invalid|crash|fatal|panic|abort|reject|blocked|corrupt|unable)/.test(combined);
}

function clampInteger(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  const integer = Math.trunc(numeric);
  if (integer < min) {
    return min;
  }
  if (integer > max) {
    return max;
  }
  return integer;
}

function normalizeSearchText(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function sanitizeSortOrder(sort) {
  return sort === 'asc' ? 'asc' : 'desc';
}

function toBoolean(value) {
  return value === true || value === 'true' || value === 1;
}

function normalizeSourceFilter(source) {
  if (typeof source !== 'string') {
    return 'all';
  }
  const normalized = source.trim().toLowerCase();
  return normalized || 'all';
}

function cloneEntry(entry) {
  return {
    ...entry
  };
}

function buildLevelSet(options = {}) {
  const requestedLevel = typeof options.level === 'string'
    ? options.level.trim().toLowerCase()
    : '';
  const normalizedLevels = Array.isArray(options.levels)
    ? options.levels
      .map((value) => normalizeLevel(value))
      .filter(Boolean)
    : [];

  if (requestedLevel && requestedLevel !== 'all') {
    normalizedLevels.push(normalizeLevel(requestedLevel));
  }

  const unique = new Set(normalizedLevels);
  if (!unique.size) {
    if (requestedLevel === 'all' || requestedLevel === '') {
      return null;
    }
    return new Set([normalizeLevel(requestedLevel)]);
  }

  if (unique.has('all')) {
    return null;
  }

  return unique;
}

function calculateStats(entries) {
  const levelCounts = {
    error: 0,
    warn: 0,
    info: 0,
    debug: 0
  };
  const sourceCounts = {};
  let faultCount = 0;
  let latestFault = null;

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const level = normalizeLevel(entry.level);
    levelCounts[level] = (levelCounts[level] || 0) + 1;
    sourceCounts[entry.source] = (sourceCounts[entry.source] || 0) + 1;

    if (entry.isFault) {
      faultCount += 1;
      latestFault = entry;
    }
  }

  let topSource = '';
  let topSourceCount = 0;
  Object.entries(sourceCounts).forEach(([source, count]) => {
    if (count > topSourceCount) {
      topSource = source;
      topSourceCount = count;
    }
  });

  return {
    total: entries.length,
    faultCount,
    levelCounts,
    sourceCounts,
    topSource,
    topSourceCount,
    latestFault
  };
}

function matchesFilters(entry, options = {}) {
  const levelSet = buildLevelSet(options);
  if (levelSet && !levelSet.has(entry.level)) {
    return false;
  }

  const sourceFilter = normalizeSourceFilter(options.source);
  if (sourceFilter !== 'all' && normalizeSourceFilter(entry.source) !== sourceFilter) {
    return false;
  }

  if (toBoolean(options.faultOnly) && !entry.isFault) {
    return false;
  }

  const searchText = normalizeSearchText(options.search);
  if (searchText) {
    const haystack = `${entry.message} ${entry.context} ${entry.source}`.toLowerCase();
    if (!haystack.includes(searchText)) {
      return false;
    }
  }

  return true;
}

function filterHistory(entries, options = {}) {
  const sortOrder = sanitizeSortOrder(options.sort);
  const filtered = entries.filter((entry) => matchesFilters(entry, options));
  const sorted = sortOrder === 'asc' ? filtered : filtered.slice().reverse();
  const limit = clampInteger(options.limit, 1, 10000, 600);
  const offset = clampInteger(options.offset, 0, 2000000, 0);
  const paged = sorted.slice(offset, offset + limit).map(cloneEntry);

  return {
    entries: paged,
    totalFiltered: filtered.length,
    sort: sortOrder,
    limit,
    offset,
    stats: calculateStats(filtered)
  };
}

class Logger {
  constructor({
    app,
    fsPromises = fs,
    pathModule = path,
    consoleRef = console,
    maxHistoryEntries = 4000,
    maxContextLength = 20000
  } = {}) {
    this.app = app;
    this.fs = fsPromises;
    this.path = pathModule;
    this.console = consoleRef;
    this.logPath = null;
    this.currentLogFile = null;
    this.initialized = false;
    this.writeQueue = Promise.resolve();
    this.maxHistoryEntries = clampInteger(maxHistoryEntries, 250, 10000, 4000);
    this.maxContextLength = clampInteger(maxContextLength, 512, 120000, 20000);
    this.history = [];
    this.entrySequence = 0;
    this.listeners = new Set();
  }

  onEntry(listener) {
    if (typeof listener !== 'function') {
      return () => {};
    }

    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emitEntry(entry) {
    if (!this.listeners.size) {
      return;
    }

    const entryCopy = cloneEntry(entry);
    this.listeners.forEach((listener) => {
      try {
        listener(entryCopy);
      } catch (error) {
        this.console.error('Logger listener failed:', error);
      }
    });
  }

  appendToHistory(entry) {
    this.history.push(entry);

    if (this.history.length > this.maxHistoryEntries) {
      const overflow = this.history.length - this.maxHistoryEntries;
      this.history.splice(0, overflow);
    }
  }

  createEntry(level, message, context, source) {
    this.entrySequence += 1;
    const timestamp = new Date().toISOString();
    return {
      id: this.entrySequence,
      timestamp,
      level,
      source,
      message,
      context,
      isFault: detectFault(level, message, context)
    };
  }

  getCurrentLogFile() {
    return this.currentLogFile || '';
  }

  getLogDirectory() {
    return this.logPath || '';
  }

  clearHistory() {
    this.history = [];
  }

  getHistorySnapshot(options = {}) {
    const snapshot = filterHistory(this.history, options);
    return {
      totalEntries: this.history.length,
      filteredEntries: snapshot.totalFiltered,
      sort: snapshot.sort,
      limit: snapshot.limit,
      offset: snapshot.offset,
      stats: snapshot.stats,
      entries: snapshot.entries
    };
  }

  async initializeLogger() {
    if (this.initialized) {
      return;
    }

    try {
      this.logPath = this.path.join(this.app.getPath('userData'), 'logs');
      await this.fs.mkdir(this.logPath, { recursive: true });
      const date = new Date().toISOString().split('T')[0];
      this.currentLogFile = this.path.join(this.logPath, `app-${date}.log`);
      this.initialized = true;
    } catch (error) {
      this.console.error('Failed to initialize logger:', error);
    }
  }

  async appendToFile(logLine) {
    if (!this.currentLogFile) {
      return;
    }

    this.writeQueue = this.writeQueue
      .then(() => this.fs.appendFile(this.currentLogFile, logLine))
      .catch((error) => {
        this.console.error('Failed to write to log file:', error);
      });

    await this.writeQueue;
  }

  async log(level, message, data = null) {
    if (!this.initialized) {
      await this.initializeLogger();
    }

    const normalizedLevel = normalizeLevel(level);
    const normalizedMessage = normalizeMessage(message);
    const source = extractSource(data);
    const serializedData = data !== null && data !== undefined ? safeStringify(data) : '';
    const context = serializedData ? truncateText(serializedData, this.maxContextLength) : '';
    const entry = this.createEntry(normalizedLevel, normalizedMessage, context, source);
    const upperLevel = normalizedLevel.toUpperCase();
    const sourceBlock = entry.source ? ` [${entry.source}]` : '';
    const logLine = `[${entry.timestamp}] [${upperLevel}]${sourceBlock} ${entry.message}${entry.context ? ` | ${entry.context}` : ''}\n`;

    if (normalizedLevel === 'error') {
      this.console.error(logLine);
    } else if (normalizedLevel === 'warn') {
      this.console.warn(logLine);
    } else {
      this.console.log(logLine);
    }

    this.appendToHistory(entry);
    this.emitEntry(entry);
    await this.appendToFile(logLine);
    return cloneEntry(entry);
  }

  info(message, data) {
    return this.log('info', message, data);
  }

  warn(message, data) {
    return this.log('warn', message, data);
  }

  error(message, data) {
    return this.log('error', message, data);
  }

  debug(message, data) {
    return this.log('debug', message, data);
  }
}

module.exports = {
  Logger,
  safeStringify
};
