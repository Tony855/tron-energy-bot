'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'express-five-runtime-test-secret-32-bytes';
process.env.DB_USER = 'ci-test';
process.env.DB_PASSWORD = 'ci-test';
delete process.env.TRON_EVENT_WEBHOOK_SECRET;

const app = require('../src/web');
const { closePool } = require('../src/db');

test.after(async () => { await closePool(); });

test('Express 5 serves health, version, static Mini App, and parameterized admin routes', async t => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    await new Promise(resolve => server.close(() => resolve()));
  });
  const base = 'http://127.0.0.1:' + server.address().port;

  const live = await fetch(base + '/health/live');
  assert.equal(live.status, 200);
  assert.equal((await live.json()).ok, true);

  const version = await fetch(base + '/api/version');
  assert.equal(version.status, 200);
  assert.equal((await version.json()).service, 'tron-energy-bot');

  const miniApp = await fetch(base + '/miniapp/');
  assert.equal(miniApp.status, 200);
  assert.match(miniApp.headers.get('content-type') || '', /text\/html/);

  const admin = await fetch(base + '/api/admins/not-a-number');
  assert.equal(admin.status, 401);
});

test('Express 5 reports malformed JSON with a client error and preserves raw webhook route handling', async t => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    await new Promise(resolve => server.close(() => resolve())));
    await closePool();
  });
  const base = 'http://127.0.0.1:' + server.address().port;

  const malformed = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"username":'
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, '服务器内部错误，请稍后重试');

  const webhook = await fetch(base + '/api/events/tron', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ network: 'mainnet', txHash: 'a'.repeat(64) })
  });
  assert.equal(webhook.status, 503);
  assert.equal((await webhook.json()).error, 'event provider not configured');
});
