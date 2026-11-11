'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startLeaseHeartbeat } = require('../src/leaseHeartbeat');

test('lease heartbeat renews periodically and stops cleanly', async () => {
  let renewals = 0;
  const heartbeat = startLeaseHeartbeat({
    renew: async () => { renewals += 1; return true; },
    intervalMs: 1000,
    logger: { warn() {}, error() {} }
  });
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(await heartbeat.stop(), false);
  assert.equal(renewals, 1);
});

test('lease heartbeat reports a rejected renewal as lease loss', async () => {
  let renewals = 0;
  const heartbeat = startLeaseHeartbeat({
    renew: async () => { renewals += 1; return false; },
    intervalMs: 1000,
    logger: { warn() {}, error() {} }
  });
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(await heartbeat.stop(), true);
  assert.equal(renewals, 1);
});
