'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDurableQueue, retryDelaySeconds, safeErrorCode } = require('../src/durableQueue');

test('retry delay is exponential, jittered, and capped', () => {
  assert.equal(retryDelaySeconds(1, () => 0), 2);
  assert.equal(retryDelaySeconds(2, () => 0), 4);
  assert.equal(retryDelaySeconds(10, () => 0.99), 1277);
  assert.equal(retryDelaySeconds(100, () => 0.99), 1277);
});

test('error codes are normalized and never include arbitrary error text', () => {
  assert.equal(safeErrorCode({ code: 'ETIMEDOUT', message: 'sensitive URL token=secret' }), 'ETIMEDOUT');
  assert.equal(safeErrorCode({ code: 'bad value', message: 'secret' }), 'JOB_FAILED');
  assert.equal(safeErrorCode(null), 'JOB_FAILED');
});

test('queue requires a database pool and validates job contracts', async () => {
  assert.throws(() => createDurableQueue(), /pool is required/);
  const calls = [];
  const pool = {
    async execute(sql, params) {
      calls.push({ sql, params });
      return [{ insertId: 7, affectedRows: 1 }];
    }
  };
  const queue = createDurableQueue({ pool });
  await assert.rejects(queue.enqueueJob({ type: '../unsafe', payload: {} }), /Invalid job type/);
  await assert.rejects(queue.enqueueJob({ type: 'deposit.verify', payload: [] }), /payload/);
  await assert.rejects(queue.enqueueJob({ type: 'deposit.verify', payload: {}, maxAttempts: 0 }), /maxAttempts/);
  await assert.rejects(queue.enqueueJob({ type: 'deposit.verify', payload: {}, dedupeKey: 'x'.repeat(191) }), /dedupeKey/);
  const result = await queue.enqueueJob({ type: 'deposit.verify', payload: { txHash: 'abc' }, dedupeKey: 'deposit:abc' });
  assert.equal(result.id, 7);
  assert.equal(calls.length, 1);
});


test('renewJob extends only the current live lease token', async () => {
  const calls = [];
  const pool = { async execute(sql, params) { calls.push({ sql, params }); return [{ affectedRows: 1 }]; } };
  const queue = createDurableQueue({ pool });
  assert.equal(await queue.renewJob({ id: 9, leaseToken: 'lease-9', leaseSeconds: 120 }), true);
  assert.match(calls[0].sql, /lease_expires_at>UTC_TIMESTAMP/);
  assert.match(calls[0].sql, /lease_token=\?/);
  assert.deepEqual(calls[0].params, [120, 9, 'lease-9']);
});
