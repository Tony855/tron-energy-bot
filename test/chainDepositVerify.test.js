'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyDepositTransfer, assertRechargeCanCredit } = require('../src/chainDepositVerify');
const expected = { contract: 'usdt-contract', to: 'TDepositAddress', amount: '1.250000', decimals: 6 };
const good = { txHash: 'ab'.repeat(32), contract: 'USDT-CONTRACT', from: 'TSender', to: 'tdepositaddress', rawAmount: '1250000', decimals: 6, confirmed: true, receiptResult: 'SUCCESS' };

test('deposit verification matches confirmed contract, destination and exact amount', () => {
  const r = verifyDepositTransfer([good], expected);
  assert.equal(r.verified, true);
  assert.equal(r.raw_amount, '1250000');
  assert.equal(r.receipt_result, 'SUCCESS');
});

test('deposit verification fails closed without configured contract', () => {
  assert.throws(() => verifyDepositTransfer([good], { ...expected, contract: '' }), /未配置/);
});

test('deposit verification rejects wrong contract, address, amount, decimals and unconfirmed events', () => {
  assert.throws(() => verifyDepositTransfer([{ ...good, contract: 'other' }], expected), /不匹配/);
  assert.throws(() => verifyDepositTransfer([{ ...good, to: 'other' }], expected), /不匹配/);
  assert.throws(() => verifyDepositTransfer([{ ...good, rawAmount: '1250001' }], expected), /不匹配/);
  assert.throws(() => verifyDepositTransfer([{ ...good, decimals: 18 }], expected), /不匹配/);
  assert.throws(() => verifyDepositTransfer([{ ...good, confirmed: false }], expected), /不匹配/);
});

test('deposit verification rejects failed or missing receipt result and malformed transaction hash', () => {
  assert.throws(() => verifyDepositTransfer([{ ...good, receiptResult: 'FAILED' }], expected), /不匹配/);
  assert.throws(() => verifyDepositTransfer([{ ...good, receiptResult: undefined }], expected), /不匹配/);
  assert.throws(() => verifyDepositTransfer([{ ...good, txHash: 'not-a-hash' }], expected), /不匹配/);
});

test('deposit verification rejects ambiguous duplicate matching events', () => {
  assert.throws(() => verifyDepositTransfer([good, good], expected), /多个完全匹配/);
});

test('deposit verification rejects amount precision beyond token decimals', () => {
  assert.throws(() => verifyDepositTransfer([good], { ...expected, amount: '1.0000001' }), /精度/);
});

test('TRON recharge requires a matching chain proof; manual orders stay manual', () => {
  assert.throws(() => assertRechargeCanCredit({ source: 'tron', chain_verified_at: null }), /必须先完成链上核验/);
  const order = {
    source: 'tron', chain_verified_at: '2026-10-15 01:00:00',
    tx_hash: good.txHash, amount: '1.250000',
    chain_verified_json: {
      verified: true, confirmed: true, receipt_result: 'SUCCESS',
      tx_hash: good.txHash, contract: good.contract, to: good.to, decimals: 6,
      raw_amount: '1250000', amount: '1.250000'
    }
  };
  assert.doesNotThrow(() => assertRechargeCanCredit(order, { walletAddress: good.to }));
  assert.throws(() => assertRechargeCanCredit(order, { walletAddress: 'TWrongDepositAddress' }), /核验凭证无效/);
  assert.throws(() => assertRechargeCanCredit({ ...order, chain_verified_json: null }), /核验凭证无效/);
  assert.throws(() => assertRechargeCanCredit({
    ...order, chain_verified_json: { ...order.chain_verified_json, tx_hash: 'not-a-hash' }
  }, { walletAddress: good.to }), /核验凭证无效/);
  assert.throws(() => assertRechargeCanCredit({
    ...order, chain_verified_json: { ...order.chain_verified_json, raw_amount: '1250001' }
  }, { walletAddress: good.to }), /核验凭证无效/);
  assert.throws(() => assertRechargeCanCredit({
    ...order, chain_verified_json: { ...order.chain_verified_json, receipt_result: 'FAILED' }
  }, { walletAddress: good.to }), /核验凭证无效/);
  assert.doesNotThrow(() => assertRechargeCanCredit({ source: 'manual', amount: '1' }));
});
