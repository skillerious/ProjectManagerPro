const crypto = require('crypto');

const PRODUCT_KEY_DIGITS = 16;
const PRODUCT_KEY_BODY_DIGITS = 12;
const PRODUCT_KEY_CHECK_DIGITS = PRODUCT_KEY_DIGITS - PRODUCT_KEY_BODY_DIGITS;
const DEFAULT_LICENSE_SECRET = 'appmanager-pro-license-secret-v1';

const LICENSE_KEY_TIER_OFFSET = 0;
const LICENSE_KEY_TIER_LENGTH = 2;
const LICENSE_KEY_VERSION_OFFSET = 2;
const LICENSE_KEY_RANDOM_OFFSET = 3;
const LICENSE_KEY_RANDOM_LENGTH = 9;

const KEY_FORMAT_VERSION_LEGACY = '1';
const KEY_FORMAT_VERSION_CURRENT = '2';

const VALID_TIERS = {
  '10': 'standard',
  '20': 'pro',
  '30': 'enterprise'
};

const KEY_INPUT_ALLOWED_CHARS = /^[\d -]+$/;
const GENERATION_MAX_ATTEMPTS = 500;

function getLicenseSecret() {
  const envSecret = process.env.APP_MANAGER_LICENSE_SECRET;
  if (typeof envSecret === 'string' && envSecret.trim()) {
    return envSecret.trim();
  }
  return DEFAULT_LICENSE_SECRET;
}

function normalizeProductKey(keyInput) {
  if (typeof keyInput !== 'string') {
    return '';
  }
  return keyInput.replace(/\D/g, '').slice(0, PRODUCT_KEY_DIGITS);
}

function digitsOnly(keyInput) {
  if (typeof keyInput !== 'string') {
    return '';
  }
  return keyInput.replace(/\D/g, '');
}

function formatProductKey(keyInput) {
  const normalized = normalizeProductKey(String(keyInput || ''));
  if (!normalized) {
    return '';
  }

  const chunks = normalized.match(/.{1,4}/g) || [];
  return chunks.join('-');
}

function deriveCheckDigits(payloadDigits, secret = getLicenseSecret()) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payloadDigits);
  const digest = hmac.digest();
  const checksumValue = digest.readUInt32BE(0) % 10000;
  return String(checksumValue).padStart(PRODUCT_KEY_CHECK_DIGITS, '0');
}

function checkKeyEntropy(randomDigits) {
  if (typeof randomDigits !== 'string' || randomDigits.length === 0) {
    return { valid: false, error: 'Product key is invalid.' };
  }

  // Reject 5+ contiguous repeated digits in the random portion.
  if (/(\d)\1{4,}/.test(randomDigits)) {
    return { valid: false, error: 'Product key contains an invalid pattern.' };
  }

  // Reject repeated 2-digit blocks (for example: 121212...).
  if (/(..)\1{2,}/.test(randomDigits)) {
    return { valid: false, error: 'Product key contains an invalid pattern.' };
  }

  // Sequential pattern rejection: 6+ consecutive ascending or descending digits
  let ascending = 1;
  let descending = 1;
  for (let i = 1; i < randomDigits.length; i++) {
    const prev = Number(randomDigits[i - 1]);
    const curr = Number(randomDigits[i]);
    if (curr === prev + 1) {
      ascending++;
      if (ascending >= 6) {
        return { valid: false, error: 'Product key contains an invalid pattern.' };
      }
    } else {
      ascending = 1;
    }
    if (curr === prev - 1) {
      descending++;
      if (descending >= 6) {
        return { valid: false, error: 'Product key contains an invalid pattern.' };
      }
    } else {
      descending = 1;
    }
  }

  // Digit frequency analysis: reject if any digit appears in >60% of the random portion
  const threshold = Math.ceil(randomDigits.length * 0.6);
  const freq = new Array(10).fill(0);
  for (let i = 0; i < randomDigits.length; i++) {
    freq[Number(randomDigits[i])]++;
  }
  for (let d = 0; d < 10; d++) {
    if (freq[d] >= threshold) {
      return { valid: false, error: 'Product key is invalid.' };
    }
  }

  const uniqueDigits = freq.filter((count) => count > 0).length;
  if (uniqueDigits < 3) {
    return { valid: false, error: 'Product key is invalid.' };
  }

  return { valid: true };
}

function extractKeyMetadata(normalizedKey) {
  if (typeof normalizedKey !== 'string' || normalizedKey.length !== PRODUCT_KEY_DIGITS) {
    return { version: 0, tierCode: null, tierName: null, isLegacy: true };
  }

  const payloadDigits = normalizedKey.slice(0, PRODUCT_KEY_BODY_DIGITS);
  const versionDigit = payloadDigits[LICENSE_KEY_VERSION_OFFSET];

  if (versionDigit !== KEY_FORMAT_VERSION_CURRENT) {
    return { version: 1, tierCode: null, tierName: 'pro', isLegacy: true };
  }

  const tierCode = payloadDigits.slice(LICENSE_KEY_TIER_OFFSET, LICENSE_KEY_TIER_OFFSET + LICENSE_KEY_TIER_LENGTH);
  const tierName = VALID_TIERS[tierCode] || null;

  return {
    version: 2,
    tierCode,
    tierName,
    isLegacy: false
  };
}

