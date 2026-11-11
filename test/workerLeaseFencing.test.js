'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { updateInboxStatusWithLease } = require('../src/worker');

test('Inbox status transition requires a live matching background job lease', async () => {
  const calls = [];
  const dbPool = { async execute(sql, params) {
    calls.push({ sql, params });
    return [{ affectedRows: 1 }];
  } };
  const changed = await updateInboxStatusWithLease(dbPool, {
    inboxId: 44, jobId: 55, leaseToken: 'lease-token-55', status: 'processed'
  });
  assert.equal(changed, true);
  assert.match(calls[0].sql, /EXISTS/);
  assert.match(calls[0].sql, /j\.lease_token=\?/);
  assert.match(calls[0].sql, /j\.lease_expires_at>UTC_TIMESTAMP/);
  assert.deepEqual(calls[0].params, ['processed', null, 'processed', 'processed', 44, 55, 'lease-token-55']);
});

test('stale or expired job lease cannot advance Inbox status', async () => {
  const dbPool = { async execute() { return [{ affectedRows: 0 }]; } };
  const changed = await updateInboxStatusWithLease(dbPool, {
    inboxId: 44, jobId: 55, leaseToken: 'stale-token', status: 'processed'
  });
  assert.equal(changed, false);
});
