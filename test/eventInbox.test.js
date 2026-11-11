'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { parseWebhook, createEventInbox } = require('../src/eventInbox');

function signed(raw, secret) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
}

function fakePool({ existingHash = null, existingPayload = { txHash: 'c'.repeat(64) }, inserted = false } = {}) {
  const state = { storedHash: null, jobInserts: 0, commits: 0, rollbacks: 0 };
  const connection = {
    async beginTransaction() {},
    async commit() { state.commits += 1; },
    async rollback() { state.rollbacks += 1; },
    release() {},
    async execute(sql, params) {
      if (sql.includes('INSERT IGNORE INTO event_inbox')) {
        state.storedHash = params[1];
        return [{ affectedRows: inserted ? 1 : 0, insertId: inserted ? 42 : 0 }, undefined];
      }
      if (sql.includes('SELECT id,status,body_sha256')) {
        return [[{ id: 42, status: 'received', body_sha256: existingHash ?? state.storedHash, payload_json: JSON.stringify(existingPayload) }], undefined];
      }
      if (sql.includes('UPDATE event_inbox SET body_sha256=?')) {\n        state.normalizedHash = params[0];\n        return [{ affectedRows: 1 }, undefined];\n      }\n      if (sql.includes('INSERT IGNORE INTO background_jobs')) {
        state.jobInserts += 1;
        return [{ affectedRows: 1, insertId: 99 }, undefined];
      }
      throw new Error('Unexpected SQL in fake pool: ' + sql);
    }
  };
  return { state, getConnection: async () => connection };
}

test('TRON webhook parser requires a valid HMAC and normalizes transaction identity', () => {
  const raw = Buffer.from(JSON.stringify({ network: 'mainnet', txHash: 'A'.repeat(64), amount: '999999999' }));
  const secret = 'unit-test-webhook-secret';
  const signature = signed(raw, secret);
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
  const signature = signed(badRaw, secret);
  assert.throws(() => parseWebhook(badRaw, signature, secret), error => error.status === 400);
});

test('duplicate webhook retries compare a canonical business payload, not raw JSON formatting', async () => {
  const secret = 'unit-test-webhook-secret';
  const txHash = 'c'.repeat(64);
  const retry = Buffer.from('{\n  "network": "mainnet",\n  "txHash": "' + txHash + '",\n  "providerNoise": "two"\n}');
  const canonicalHash = crypto.createHash('sha256')
    .update(JSON.stringify({ network: 'mainnet', txHash })).digest('hex');
  const pool = fakePool({ existingHash: canonicalHash });
  const inbox = createEventInbox({ pool, secret });
  const result = await inbox.acceptWebhook(retry, signed(retry, secret));
  assert.equal(result.accepted, true);
  assert.equal(result.duplicate, true);
  assert.equal(pool.state.storedHash, canonicalHash);
  assert.equal(pool.state.jobInserts, 1);
  assert.equal(pool.state.commits, 1);
});


test('legacy raw-body digests are normalized after the stored business payload is verified', async () => {
  const secret = 'unit-test-webhook-secret';
  const txHash = 'f'.repeat(64);
  const raw = Buffer.from(JSON.stringify({ network: 'mainnet', txHash }));
  const canonicalHash = crypto.createHash('sha256')
    .update(JSON.stringify({ network: 'mainnet', txHash })).digest('hex');
  const pool = fakePool({ existingHash: '1'.repeat(64), existingPayload: { txHash } });
  const inbox = createEventInbox({ pool, secret });
  const result = await inbox.acceptWebhook(raw, signed(raw, secret));
  assert.equal(result.duplicate, true);
  assert.equal(pool.state.normalizedHash, canonicalHash);
  assert.equal(pool.state.jobInserts, 1);
});
\ntest('webhook inbox rejects an existing event ID with a mismatched canonical payload hash', async () => {
  const secret = 'unit-test-webhook-secret';
  const raw = Buffer.from(JSON.stringify({ network: 'mainnet', txHash: 'd'.repeat(64) }));
  const pool = fakePool({ existingHash: '0'.repeat(64), existingPayload: { txHash: 'e'.repeat(64) } });
  const inbox = createEventInbox({ pool, secret });
  await assert.rejects(
    inbox.acceptWebhook(raw, signed(raw, secret)),
    error => error.code === 'WEBHOOK_INBOX_CONFLICT'
  );
  assert.equal(pool.state.jobInserts, 0);
  assert.equal(pool.state.commits, 0);
  assert.equal(pool.state.rollbacks, 1);
});
