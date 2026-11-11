'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeTrc20 } = require('../src/monitor');

const root = path.join(__dirname, '..');
const wallet = { address: 'TWalletCaseSensitive' };
const transfer = overrides => ({
  transaction_id: 'a'.repeat(64),
  event_index: 3,
  token_info: { address: 'TContractCaseSensitive', decimals: 6 },
  from: 'TSenderCaseSensitive',
  to: wallet.address,
  value: '1250000',
  block_timestamp: 1790000000000,
  ...overrides
});

test('TRC20 scanner accepts only exact configured contract, Base58 addresses and token decimals', () => {
  const previousContract = process.env.TRON_USDT_CONTRACT;
  const previousDecimals = process.env.TRON_USDT_DECIMALS;
  process.env.TRON_USDT_CONTRACT = 'TContractCaseSensitive';
  process.env.TRON_USDT_DECIMALS = '6';
  try {
    const valid = normalizeTrc20({ data: [transfer()] }, wallet);
    assert.equal(valid.length, 1);
    assert.equal(valid[0].amount, '1.25');

    assert.deepEqual(normalizeTrc20({ data: [transfer({
      token_info: { address: 'tContractCaseSensitive', decimals: 6 }
    })] }, wallet), []);
    assert.deepEqual(normalizeTrc20({ data: [transfer({
      to: 'tWalletCaseSensitive'
    })] }, wallet), []);
    assert.deepEqual(normalizeTrc20({ data: [transfer({
      token_info: { address: 'TContractCaseSensitive', decimals: 18 }
    })] }, wallet), []);
  } finally {
    if (previousContract === undefined) delete process.env.TRON_USDT_CONTRACT;
    else process.env.TRON_USDT_CONTRACT = previousContract;
    if (previousDecimals === undefined) delete process.env.TRON_USDT_DECIMALS;
    else process.env.TRON_USDT_DECIMALS = previousDecimals;
  }
});

test('webhook worker uses exact Base58 address lookup rather than case-folded SQL', () => {
  const source = fs.readFileSync(path.join(root, 'src/worker.js'), 'utf8');
  assert.match(source, /address IN \(\?,\?\)/);
  assert.doesNotMatch(source, /LOWER\(address\)/);
  assert.match(source, /String\(transfer\.to\) === String\(wallet\.address\)/);
  assert.match(source, /String\(transfer\.contract\) !== contract/);
});

test('polling monitor and historical backfill fail closed on address, contract or decimal mismatch', () => {
  const monitor = fs.readFileSync(path.join(root, 'src/monitor.js'), 'utf8');
  const backfill = fs.readFileSync(path.join(root, 'src/chainBackfill.js'), 'utf8');
  assert.match(monitor, /contract !== configuredContract/);
  assert.match(monitor, /from !== wallet\.address && to !== wallet\.address/);
  assert.match(monitor, /decimals !== configuredDecimals/);
  assert.match(backfill, /!configuredContract \|\| contract !== configuredContract/);
  assert.match(backfill, /to !== wallet\.address && from !== wallet\.address/);
  assert.match(backfill, /decimals !== configuredDecimals/);
});
