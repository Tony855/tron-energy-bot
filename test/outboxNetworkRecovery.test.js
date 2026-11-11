'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { dispatchOutboxOnce } = require('../src/outboxDispatcher');

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close(error => error ? reject(error) : resolve());
  });
}

test('outbox survives a real TCP outage and delivers after the HTTP endpoint returns', {
  timeout: 5000
}, async () => {
  const events = [];
  let claims = 0;
  const outbox = {
    async claim() {
      claims += 1;
      return { id: 91, lease_token: 'network-lease-' + claims, payload: { event: 'notification' } };
    },
    async renew() { return true; },
    async delivered(value) { events.push(['delivered', value]); return true; },
    async failed(value) { events.push(['failed', value.error.code || value.error.name]); return true; }
  };
  let server = http.createServer((_req, res) => { res.writeHead(204); res.end(); });
  const port = await listen(server);
  await close(server);

  const deliver = async () => {
    const response = await fetch('http://127.0.0.1:' + port + '/deliver', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'notification' })
    });
    if (!response.ok) throw new Error('DELIVERY_HTTP_' + response.status);
  };
  const logger = { warn() {}, error() {} };

  await dispatchOutboxOnce({ outbox, eventType: 'telegram.send', deliver, logger });
  assert.equal(events[0][0], 'failed');
  assert.ok(['ECONNREFUSED', 'TypeError'].includes(events[0][1]));

  server = http.createServer((_req, res) => { res.writeHead(204); res.end(); });
  await listen(server, port);
  try {
    await dispatchOutboxOnce({ outbox, eventType: 'telegram.send', deliver, logger });
    assert.equal(events[1][0], 'delivered');
    assert.equal(events[1][1].id, 91);
    assert.equal(claims, 2);
  } finally {
    await close(server);
  }
});
