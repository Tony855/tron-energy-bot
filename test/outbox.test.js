'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOutbox } = require('../src/outbox');

test('outbox requires a database pool and validates claim contracts', async () => {
  assert.throws(() => createOutbox(), /pool is required/);
  let calls = 0;
  const pool = {
    async execute() {
      calls += 1;
      return [{ affectedRows: 0 }, []];
    }
  };
  const outbox = createOutbox({ pool });
  await assert.rejects(outbox.claim('../invalid'), /Invalid event type/);
  await assert.rejects(outbox.claim('telegram.send', 0), /leaseSeconds/);
  await assert.rejects(outbox.claim('telegram.send', 4), /leaseSeconds/);
  await assert.rejects(outbox.claim('telegram.send', 3601), /leaseSeconds/);
  await assert.rejects(outbox.claim('telegram.send', 5.5), /leaseSeconds/);
  assert.equal(calls, 0);
  assert.equal(await outbox.claim('telegram.send', 5), null);
  assert.equal(calls, 2);
});

test('outbox renews only a still-live lease owned by the current token', async () => {
  const calls = [];
  const pool = { async execute(sql, params) { calls.push({ sql, params }); return [{ affectedRows: 1 }]; } };
  const outbox = createOutbox({ pool });
  assert.equal(await outbox.renew({ id: 11, leaseToken: 'outbox-lease', leaseSeconds: 75 }), true);
  assert.match(calls[0].sql, /lease_expires_at>UTC_TIMESTAMP/);
  assert.deepEqual(calls[0].params, [75, 11, 'outbox-lease']);
});
