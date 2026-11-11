'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createFinanceAudit,
  validatePaidWithdrawalProof
} = require('../src/financeAudit');

const row = overrides => ({
  withdrawal_id: 7,
  amount: '10.250000',
  destination_address: 'TReceiver',
  status: 'paid',
  tx_hash: 'a'.repeat(64),
  chain_verified_at: '2026-11-12T00:00:00.000Z',
  chain_verified_json: {
    contract: 'TContract',
    to: 'TReceiver',
    rawAmount: '10250000',
    receiptResult: 'SUCCESS'
  },
  ...overrides
});

test('paid withdrawal audit accepts a complete matching chain proof', () => {
  assert.equal(validatePaidWithdrawalProof(row(), { contract: 'TContract', decimals: 6 }), true);
});

test('paid withdrawal audit rejects missing proof, timestamp and invalid transaction hash', () => {
  assert.equal(validatePaidWithdrawalProof(row({ chain_verified_json: null })), false);
  assert.equal(validatePaidWithdrawalProof(row({ chain_verified_at: null })), false);
  assert.equal(validatePaidWithdrawalProof(row({ tx_hash: 'x'.repeat(64) })), false);
});

test('paid withdrawal audit rejects recipient, amount, receipt and contract mismatches', () => {
  assert.equal(validatePaidWithdrawalProof(row({
    chain_verified_json: { ...row().chain_verified_json, to: 'TAttacker' }
  }), { contract: 'TContract' }), false);
  assert.equal(validatePaidWithdrawalProof(row({
    chain_verified_json: { ...row().chain_verified_json, rawAmount: '10250001' }
  }), { contract: 'TContract' }), false);
  assert.equal(validatePaidWithdrawalProof(row({
    chain_verified_json: { ...row().chain_verified_json, receiptResult: 'FAILED' }
  }), { contract: 'TContract' }), false);
  assert.equal(validatePaidWithdrawalProof(row(), { contract: 'TOther' }), false);
  // TRON Base58Check addresses are case-sensitive, unlike transaction hashes.
  assert.equal(validatePaidWithdrawalProof(row({
    chain_verified_json: { ...row().chain_verified_json, to: 'treceiver' }
  }), { contract: 'TContract' }), false);
  assert.equal(validatePaidWithdrawalProof(row({
    chain_verified_json: { ...row().chain_verified_json, contract: 'tcontract' }
  }), { contract: 'TContract' }), false);
});

test('finance audit reports missing referral ledger and paid withdrawal proof', async () => {
  const calls = [];
  const responses = [
    [[]], [[]], [[]], [[]], [[]],
    [[row({ chain_verified_json: null })]],
    [[{ commission_id: 9, recharge_order_id: 8, referrer_user_id: 3, amount: '1.000000' }]]
  ];
  const dbPool = {
    async query(sql) {
      calls.push(sql);
      return responses[calls.length - 1];
    }
  };
  const audit = createFinanceAudit({ dbPool, env: { TRON_USDT_CONTRACT: 'TContract', TRON_USDT_DECIMALS: '6' } });
  const result = await audit.runFinanceAudit();
  assert.equal(calls.length, 7);
  assert.equal(result.ok, false);
  assert.equal(result.counts.paid_withdrawal_missing_or_mismatched_chain_proof, 1);
  assert.equal(result.counts.credited_referral_missing_bonus_ledger, 1);
});

test('finance audit fails closed when paid withdrawals exist but trusted proof configuration is missing', async () => {
  const responses = [[[]], [[]], [[]], [[]], [[]], [[row()]], [[]]];
  let index = 0;
  const audit = createFinanceAudit({ dbPool: { async query() { return responses[index++]; } }, env: {} });
  const result = await audit.runFinanceAudit();
  assert.equal(result.ok, false);
  assert.equal(result.counts.paid_withdrawal_audit_configuration_invalid, 1);
  assert.equal(result.counts.paid_withdrawal_missing_or_mismatched_chain_proof, 1);
});

test('finance audit fails closed when any capped finding set is truncated', async () => {
  const overLimit = Array.from({ length: 501 }, (_, i) => ({ user_id: i + 1 }));
  const responses = [
    [overLimit], [[]], [[]], [[]], [[]], [[]], [[]]
  ];
  let index = 0;
  const audit = createFinanceAudit({
    dbPool: { async query() { return responses[index++]; } },
    env: {}
  });
  const result = await audit.runFinanceAudit();
  assert.equal(result.ok, false);
  assert.equal(result.counts.audit_result_truncated, 1);
  assert.equal(result.findings.audit_result_truncated[0].check, 'balance_ledger_mismatch');
});
