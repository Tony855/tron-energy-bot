const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyDepositTransfer, assertRechargeCanCredit } = require('../src/chainDepositVerify');
const expected = { contract: 'usdt-contract', to: 'TDepositAddress', amount: '1.250000', decimals: 6 };
const good = { txHash: 'ab'.repeat(32), contract: 'USDT-CONTRACT', from: 'TSender', to: 'tdepositaddress', rawAmount: '1250000', decimals: 6, confirmed: true, receiptResult: 'SUCCESS' };

test('deposit verification matches confirmed contract, destination and exact amount', () => {
  const r = verifyDepositTransfer([good], expected);
  assert.equal(r.verified, true);
  assert.equal(r.raw_amount, '1250000');
});
test('deposit verification fails closed without configured contract', () => {
  assert.throws(() => verifyDepositTransfer([good], { ...expected, contract: '' }), /未配置/);
});
test('deposit verification rejects wrong contract, address, amount and unconfirmed event', () => {
  assert.throws(() => verifyDepositTransfer([{ ...good, contract: 'other' }], expected), /不匹配/);
  assert.throws(() => verifyDepositTransfer([{ ...good, to: 'other' }], expected), /不匹配/);
  assert.throws(() => verifyDepositTransfer([{ ...good, rawAmount: '1250001' }], expected), /不匹配/);
  assert.throws(() => verifyDepositTransfer([{ ...good, decimals: 18 }], expected), /不匹配/);
  assert.throws(() => verifyDepositTransfer([{ ...good, confirmed: false }], expected), /不匹配/);
});
test('deposit verification rejects ambiguous duplicate matching events', () => {
  assert.throws(() => verifyDepositTransfer([good, good], expected), /多个完全匹配/);
});
test('deposit verification rejects amount precision beyond token decimals', () => {
  assert.throws(() => verifyDepositTransfer([good], { ...expected, amount: '1.0000001' }), /精度/);
});

test('TRON recharge cannot be credited before chain verification; manual orders stay manual', () => {
  assert.throws(() => assertRechargeCanCredit({ source: 'tron', chain_verified_at: null }), /必须先完成链上核验/);
  assert.doesNotThrow(() => assertRechargeCanCredit({ source: 'tron', chain_verified_at: '2026-10-15 01:00:00' }));
  assert.doesNotThrow(() => assertRechargeCanCredit({ source: 'manual', chain_verified_at: null }));
});
