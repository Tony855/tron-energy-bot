'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { parseWebhook } = require('../src/eventInbox');

test('TRON webhook parser requires a valid HMAC and normalizes transaction identity', () => {
  const raw = Buffer.from(JSON.stringify({ network: 'mainnet', txHash: 'A'.repeat(64), amount: '999999999' }));
  const secret = 'unit-test-webhook-secret';
  const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const parsed = parseWebhook(raw, signature, secret);
  assert.equal(parsed.txHash, 'a'.repeat(64));
  assert.equal(parsed.network, 'mainnet');
  assert.match(parsed.providerEventId, /^[a-f0-9]{64}$/);
  assert.equal(parseWebhook(raw, signature, secret).providerEventId, parsed.providerEventId);
});

test('TRON webhook parser rejects bad signatures and malformed event envelopes', () => {
  const raw = Buffer.from(JSON.stringify({ network: 'mainnet', txHash: 'b'.repeat(64) }));
  assert.throws(() => parseWebhook(raw, 'sha256=' + '0'.repeat(64), 'secret'), error => error.status === 401);
  const secret = 'unit-test-webhook-secret';
  const badRaw = Buffer.from(JSON.stringify({ network: 'shasta', txHash: 'b'.repeat(64) }));
  const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(badRaw).digest('hex');
  assert.throws(() => parseWebhook(badRaw, signature, secret), error => error.status === 400);
});
