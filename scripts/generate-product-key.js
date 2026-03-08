#!/usr/bin/env node

const {
  generateProductKey,
  formatProductKey
} = require('../license-utils');

function parseCount(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 1;
  }
  return Math.min(parsed, 100);
}

const count = parseCount(process.argv[2]);

for (let i = 0; i < count; i += 1) {
  const key = generateProductKey();
  console.log(formatProductKey(key));
}
