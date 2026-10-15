'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { toMicros, validateWithdrawalAmount, validatePendingCount, validateDailyTotal } = require('../src/withdrawalPolicy');

test('converts decimal amounts exactly without floating point', () => {
  assert.equal(toMicros('12.345678'), 12345678n);
  assert.equal(toMicros('0.000001'), 1n);
});
test('rejects malformed or over-precision amounts', () => {
  assert.throws(() => toMicros('1.0000001'));
  assert.throws(() => toMicros('-1'));
  assert.throws(() => toMicros('1e3'));
});
test('applies minimum and configured maximum per withdrawal', () => {
  assert.throws(() => validateWithdrawalAmount('4.99', { WITHDRAWAL_MINIMUM: '5' }), /最低提现/);
  assert.throws(() => validateWithdrawalAmount('100.01', { WITHDRAWAL_MINIMUM: '5', WITHDRAWAL_MAXIMUM: '100' }), /单笔提现/);
  assert.equal(validateWithdrawalAmount('100', { WITHDRAWAL_MINIMUM: '5', WITHDRAWAL_MAXIMUM: '100' }), 100000000n);
});
test('enforces pending-request cap only when configured', () => {
  assert.throws(() => validatePendingCount(2, { WITHDRAWAL_MAX_PENDING: '2' }), /上限/);
  assert.doesNotThrow(() => validatePendingCount(200, { WITHDRAWAL_MAX_PENDING: '0' }));
});
test('enforces daily sum using exact micro-units', () => {
  assert.throws(() => validateDailyTotal('9.999999', '0.000002', { WITHDRAWAL_DAILY_LIMIT: '10' }), /今日提现/);
  assert.doesNotThrow(() => validateDailyTotal('9.999999', '0.000001', { WITHDRAWAL_DAILY_LIMIT: '10' }));
});
