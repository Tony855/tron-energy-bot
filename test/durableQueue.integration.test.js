'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { createDurableQueue } = require('../src/durableQueue');
const { createOutbox } = require('../src/outbox');
const { createEventInbox } = require('../src/eventInbox');

test('durable queue supports MySQL idempotency, concurrent claims, lease recovery and dead letters', {
  skip: process.env.MYSQL_INTEGRATION !== '1'
}, async () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 5,
    multipleStatements: true,
    timezone: 'Z'
  });

  try {
    const migration = fs.readFileSync(path.join(__dirname, '../sql/migrate_v4_durable_queue.sql'), 'utf8');
    await pool.query(migration);
    const queue = createDurableQueue({ pool });
    const outbox = createOutbox({ pool });
    const suffix = crypto.randomUUID();
    const txHash = crypto.createHash('sha256').update(suffix).digest('hex');
    const webhookSecret = 'integration-webhook-secret';
    const webhookRaw = Buffer.from(JSON.stringify({ network: 'mainnet', txHash }));
    const webhookSignature = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(webhookRaw).digest('hex');
    const inbox = createEventInbox({ pool, secret: webhookSecret });
    const accepted = await inbox.acceptWebhook(webhookRaw, webhookSignature);
    const duplicateEvent = await inbox.acceptWebhook(webhookRaw, webhookSignature);
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.duplicate, false);
    assert.equal(duplicateEvent.duplicate, true);
    assert.equal(duplicateEvent.eventId, accepted.eventId);
    const [inboxRows] = await pool.execute(
      'SELECT COUNT(*) count FROM event_inbox WHERE provider=? AND provider_event_id=?',
      ['tron', accepted.eventId]
    );
    const [inboxJobs] = await pool.execute(
      'SELECT COUNT(*) count FROM background_jobs WHERE dedupe_key=?',
      ['tron:webhook:' + accepted.eventId]
    );
    assert.equal(Number(inboxRows[0].count), 1);
    assert.equal(Number(inboxJobs[0].count), 1);

    const outboxConn = await pool.getConnection();
    try {
      await outboxConn.beginTransaction();
      await outbox.enqueue(outboxConn, {
        eventKey: 'outbox:' + suffix,
        aggregateType: 'test',
        aggregateId: suffix,
        eventType: 'telegram.send',
        payload: { telegramId: '1', text: 'integration test' }
      });
      await outbox.enqueue(outboxConn, {
        eventKey: 'outbox:' + suffix,
        aggregateType: 'test',
        aggregateId: suffix,
        eventType: 'telegram.send',
        payload: { telegramId: '1', text: 'duplicate should be ignored' }
      });
      await outboxConn.commit();
    } catch (error) {
      await outboxConn.rollback();
      throw error;
    } finally { outboxConn.release(); }
    const outboxItem = await outbox.claim('telegram.send');
    assert.ok(outboxItem);
    assert.equal(outboxItem.payload.text, 'integration test');
    assert.equal(await outbox.delivered({ id: outboxItem.id, leaseToken: outboxItem.lease_token }), true);
    assert.equal(await outbox.delivered({ id: outboxItem.id, leaseToken: outboxItem.lease_token }), false);

    const first = await queue.enqueueJob({
      type: 'test.dedupe',
      payload: { marker: suffix },
      dedupeKey: 'integration:' + suffix
    });
    const duplicate = await queue.enqueueJob({
      type: 'test.dedupe',
      payload: { marker: suffix },
      dedupeKey: 'integration:' + suffix
    });
    assert.equal(duplicate.id, first.id);
    assert.equal(duplicate.duplicate, true);

    const dedupedJob = await queue.claimJob();
    assert.equal(String(dedupedJob.id), String(first.id));
    assert.equal(await queue.completeJob({ id: dedupedJob.id, leaseToken: dedupedJob.lease_token }), true);

    await queue.enqueueJob({ type: 'test.concurrent', payload: { n: 1 }, dedupeKey: 'concurrent-a:' + suffix });
    await queue.enqueueJob({ type: 'test.concurrent', payload: { n: 2 }, dedupeKey: 'concurrent-b:' + suffix });
    const [jobA, jobB] = await Promise.all([queue.claimJob(), queue.claimJob()]);
    assert.ok(jobA && jobB);
    assert.notEqual(String(jobA.id), String(jobB.id));
    assert.equal(await queue.completeJob({ id: jobA.id, leaseToken: jobA.lease_token }), true);
    assert.equal(await queue.completeJob({ id: jobB.id, leaseToken: jobB.lease_token }), true);

    await queue.enqueueJob({ type: 'test.lease', payload: { marker: suffix }, dedupeKey: 'lease:' + suffix });
    const originalLease = await queue.claimJob({ leaseSeconds: 5 });
    await pool.execute(
      'UPDATE background_jobs SET lease_expires_at=DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE id=? AND lease_token=?',
      [originalLease.id, originalLease.lease_token]
    );
    const recoveredLease = await queue.claimJob({ leaseSeconds: 5 });
    assert.equal(String(recoveredLease.id), String(originalLease.id));
    assert.notEqual(recoveredLease.lease_token, originalLease.lease_token);
    assert.equal(await queue.completeJob({ id: originalLease.id, leaseToken: originalLease.lease_token }), false);
    assert.equal(await queue.completeJob({ id: recoveredLease.id, leaseToken: recoveredLease.lease_token }), true);

    await queue.enqueueJob({
      type: 'test.dead-letter',
      payload: { marker: suffix },
      dedupeKey: 'dead-letter:' + suffix,
      maxAttempts: 2
    });
    const attemptOne = await queue.claimJob();
    assert.equal(await queue.failJob({
      id: attemptOne.id,
      leaseToken: attemptOne.lease_token,
      error: { code: 'TEST_RETRY' }
    }), true);
    await pool.execute('UPDATE background_jobs SET available_at=UTC_TIMESTAMP(3) WHERE id=?', [attemptOne.id]);
    const attemptTwo = await queue.claimJob();
    assert.equal(String(attemptTwo.id), String(attemptOne.id));
    assert.equal(await queue.failJob({
      id: attemptTwo.id,
      leaseToken: attemptTwo.lease_token,
      error: { code: 'TEST_FINAL' }
    }), true);
    const [deadRows] = await pool.execute('SELECT status,last_error_code FROM background_jobs WHERE id=?', [attemptOne.id]);
    assert.equal(deadRows[0].status, 'dead');
    assert.equal(deadRows[0].last_error_code, 'TEST_FINAL');
  } finally {
    await pool.end();
  }
});
