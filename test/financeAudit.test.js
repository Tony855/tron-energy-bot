const test = require('node:test');
const assert = require('node:assert/strict');

function validTxHash(value) { return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value.trim()); }
function classifyStatus(status) { return ['pending','approved','paid','rejected','cancelled'].includes(status); }

test('提现交易哈希只接受 64 位十六进制', () => {
  assert.equal(validTxHash('a'.repeat(64)), true);
  assert.equal(validTxHash('G'.repeat(64)), false);
  assert.equal(validTxHash('a'.repeat(63)), false);
  assert.equal(validTxHash(''), false);
});
test('提现状态只允许已知枚举', () => {
  for (const s of ['pending','approved','paid','rejected','cancelled']) assert.equal(classifyStatus(s), true);
  assert.equal(classifyStatus('refunded'), false);
  assert.equal(classifyStatus('PAID'), false);
});
