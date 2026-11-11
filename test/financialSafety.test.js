'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

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
