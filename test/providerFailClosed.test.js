'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EnergyProvider, getEnergyProvider } = require('../src/providers/energyProvider');

test('supplier integration remains explicitly disabled without a real supplier adapter', async () => {
  const provider = getEnergyProvider();
  assert.ok(provider instanceof EnergyProvider);
  assert.equal(provider.enabled, false);
  assert.equal(provider.name, 'disabled');
  await assert.rejects(provider.getQuote({}), error => error.message === 'ENERGY_PROVIDER_NOT_CONFIGURED');
  await assert.rejects(provider.createOrder({}), error => error.message === 'ENERGY_PROVIDER_NOT_CONFIGURED');
  await assert.rejects(provider.getOrderStatus({}), error => error.message === 'ENERGY_PROVIDER_NOT_CONFIGURED');
  await assert.rejects(provider.cancelOrder({}), error => error.message === 'ENERGY_PROVIDER_NOT_CONFIGURED');
});
