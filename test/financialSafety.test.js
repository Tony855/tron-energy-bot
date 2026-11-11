'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const { assertRechargeCanCredit } = require('../src/chainDepositVerify');

test('admin energy refunds use an idempotent ledger posting in the same transaction', () => {
  const web = read('src/web.js');
  assert.match(web, /idempotencyKey:\s*'energy-refund:'\s*\+\s*order\.id/);
  assert.match(web, /entryType:\s*'refund'/);
  assert.match(web, /referenceType:\s*'energy_order'/);
  assert.match(web, /SELECT \* FROM energy_orders WHERE id=\? FOR UPDATE/);
  assert.doesNotMatch(web, /UPDATE users SET balance\s*=\s*balance\s*\+/);
});

test('Mini App refuses to create energy orders when no real supplier is enabled', () => {
  const api = read('src/miniapp-api.js');
  const route = api.slice(api.indexOf("router.post('/buy-energy'"));
  assert.match(route, /const provider = getEnergyProvider\(\)/);
  assert.match(route, /if \(!provider\.enabled\)/);
  assert.ok(route.indexOf('if (!provider.enabled)') < route.indexOf('INSERT INTO energy_orders'));
});


test('legacy admin energy routes require auth and completion is fail-closed', () => {
  const web = read('src/web.js');
  assert.ok(web.includes("app.get('/api/admin/energy-orders', auth,"));
  assert.ok(web.includes("app.post('/api/admin/energy-orders/:id/complete', auth,"));
  assert.ok(web.includes("app.post('/api/admin/energy-orders/:id/refund', auth,"));
  assert.ok(web.includes('订单完成必须经过供应商履约和链上验证'));
});

test('TRON recharge credit requires matching verified receipt proof, not only a timestamp', () => {
  const base = {
    source: 'tron', chain_verified_at: new Date(), tx_hash: 'a'.repeat(64), amount: '1.250000',
    chain_verified_json: {
      verified: true, confirmed: true, receipt_result: 'SUCCESS',
      tx_hash: 'a'.repeat(64), contract: 'TContract', decimals: 6,
      raw_amount: '1250000', amount: '1.250000'
    }
  };
  assert.doesNotThrow(() => assertRechargeCanCredit(base));
  assert.throws(() => assertRechargeCanCredit({ ...base, chain_verified_json: null }));
  assert.throws(() => assertRechargeCanCredit({
    ...base, chain_verified_json: { ...base.chain_verified_json, tx_hash: 'b'.repeat(64) }
  }));
  assert.throws(() => assertRechargeCanCredit({
    ...base, chain_verified_json: { ...base.chain_verified_json, receipt_result: 'FAILED' }
  }));
  assert.doesNotThrow(() => assertRechargeCanCredit({ source: 'manual', amount: '1' }));
});
