const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAmount } = require('../src/money');

test('ledger amount normalization pads to six decimal places', () => {
  assert.equal(normalizeAmount('12'), '12.000000');
  assert.equal(normalizeAmount('0.1'), '0.100000');
  assert.equal(normalizeAmount('-3.250001'), '-3.250001');
});

test('ledger amount normalization canonicalizes negative zero', () => {
  assert.equal(normalizeAmount('-0'), '0.000000');
  assert.equal(normalizeAmount('-0.000000'), '0.000000');
});

test('ledger rejects invalid precision and malformed values', () => {
  for (const value of ['1.1234567', '1e3', 'NaN', '-.5', '1.', '']) {
    assert.throws(() => normalizeAmount(value));
  }
});
