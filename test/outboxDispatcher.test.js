'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { dispatchOutboxOnce } = require('../src/outboxDispatcher');

function fakeOutbox(item = { id: 7, lease_token: 'lease-a', payload: {} }) {
  const calls = [];
  return {
    calls,
    async claim(type, leaseSeconds) { calls.push(['claim', type, leaseSeconds]); return item; },
    async delivered(value) { calls.push(['delivered', value]); return true; },
    async failed(value) { calls.push(['failed', value]); return true; }
  };
}

test('outbox dispatcher acknowledges a successfully delivered item with its lease token', async () => {
  const outbox = fakeOutbox();
  let delivered;
  const worked = await dispatchOutboxOnce({
    outbox, eventType: 'telegram.send',
    deliver: async item => { delivered = item; },
    logger: { warn() {}, error() {} }
  });
  assert.equal(worked, true);
  assert.equal(delivered.id, 7);
  assert.deepEqual(outbox.calls.map(x => x[0]), ['claim', 'delivered']);
  assert.deepEqual(outbox.calls[1][1], { id: 7, leaseToken: 'lease-a' });
});

test('outbox dispatcher records transport failure for retry and does not acknowledge delivery', async () => {
  const outbox = fakeOutbox();
  const failure = Object.assign(new Error('transport unavailable'), { code: 'UPSTREAM_TIMEOUT' });
  const logged = [];
  const worked = await dispatchOutboxOnce({
    outbox, eventType: 'socket.emit',
    deliver: async () => { throw failure; },
    logger: { warn() {}, error(...args) { logged.push(args); } }
  });
  assert.equal(worked, true);
  assert.deepEqual(outbox.calls.map(x => x[0]), ['claim', 'failed']);
  assert.equal(outbox.calls[1][1].leaseToken, 'lease-a');
  assert.equal(outbox.calls[1][1].error.code, 'UPSTREAM_TIMEOUT');
  assert.equal(logged.length, 1);
});

test('outbox dispatcher returns false when there is no pending item', async () => {
  const outbox = fakeOutbox(null);
  const worked = await dispatchOutboxOnce({
    outbox, eventType: 'telegram.send', deliver: async () => {},
    logger: { warn() {}, error() {} }
  });
  assert.equal(worked, false);
  assert.deepEqual(outbox.calls.map(x => x[0]), ['claim']);
});

test('outbox dispatcher reports a lost acknowledgement without attempting a second delivery', async () => {
  const outbox = fakeOutbox();
  outbox.delivered = async value => { outbox.calls.push(['delivered', value]); return false; };
  const warnings = [];
  let attempts = 0;
  await dispatchOutboxOnce({
    outbox, eventType: 'telegram.send',
    deliver: async () => { attempts += 1; },
    logger: { warn(...args) { warnings.push(args); }, error() {} }
  });
  assert.equal(attempts, 1);
  assert.equal(warnings.length, 1);
  assert.deepEqual(outbox.calls.map(x => x[0]), ['claim', 'delivered']);
});
