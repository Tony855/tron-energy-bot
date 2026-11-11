'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startWorker, processPendingOrders } = require('../src/energy-worker');

test('legacy energy worker fails closed instead of mutating customer balances', async () => {
  assert.throws(startWorker, error => error.code === 'LEGACY_ENERGY_WORKER_DISABLED');
  await assert.rejects(processPendingOrders(), error => error.code === 'LEGACY_ENERGY_WORKER_DISABLED');
});
