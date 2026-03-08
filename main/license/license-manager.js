const path = require('path');
const defaultLicenseUtils = require('../../license-utils');

const LICENSE_FILE_NAME = 'license.dat';
const LICENSE_FALLBACK_SALT = 'appmanager-pro-license-fallback-v1';
const RATE_LIMIT_COOLDOWNS = [1000, 3000, 7000, 15000, 30000, 60000];
const RATE_LIMIT_MAX_FAILURES = 10;
const RATE_LIMIT_LOCKOUT_DURATION = 5 * 60 * 1000;
const RATE_LIMIT_RESET_WINDOW_MS = 15 * 60 * 1000;
const GRACE_PERIOD_DAYS = 7;
const MAX_AUDIT_ENTRIES = 20;
const MAX_LICENSE_FILE_SIZE_BYTES = 64 * 1024;
const MAX_REGISTRATION_KEY_INPUT_LENGTH = 512;
const LOAD_AUDIT_MIN_INTERVAL_MS = 5 * 60 * 1000;

function buildDefaultLicenseState() {
  return {
    isProUnlocked: false,
    normalizedKey: '',
    maskedKey: '',
    registeredAt: null,
    tier: null,
    tierCode: null,
    isLegacy: false,
    fingerprintMatch: null,
    graceExpiresAt: null
  };
}

