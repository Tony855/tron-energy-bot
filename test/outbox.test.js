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
