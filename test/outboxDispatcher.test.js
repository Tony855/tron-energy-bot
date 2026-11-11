'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { dispatchOutboxOnce } = require('../src/outboxDispatcher');

function fakeOutbox(item = { id: 7, lease_token: 'lease-a', payload: {} }) {
  const calls = [];
  return {
    calls,
    async claim(type, leaseSeconds) { calls.push(['claim', type, leaseSeconds]); return item; },
    async renew(value) { calls.push(['renew', value]); return true; },
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


test('outbox retries a transient transport outage and succeeds on a later lease', async () => {
  const outbox = fakeOutbox();
  const deliveredIds = [];
  let transportOnline = false;
  let claimCount = 0;
  outbox.claim = async () => {
    claimCount += 1;
    return { id: 7, lease_token: 'lease-' + claimCount, payload: { attempt: claimCount } };
  };
  const deliver = async item => {
    if (!transportOnline) throw Object.assign(new Error('network partition'), { code: 'ECONNRESET' });
    deliveredIds.push(item.id);
  };
  await dispatchOutboxOnce({ outbox, eventType: 'socket.emit', deliver, logger: { warn() {}, error() {} } });
  assert.equal(outbox.calls.at(-1)[0], 'failed');
  transportOnline = true;
  await dispatchOutboxOnce({ outbox, eventType: 'socket.emit', deliver, logger: { warn() {}, error() {} } });
  assert.deepEqual(deliveredIds, [7]);
  assert.equal(outbox.calls.at(-1)[0], 'delivered');
  assert.equal(claimCount, 2);
});
