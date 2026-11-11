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


test('claimJob retries MariaDB deadlocks and lock wait timeouts with bounded backoff', async () => {
  const calls = [];
  const delays = [];
  let attempt = 0;
  const pool = {
    async execute(sql, params) {
      calls.push({ sql, params });
      attempt++;
      if (attempt === 1 || attempt === 3) {
        const error = new Error('transient database contention');
        error.code = attempt === 1 ? 'ER_LOCK_DEADLOCK' : 'ER_LOCK_WAIT_TIMEOUT';
        throw error;
      }
      if (attempt === 4) return [{ affectedRows: 1 }, []];
      if (attempt === 5) return [[{ id: 99, job_type: 'test.retry', payload_json: '{}', attempts: 1, max_attempts: 8, lease_token: 'lease-token' }], []];
      return [{ affectedRows: 0 }, []];
    }
  };
  const queue = createDurableQueue({
    pool,
    uuid: () => 'lease-token',
    sleep: async ms => { delays.push(ms); }
  });
  const job = await queue.claimJob();
  assert.equal(job.id, 99);
  assert.deepEqual(delays, [10, 10]);
  assert.equal(calls.length, 5);
  assert.match(calls[0].sql, /status='dead'/);
  assert.match(calls[1].sql, /status='dead'/);
  assert.match(calls[2].sql, /status='processing'/);
  assert.match(calls[3].sql, /status='processing'/);
});

test('claimJob does not retry non-transient database errors', async () => {
  let calls = 0;
  const pool = {
    async execute() {
      calls++;
      const error = new Error('invalid SQL');
      error.code = 'ER_PARSE_ERROR';
      throw error;
    }
  };
  const queue = createDurableQueue({ pool, sleep: async () => assert.fail('must not sleep') });
  await assert.rejects(queue.claimJob(), { code: 'ER_PARSE_ERROR' });
  assert.equal(calls, 1);
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
