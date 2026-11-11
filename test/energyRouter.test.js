'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnergyProviderRouter } = require('../src/providers/energyRouter');

function adapter(name, overrides = {}) {
  return {
    name, enabled: true,
    getQuote: async () => ({ price: '1.25', currency: 'USDT', validUntil: new Date(Date.now() + 60000).toISOString() }),
    createOrder: async () => ({ accepted: true, orderId: name + '-order', status: 'processing' }),
    getOrderStatus: async () => ({ status: 'processing' }),
    ...overrides
  };
}

test('provider router sorts valid quotes and ignores invalid/expired adapters', async () => {
  const router = createEnergyProviderRouter({ providers: [
    adapter('expensive', { getQuote: async () => ({ price: '2.00', validUntil: new Date(Date.now() + 60000).toISOString() }) }),
    adapter('cheap', { getQuote: async () => ({ price: '1.00', validUntil: new Date(Date.now() + 60000).toISOString() }) }),
    adapter('expired', { getQuote: async () => ({ price: '0.50', validUntil: new Date(Date.now() - 1000).toISOString() }) })
  ]});
  const result = await router.quotes({ energy: 65000 });
  assert.deepEqual(result.map(x => x.provider), ['cheap', 'expensive']);
});

test('provider router never retries another supplier after ambiguous submission', async () => {
  let secondCalls = 0;
  const first = adapter('first', { createOrder: async () => {
    throw Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT' });
  }});
  const second = adapter('second', { createOrder: async () => {
    secondCalls++;
    return { accepted: true, orderId: 'second-order' };
  }});
  const router = createEnergyProviderRouter({ providers: [first, second] });
  const result = await router.submitWithSafeFailover([
    { provider: 'first', validUntil: new Date(Date.now() + 60000).toISOString(), raw: {} }, { provider: 'second', validUntil: new Date(Date.now() + 60000).toISOString(), raw: {} }
  ], {});
  assert.equal(result.status, 'submission_unknown');
  assert.equal(secondCalls, 0);
});

test('provider router falls back only after definitive rejection', async () => {
  const first = adapter('first', { createOrder: async () => {
    throw Object.assign(new Error('insufficient quota'), { code: 'NO_QUOTA', definitive: true });
  }});
  const second = adapter('second');
  const router = createEnergyProviderRouter({ providers: [first, second] });
  const result = await router.submitWithSafeFailover([
    { provider: 'first', raw: {} }, { provider: 'second', raw: {} }
  ], {});
  assert.equal(result.provider, 'second');
  assert.equal(result.status, 'processing');
});

test('provider router never submits an expired quote and continues to a fresh quote', async () => {
  let firstCalls = 0;
  let secondCalls = 0;
  const first = adapter('expired', { createOrder: async () => { firstCalls++; return { accepted: true, orderId: 'stale' }; } });
  const second = adapter('fresh', { createOrder: async () => { secondCalls++; return { accepted: true, orderId: 'fresh-order' }; } });
  const router = createEnergyProviderRouter({ providers: [first, second], now: () => 1000 });
  const result = await router.submitWithSafeFailover([
    { provider: 'expired', validUntil: new Date(999).toISOString(), raw: {} },
    { provider: 'fresh', validUntil: new Date(2000).toISOString(), raw: {} }
  ], {});
  assert.equal(firstCalls, 0);
  assert.equal(secondCalls, 1);
  assert.equal(result.orderId, 'fresh-order');
});

test('provider router rejects a submission when every quote has expired', async () => {
  let calls = 0;
  const provider = adapter('stale', { createOrder: async () => { calls++; return { accepted: true, orderId: 'must-not-submit' }; } });
  const router = createEnergyProviderRouter({ providers: [provider], now: () => 1000 });
  const result = await router.submitWithSafeFailover([
    { provider: 'stale', validUntil: new Date(999).toISOString(), raw: {} }
  ], {});
  assert.deepEqual(result, { status: 'failed', errorCode: 'PROVIDER_QUOTE_EXPIRED' });
  assert.equal(calls, 0);
});

test('provider circuit breaker opens after repeated provider errors', async () => {
  let now = 1000;
  const bad = adapter('unstable', { getQuote: async () => { throw new Error('offline'); } });
  const router = createEnergyProviderRouter({ providers: [bad], failureThreshold: 2, cooldownMs: 5000, now: () => now });
  await router.quotes({});
  await router.quotes({});
  assert.equal(router.getProviderHealth().unstable.circuitOpen, true);
  now += 5001;
  assert.equal(router.getProviderHealth().unstable.circuitOpen, false);
});
