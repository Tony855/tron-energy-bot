const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyTransfer } = require('../src/chainAudit');

test('reports a confirmed qualifying transfer without recharge order', () => {
  assert.deepEqual(classifyTransfer({ amount: '10' }, null, 1), { type: 'missing_recharge_order', severity: 'high' });
});
test('does not flag transfers below configured minimum', () => {
  assert.deepEqual(classifyTransfer({ amount: '0.5' }, null, 1), { type: 'below_minimum', severity: 'info' });
});
test('detects amount mismatch', () => {
  assert.deepEqual(classifyTransfer({ amount: '10' }, { amount: '9.9' }, 1), { type: 'amount_mismatch', severity: 'high' });
});
test('accepts matching amount within precision tolerance', () => {
  assert.deepEqual(classifyTransfer({ amount: '10.000000' }, { amount: '10' }, 1), { type: 'matched', severity: 'ok' });
});
test('rejects invalid transfer amounts', () => {
  assert.deepEqual(classifyTransfer({ amount: 'NaN' }, null, 1), { type: 'invalid_amount', severity: 'high' });
});