function validateProductKey(keyInput, secret = getLicenseSecret()) {
  if (typeof keyInput !== 'string') {
    return { valid: false, normalizedKey: '', error: 'Enter a product key.' };
  }

  const trimmedInput = keyInput.trim();
  if (!trimmedInput) {
    return { valid: false, normalizedKey: '', error: 'Enter a product key.' };
  }

  if (!KEY_INPUT_ALLOWED_CHARS.test(trimmedInput)) {
    return {
      valid: false,
      normalizedKey: '',
      error: 'Product key may contain only digits, spaces, and hyphens.'
    };
  }

  const normalized = digitsOnly(trimmedInput);

  if (!normalized) {
    return { valid: false, normalizedKey: '', error: 'Enter a product key.' };
  }

  if (normalized.length !== PRODUCT_KEY_DIGITS) {
    return {
      valid: false,
      normalizedKey: normalized,
      error: 'Product key must contain exactly 16 digits.'
    };
  }

  if (/^(\d)\1{15}$/.test(normalized)) {
    return {
      valid: false,
      normalizedKey: normalized,
      error: 'Product key is invalid.'
    };
  }

  const payloadDigits = normalized.slice(0, PRODUCT_KEY_BODY_DIGITS);
  const providedCheckDigits = normalized.slice(PRODUCT_KEY_BODY_DIGITS);
  const expectedCheckDigits = deriveCheckDigits(payloadDigits, secret);

  if (providedCheckDigits !== expectedCheckDigits) {
    return {
      valid: false,
      normalizedKey: normalized,
      error: 'Product key validation failed. Check your key and try again.'
    };
  }

  // V2-specific validation
  const versionDigit = payloadDigits[LICENSE_KEY_VERSION_OFFSET];
  if (versionDigit === KEY_FORMAT_VERSION_CURRENT) {
    const tierCode = payloadDigits.slice(LICENSE_KEY_TIER_OFFSET, LICENSE_KEY_TIER_OFFSET + LICENSE_KEY_TIER_LENGTH);
    if (!VALID_TIERS[tierCode]) {
      return {
        valid: false,
        normalizedKey: normalized,
        error: 'Product key contains an invalid tier.'
      };
    }

    const randomPortion = payloadDigits.slice(LICENSE_KEY_RANDOM_OFFSET);
    const entropyResult = checkKeyEntropy(randomPortion);
    if (!entropyResult.valid) {
      return {
        valid: false,
        normalizedKey: normalized,
        error: entropyResult.error
      };
    }
  }

  const metadata = extractKeyMetadata(normalized);

  return {
    valid: true,
    normalizedKey: normalized,
    formattedKey: formatProductKey(normalized),
    metadata
  };
}

function resolveTierCode(tierInput) {
  if (typeof tierInput !== 'string') {
    return '20';
  }

  const trimmed = tierInput.trim();
  if (VALID_TIERS[trimmed]) {
    return trimmed;
  }

  const normalizedName = trimmed.toLowerCase();
  const entry = Object.entries(VALID_TIERS).find(([, name]) => name === normalizedName);
  if (entry) {
    return entry[0];
  }

  return '20';
}

function generateProductKey(secret = getLicenseSecret(), options = {}) {
  const tier = resolveTierCode(options.tier);
  const version = KEY_FORMAT_VERSION_CURRENT;

  for (let attempts = 0; attempts < GENERATION_MAX_ATTEMPTS; attempts++) {
    let randomDigits = '';
    for (let i = 0; i < LICENSE_KEY_RANDOM_LENGTH; i++) {
      randomDigits += String(crypto.randomInt(0, 10));
    }

    if (!checkKeyEntropy(randomDigits).valid) {
      continue;
    }

    const payloadDigits = `${tier}${version}${randomDigits}`;
    const checkDigits = deriveCheckDigits(payloadDigits, secret);
    const candidate = `${payloadDigits}${checkDigits}`;

    if (validateProductKey(candidate, secret).valid) {
      return candidate;
    }
  }

  throw new Error('Unable to generate a valid product key after multiple attempts.');
}

function maskProductKey(keyInput) {
  const normalized = normalizeProductKey(keyInput);
  if (normalized.length !== PRODUCT_KEY_DIGITS) {
    return '';
  }

  return `****-****-****-${normalized.slice(-4)}`;
}

module.exports = {
  PRODUCT_KEY_DIGITS,
  PRODUCT_KEY_BODY_DIGITS,
  PRODUCT_KEY_CHECK_DIGITS,
  KEY_FORMAT_VERSION_CURRENT,
  KEY_FORMAT_VERSION_LEGACY,
  VALID_TIERS,
  getLicenseSecret,
  normalizeProductKey,
  formatProductKey,
  validateProductKey,
  generateProductKey,
  maskProductKey,
  extractKeyMetadata,
  checkKeyEntropy
};
