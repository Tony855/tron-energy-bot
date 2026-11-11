'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { canTransition, assertTransition, transitionEnergyOrder } = require('../src/energyOrderState');

test('energy order state machine rejects skipped or backward transitions', () => {
  assert.equal(canTransition('pending_provider', 'submitting'), true);
  assert.equal(canTransition('submitting', 'submission_unknown'), true);
  assert.equal(canTransition('submission_unknown', 'processing'), true);
  assert.equal(canTransition('processing', 'completed'), true);
  assert.equal(canTransition('failed', 'refunded'), true);
  assert.equal(canTransition('completed', 'refunded'), false);
  assert.equal(canTransition('submission_unknown', 'refunded'), false);
  assert.throws(() => assertTransition('completed', 'processing'), { code: 'ENERGY_ORDER_TRANSITION_NOT_ALLOWED' });
});

test('energy state transition uses compare-and-set and writes outbox in caller transaction', async () => {
  const calls = [];
  const conn = { execute: async (sql, params) => {
    calls.push({ sql, params });
    return [{ affectedRows: 1 }, []];
  }};
  const result = await transitionEnergyOrder(conn, {
    id: 42, expectedStatus: 'processing', nextStatus: 'completed',
    providerName: 'supplier-a', providerOrderId: 'external-1', txHash: 'a'.repeat(64)
  });
  assert.deepEqual(result, { id: 42, status: 'completed' });
  assert.match(calls[0].sql, /WHERE id=\? AND status=\?/);
  assert.match(calls[1].sql, /INSERT IGNORE INTO event_outbox/);
  assert.equal(calls[1].params[0], 'energy-order:42:processing:completed');
});

test('energy state transition refuses concurrent stale updates', async () => {
  const conn = { execute: async () => [{ affectedRows: 0 }, []] };
  await assert.rejects(() => transitionEnergyOrder(conn, {
    id: 7, expectedStatus: 'processing', nextStatus: 'failed'
  }), { code: 'ENERGY_ORDER_STATE_CONFLICT' });
});