function createLicenseManager({
  app,
  fsPromises,
  cryptoModule,
  osModule,
  safeStorageRef,
  processRef = process,
  licenseUtils = defaultLicenseUtils,
  consoleRef = console,
  nowProvider = () => Date.now()
} = {}) {
  if (!app || typeof app.getPath !== 'function' || typeof app.getName !== 'function') {
    throw new Error('createLicenseManager requires an Electron app-like object.');
  }
  if (!fsPromises || typeof fsPromises.readFile !== 'function' || typeof fsPromises.writeFile !== 'function') {
    throw new Error('createLicenseManager requires fs promises helpers.');
  }
  if (!cryptoModule || typeof cryptoModule.createHash !== 'function') {
    throw new Error('createLicenseManager requires a crypto module.');
  }
  if (!osModule || typeof osModule.hostname !== 'function' || typeof osModule.cpus !== 'function') {
    throw new Error('createLicenseManager requires an os module.');
  }

  const {
    validateProductKey,
    maskProductKey,
    normalizeProductKey,
    extractKeyMetadata,
    getLicenseSecret,
    VALID_TIERS
  } = licenseUtils;

  const fs = fsPromises;
  const crypto = cryptoModule;
  const os = osModule;
  const safeStorage = safeStorageRef;
  const consoleSafe = consoleRef;

  let licenseState = buildDefaultLicenseState();
  let registrationRateLimit = {
    failureCount: 0,
    lastFailureTime: 0,
    lockedUntil: 0
  };

  function getNowMs() {
    return Number(nowProvider()) || Date.now();
  }

  function getNowDate() {
    return new Date(getNowMs());
  }

  function getLicenseFilePath() {
    return path.join(app.getPath('userData'), LICENSE_FILE_NAME);
  }

  function getFallbackLicenseEncryptionKey() {
    let username = 'unknown';

    try {
      username = os.userInfo().username || 'unknown';
    } catch {
      // Ignore and keep fallback username.
    }

    const keyMaterial = [
      app.getName(),
      os.hostname(),
      username,
      processRef.arch,
      app.getPath('userData')
    ].join('|');

    return crypto.scryptSync(keyMaterial, LICENSE_FALLBACK_SALT, 32);
  }

  function encryptLicensePayload(payload) {
    const serializedPayload = JSON.stringify(payload);

    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(serializedPayload);
      return {
        scheme: 'safe-storage-v1',
        data: encrypted.toString('base64')
      };
    }

    const key = getFallbackLicenseEncryptionKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encryptedData = Buffer.concat([cipher.update(serializedPayload, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      scheme: 'aes-256-gcm-v1',
      iv: iv.toString('base64'),
      tag: authTag.toString('base64'),
      data: encryptedData.toString('base64')
    };
  }

  function decryptLicensePayload(encryptedPayload) {
    if (!encryptedPayload || typeof encryptedPayload !== 'object') {
      throw new Error('License payload is malformed.');
    }

    if (encryptedPayload.scheme === 'safe-storage-v1') {
      if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
        throw new Error('Secure storage is not available on this machine.');
      }

      const decrypted = safeStorage.decryptString(Buffer.from(encryptedPayload.data, 'base64'));
      return JSON.parse(decrypted);
    }

    if (encryptedPayload.scheme === 'aes-256-gcm-v1') {
      const key = getFallbackLicenseEncryptionKey();
      const iv = Buffer.from(encryptedPayload.iv, 'base64');
      const authTag = Buffer.from(encryptedPayload.tag, 'base64');
      const encryptedData = Buffer.from(encryptedPayload.data, 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);

      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]).toString('utf8');
      return JSON.parse(decrypted);
    }

    throw new Error('Unknown license encryption scheme.');
  }

  function generateMachineFingerprint() {
    let username = 'unknown';
    try {
      username = os.userInfo().username || 'unknown';
    } catch {
      // Ignore and keep fallback username.
    }

    const components = {
      hostname: os.hostname(),
      username,
      arch: processRef.arch,
      cpuModel: (os.cpus()[0] || {}).model || 'unknown',
      totalMemoryGB: Math.round(os.totalmem() / (1024 * 1024 * 1024))
    };

    const raw = [
      components.hostname,
      components.username,
      components.arch,
      components.cpuModel,
      String(components.totalMemoryGB)
    ].join('|');

    const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
    return { hash, components };
  }

  function computeFingerprintMatchScore(stored, current) {
    if (!stored || !current) {
      return 0;
    }
    let score = 0;
    if (stored.hostname === current.hostname) score += 1;
    if (stored.username === current.username) score += 1;
    if (stored.arch === current.arch) score += 1;
    if (stored.cpuModel === current.cpuModel) score += 1;
    if (stored.totalMemoryGB === current.totalMemoryGB) score += 1;
    return score;
  }

  function resetRegistrationRateLimit() {
    registrationRateLimit = { failureCount: 0, lastFailureTime: 0, lockedUntil: 0 };
  }

  function checkRegistrationRateLimit() {
    const now = getNowMs();

    if (registrationRateLimit.lockedUntil > 0 && registrationRateLimit.lockedUntil <= now) {
      resetRegistrationRateLimit();
    }

    if (
      registrationRateLimit.failureCount > 0 &&
      registrationRateLimit.lastFailureTime > 0 &&
      now - registrationRateLimit.lastFailureTime >= RATE_LIMIT_RESET_WINDOW_MS
    ) {
      resetRegistrationRateLimit();
    }

    if (registrationRateLimit.lockedUntil > now) {
      const remainingSec = Math.ceil((registrationRateLimit.lockedUntil - now) / 1000);
      return {
        allowed: false,
        error: `Too many failed attempts. Try again in ${remainingSec} seconds.`,
        retryAfterMs: registrationRateLimit.lockedUntil - now
      };
    }

    if (registrationRateLimit.failureCount > 0) {
      const cooldownIndex = Math.min(registrationRateLimit.failureCount - 1, RATE_LIMIT_COOLDOWNS.length - 1);
      const cooldownMs = RATE_LIMIT_COOLDOWNS[cooldownIndex];
      const elapsed = now - registrationRateLimit.lastFailureTime;
      if (elapsed < cooldownMs) {
        const remainingSec = Math.ceil((cooldownMs - elapsed) / 1000);
        return {
          allowed: false,
          error: `Please wait ${remainingSec} seconds before trying again.`,
          retryAfterMs: cooldownMs - elapsed
        };
      }
    }

    return { allowed: true };
  }

  function recordRegistrationFailure() {
    registrationRateLimit.failureCount += 1;
    registrationRateLimit.lastFailureTime = getNowMs();

    if (registrationRateLimit.failureCount >= RATE_LIMIT_MAX_FAILURES) {
      registrationRateLimit.lockedUntil = getNowMs() + RATE_LIMIT_LOCKOUT_DURATION;
    }
  }

  function createAuditEntry(action, success, fingerprint) {
    return {
      timestamp: getNowDate().toISOString(),
      action,
      success,
      fingerprint: fingerprint ? fingerprint.hash : null
    };
  }

  function appendAuditEntry(auditLog, entry) {
    const log = Array.isArray(auditLog) ? [...auditLog] : [];
    log.push(entry);
    while (log.length > MAX_AUDIT_ENTRIES) {
      log.shift();
    }
    return log;
  }

  function computePayloadIntegrityHmac(encryptedPayloadJson) {
    const secret = getLicenseSecret();
    return crypto.createHmac('sha256', secret).update(encryptedPayloadJson).digest('hex');
  }

  function isValidIsoTimestamp(value) {
    if (typeof value !== 'string' || !value.trim()) {
      return false;
    }

    const parsed = Date.parse(value);
    return Number.isFinite(parsed);
  }

  function safeStringEquals(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') {
      return false;
    }

    const leftBuffer = Buffer.from(left, 'utf8');
    const rightBuffer = Buffer.from(right, 'utf8');
    if (leftBuffer.length !== rightBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
  }

  function validateMachineFingerprintPayload(machineFingerprint) {
    if (!machineFingerprint || typeof machineFingerprint !== 'object' || Array.isArray(machineFingerprint)) {
      return { valid: false, error: 'License file contains an invalid machine fingerprint.' };
    }

    if (typeof machineFingerprint.hash !== 'string' || !/^[a-f0-9]{32}$/i.test(machineFingerprint.hash)) {
      return { valid: false, error: 'License file contains an invalid machine fingerprint hash.' };
    }

    const components = machineFingerprint.components;
    if (!components || typeof components !== 'object' || Array.isArray(components)) {
      return { valid: false, error: 'License file contains invalid fingerprint components.' };
    }

    if (
      typeof components.hostname !== 'string' ||
      typeof components.username !== 'string' ||
      typeof components.arch !== 'string' ||
      typeof components.cpuModel !== 'string' ||
      !Number.isFinite(components.totalMemoryGB)
    ) {
      return { valid: false, error: 'License file contains malformed fingerprint components.' };
    }

    return { valid: true };
  }

  function validateGracePeriodPayload(gracePeriod) {
    if (!gracePeriod || typeof gracePeriod !== 'object' || Array.isArray(gracePeriod)) {
      return { valid: false, error: 'License file contains an invalid grace period.' };
    }

    if (!isValidIsoTimestamp(gracePeriod.startedAt) || !isValidIsoTimestamp(gracePeriod.expiresAt)) {
      return { valid: false, error: 'License file contains an invalid grace period date.' };
    }

    const startedAtMs = Date.parse(gracePeriod.startedAt);
    const expiresAtMs = Date.parse(gracePeriod.expiresAt);
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= startedAtMs) {
      return { valid: false, error: 'License file contains inconsistent grace period dates.' };
    }

    if (gracePeriod.reason != null && (typeof gracePeriod.reason !== 'string' || gracePeriod.reason.length > 128)) {
      return { valid: false, error: 'License file contains an invalid grace period reason.' };
    }

    if (gracePeriod.matchScore != null) {
      if (!Number.isInteger(gracePeriod.matchScore) || gracePeriod.matchScore < 0 || gracePeriod.matchScore > 5) {
        return { valid: false, error: 'License file contains an invalid grace period score.' };
      }
    }

    return { valid: true };
  }

  function validateAuditLogPayload(auditLog) {
    if (!Array.isArray(auditLog)) {
      return { valid: false, error: 'License file contains an invalid audit log.' };
    }

    if (auditLog.length > 1000) {
      return { valid: false, error: 'License file audit log is too large.' };
    }

    for (const entry of auditLog) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return { valid: false, error: 'License file contains an invalid audit entry.' };
      }

      if (!isValidIsoTimestamp(entry.timestamp)) {
        return { valid: false, error: 'License file contains an invalid audit timestamp.' };
      }

      if (typeof entry.action !== 'string' || !entry.action.trim() || entry.action.length > 64) {
        return { valid: false, error: 'License file contains an invalid audit action.' };
      }

      if (typeof entry.success !== 'boolean') {
        return { valid: false, error: 'License file contains an invalid audit status.' };
      }

      if (entry.fingerprint != null) {
        if (typeof entry.fingerprint !== 'string' || !/^[a-f0-9]{32}$/i.test(entry.fingerprint)) {
          return { valid: false, error: 'License file contains an invalid audit fingerprint.' };
        }
      }
    }

    return { valid: true };
  }

  function validateLicensePayloadShape(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { valid: false, error: 'License payload is malformed.' };
    }

    if (typeof payload.productKey !== 'string' || payload.productKey.length > 64) {
      return { valid: false, error: 'License payload does not contain a valid product key.' };
    }

    if (payload.registeredAt != null && !isValidIsoTimestamp(payload.registeredAt)) {
      return { valid: false, error: 'License payload contains an invalid registration date.' };
    }

    if (payload.createdAt != null && !isValidIsoTimestamp(payload.createdAt)) {
      return { valid: false, error: 'License payload contains an invalid creation date.' };
    }

    if (payload.version != null && payload.version !== 1 && payload.version !== 2) {
      return { valid: false, error: 'License payload has an unsupported version.' };
    }

    if (payload.tier != null) {
      if (typeof payload.tier !== 'string' || !Object.values(VALID_TIERS).includes(payload.tier)) {
        return { valid: false, error: 'License payload contains an invalid tier.' };
      }
    }

    if (payload.tierCode != null) {
      if (typeof payload.tierCode !== 'string' || !VALID_TIERS[payload.tierCode]) {
        return { valid: false, error: 'License payload contains an invalid tier code.' };
      }
    }

    if (payload.machineFingerprint != null) {
      const machineValidation = validateMachineFingerprintPayload(payload.machineFingerprint);
      if (!machineValidation.valid) {
        return machineValidation;
      }
    }

    if (payload.gracePeriod != null) {
      const graceValidation = validateGracePeriodPayload(payload.gracePeriod);
      if (!graceValidation.valid) {
        return graceValidation;
      }
    }

    if (payload.auditLog != null) {
      const auditValidation = validateAuditLogPayload(payload.auditLog);
      if (!auditValidation.valid) {
        return auditValidation;
      }
    }

    return { valid: true };
  }

  function shouldAppendLoadAudit(auditLog, fingerprintHash) {
    if (!Array.isArray(auditLog) || auditLog.length === 0) {
      return true;
    }

    for (let i = auditLog.length - 1; i >= 0; i -= 1) {
      const entry = auditLog[i];
      if (!entry || entry.action !== 'load') {
        continue;
      }

      if (entry.fingerprint && fingerprintHash && entry.fingerprint !== fingerprintHash) {
        return true;
      }

      const timestampMs = Date.parse(entry.timestamp);
      if (!Number.isFinite(timestampMs)) {
        return true;
      }

      return getNowMs() - timestampMs >= LOAD_AUDIT_MIN_INTERVAL_MS;
    }

    return true;
  }

  async function saveLicensePayload(payload) {
    const encryptedPayload = encryptLicensePayload(payload);
    const encryptedJson = JSON.stringify(encryptedPayload);
    const integrity = computePayloadIntegrityHmac(encryptedJson);
    const fileContent = { formatVersion: 2, payload: encryptedPayload, integrity };
    await fs.writeFile(getLicenseFilePath(), JSON.stringify(fileContent, null, 2), 'utf8');
  }

  async function updateAuditLogInFile(payload, newEntry) {
    try {
      payload.auditLog = appendAuditEntry(payload.auditLog, newEntry);
      await saveLicensePayload(payload);
    } catch (error) {
      consoleSafe.warn('Failed to update audit log:', error.message);
    }
  }

  function resetLicenseState() {
    licenseState = buildDefaultLicenseState();
  }

  function updateLicenseStateFromPayload(normalizedKey, registeredAt, metadata, fingerprint) {
    const normalized = normalizeProductKey(normalizedKey);

    licenseState = {
      isProUnlocked: normalized.length === 16,
      normalizedKey: normalized,
      maskedKey: maskProductKey(normalized),
      registeredAt: typeof registeredAt === 'string' && registeredAt.trim()
        ? registeredAt.trim()
        : getNowDate().toISOString(),
      tier: metadata ? metadata.tierName : 'pro',
      tierCode: metadata ? metadata.tierCode : null,
      isLegacy: metadata ? metadata.isLegacy : true,
      fingerprintMatch: licenseState.fingerprintMatch || (fingerprint ? true : null),
      graceExpiresAt: licenseState.graceExpiresAt || null
    };
  }

  function getLicenseStatus() {
    return {
      isProUnlocked: Boolean(licenseState.isProUnlocked),
      maskedKey: licenseState.maskedKey || '',
      registeredAt: licenseState.registeredAt || null,
      tier: licenseState.tier || null,
      tierCode: licenseState.tierCode || null,
      isLegacy: Boolean(licenseState.isLegacy),
      fingerprintMatch: licenseState.fingerprintMatch,
      graceExpiresAt: licenseState.graceExpiresAt
    };
  }

  function isProUnlocked() {
    return Boolean(licenseState.isProUnlocked);
  }

  async function loadLicenseState() {
    resetLicenseState();

    let rawContent;
    try {
      rawContent = await fs.readFile(getLicenseFilePath(), 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        consoleSafe.warn('Failed to read license file:', error.message);
      }
      return;
    }

    try {
      if (Buffer.byteLength(rawContent, 'utf8') > MAX_LICENSE_FILE_SIZE_BYTES) {
        throw new Error('License file is too large.');
      }

      const parsed = JSON.parse(rawContent);

      let encryptedPayload;
      if (parsed.formatVersion === 2 && parsed.payload) {
        if (typeof parsed.integrity !== 'string' || !/^[a-f0-9]{64}$/i.test(parsed.integrity)) {
          throw new Error('License file integrity metadata is invalid.');
        }
        const normalizedIntegrity = parsed.integrity.toLowerCase();
        const expectedIntegrity = computePayloadIntegrityHmac(JSON.stringify(parsed.payload));
        if (!safeStringEquals(normalizedIntegrity, expectedIntegrity)) {
          throw new Error('License file integrity check failed. File may have been tampered with.');
        }
        encryptedPayload = parsed.payload;
      } else if (parsed.scheme) {
        encryptedPayload = parsed;
      } else {
        throw new Error('Unrecognized license file format.');
      }

      const payload = decryptLicensePayload(encryptedPayload);
      const payloadValidation = validateLicensePayloadShape(payload);
      if (!payloadValidation.valid) {
        throw new Error(payloadValidation.error);
      }

      if (!payload || typeof payload.productKey !== 'string') {
        throw new Error('License file does not contain a product key.');
      }

      const validation = validateProductKey(payload.productKey);
      if (!validation.valid) {
        throw new Error(validation.error || 'Stored product key is invalid.');
      }

      if (payload.version === 2 && payload.machineFingerprint) {
        const currentFp = generateMachineFingerprint();

        if (currentFp.hash !== payload.machineFingerprint.hash) {
          const score = computeFingerprintMatchScore(
            payload.machineFingerprint.components,
            currentFp.components
          );

          if (score >= 3) {
            const now = getNowDate();

            if (payload.gracePeriod && payload.gracePeriod.expiresAt) {
              const expiresAt = new Date(payload.gracePeriod.expiresAt);
              if (now > expiresAt) {
                const auditEntry = createAuditEntry('fingerprint-mismatch', false, currentFp);
                await updateAuditLogInFile(payload, auditEntry);
                throw new Error('Machine fingerprint changed and grace period has expired. Please re-register.');
              }
              licenseState.fingerprintMatch = 'grace';
              licenseState.graceExpiresAt = payload.gracePeriod.expiresAt;
            } else {
              const expiresAt = new Date(now.getTime() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
              payload.gracePeriod = {
                startedAt: now.toISOString(),
                expiresAt: expiresAt.toISOString(),
                reason: 'partial-fingerprint-mismatch',
                matchScore: score
              };
              payload.auditLog = appendAuditEntry(payload.auditLog, createAuditEntry('grace-period', true, currentFp));
              try {
                await saveLicensePayload(payload);
              } catch (saveError) {
                consoleSafe.warn('Failed to persist grace period state:', saveError.message);
              }
              licenseState.fingerprintMatch = 'grace';
              licenseState.graceExpiresAt = expiresAt.toISOString();
            }
          } else {
            const auditEntry = createAuditEntry('fingerprint-mismatch', false, currentFp);
            await updateAuditLogInFile(payload, auditEntry);
            throw new Error('License is bound to a different machine. Please re-register.');
          }
        } else {
          licenseState.fingerprintMatch = true;
          licenseState.graceExpiresAt = null;

          if (payload.gracePeriod) {
            payload.gracePeriod = null;
            payload.auditLog = appendAuditEntry(payload.auditLog, createAuditEntry('fingerprint-recovered', true, currentFp));
            try {
              await saveLicensePayload(payload);
            } catch (saveError) {
              consoleSafe.warn('Failed to clear grace period after fingerprint recovery:', saveError.message);
            }
          }
        }
      }

      const metadata = validation.metadata;
      updateLicenseStateFromPayload(validation.normalizedKey, payload.registeredAt, metadata, null);

      if (payload.version === 2) {
        const currentFp = generateMachineFingerprint();
        if (shouldAppendLoadAudit(payload.auditLog, currentFp.hash)) {
          await updateAuditLogInFile(payload, createAuditEntry('load', true, currentFp));
        }
      }
    } catch (error) {
      resetLicenseState();
      consoleSafe.warn('Failed to load license state:', error.message);
    }
  }

  async function registerProductKey(rawProductKey) {
    const rateCheck = checkRegistrationRateLimit();
    if (!rateCheck.allowed) {
      return {
        success: false,
        error: rateCheck.error,
        retryAfterMs: rateCheck.retryAfterMs
      };
    }

    if (typeof rawProductKey !== 'string' || !rawProductKey.trim()) {
      recordRegistrationFailure();
      return {
        success: false,
        error: 'Enter a product key.',
        failureCount: registrationRateLimit.failureCount
      };
    }

    if (rawProductKey.length > MAX_REGISTRATION_KEY_INPUT_LENGTH) {
      recordRegistrationFailure();
      return {
        success: false,
        error: 'Product key input is too long.',
        failureCount: registrationRateLimit.failureCount
      };
    }

    const validation = validateProductKey(rawProductKey);

    if (!validation.valid) {
      recordRegistrationFailure();
      return {
        success: false,
        error: validation.error || 'Invalid product key.',
        failureCount: registrationRateLimit.failureCount
      };
    }

    if (
      licenseState.isProUnlocked &&
      licenseState.normalizedKey === validation.normalizedKey &&
      licenseState.fingerprintMatch === true
    ) {
      resetRegistrationRateLimit();
      return {
        success: true,
        status: getLicenseStatus(),
        alreadyRegistered: true
      };
    }

    const fingerprint = generateMachineFingerprint();
    const metadata = validation.metadata;
    const registeredAt = getNowDate().toISOString();
    const auditLog = [createAuditEntry('register', true, fingerprint)];

    const payload = {
      productKey: validation.normalizedKey,
      registeredAt,
      createdAt: registeredAt,
      version: 2,
      tier: metadata.tierName,
      tierCode: metadata.tierCode,
      machineFingerprint: { hash: fingerprint.hash, components: fingerprint.components },
      gracePeriod: null,
      auditLog
    };

    try {
      await saveLicensePayload(payload);
      licenseState.fingerprintMatch = true;
      licenseState.graceExpiresAt = null;
      updateLicenseStateFromPayload(validation.normalizedKey, registeredAt, metadata, fingerprint);
      resetRegistrationRateLimit();

      return {
        success: true,
        status: getLicenseStatus()
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to store product key: ${error.message}`
      };
    }
  }

  return {
    loadLicenseState,
    registerProductKey,
    getLicenseStatus,
    isProUnlocked
  };
}

module.exports = {
  createLicenseManager
};
