const test = require('node:test');
const assert = require('node:assert/strict');
const { adminChats, fingerprint } = require('../src/chainAlertUtils');

test('adminChats accepts numeric IDs only and removes duplicates', () => {
  assert.deepEqual(adminChats('123, abc, -100456,123,  '), ['123', '-100456']);
});

test('fingerprint is stable and changes when event identity changes', () => {
  const row = { tx_hash: 'ab'.repeat(32), event_index: 2, wallet_id: 5 };
  const a = fingerprint('missing_recharge_order', row);
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.equal(a, fingerprint('missing_recharge_order', row));
  assert.notEqual(a, fingerprint('amount_mismatch', row));
});
