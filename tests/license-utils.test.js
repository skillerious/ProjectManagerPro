const test = require('node:test');
const assert = require('node:assert/strict');

const {
  generateProductKey,
  validateProductKey,
  formatProductKey,
  normalizeProductKey
} = require('../license-utils');

test('generateProductKey creates a valid 16-digit key', () => {
  const key = generateProductKey();
  const validation = validateProductKey(key);

  assert.equal(typeof key, 'string');
  assert.equal(key.length, 16);
  assert.equal(validation.valid, true);
});

test('format and normalize product key values', () => {
  const raw = '1234 5678 9012 3456';
  const normalized = normalizeProductKey(raw);
  const formatted = formatProductKey(normalized);

  assert.equal(normalized, '1234567890123456');
  assert.equal(formatted, '1234-5678-9012-3456');
});

test('validateProductKey rejects invalid repeated digits', () => {
  const validation = validateProductKey('1111-1111-1111-1111');

  assert.equal(validation.valid, false);
  assert.match(validation.error, /invalid/i);
});

test('validateProductKey rejects unsupported characters and extra digits', () => {
  const invalidChar = validateProductKey('1234-5678-9012-345X');
  assert.equal(invalidChar.valid, false);
  assert.match(invalidChar.error, /only digits, spaces, and hyphens/i);

  const validKey = generateProductKey();
  const tooManyDigits = validateProductKey(`${validKey}99`);
  assert.equal(tooManyDigits.valid, false);
  assert.match(tooManyDigits.error, /exactly 16 digits/i);
});

test('generateProductKey supports tier names and yields matching metadata', () => {
  const key = generateProductKey(undefined, { tier: 'enterprise' });
  const validation = validateProductKey(key);

  assert.equal(validation.valid, true);
  assert.equal(validation.metadata.tierCode, '30');
  assert.equal(validation.metadata.tierName, 'enterprise');
});
