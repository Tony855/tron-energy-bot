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
    // Simulate an existing installation before applying the additive V4 migration.
    await pool.query(`CREATE TABLE energy_orders (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      status ENUM('pending_provider','processing','completed','failed','refunded')
        NOT NULL DEFAULT 'pending_provider'
    ) ENGINE=InnoDB`);
    const migration = fs.readFileSync(path.join(__dirname, '../sql/migrate_v4_durable_queue.sql'), 'utf8');
    await pool.query(migration);
    await pool.query(migration); // migration must be repeatable
    const [energyStatusColumns] = await pool.query("SHOW COLUMNS FROM energy_orders LIKE 'status'");
    assert.match(energyStatusColumns[0].Type, /submission_unknown/);
    assert.match(energyStatusColumns[0].Type, /cancelled/);
    await pool.query(`CREATE TABLE users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      balance DECIMAL(30,6) NOT NULL DEFAULT 0
    ) ENGINE=InnoDB`);
    await pool.query(`CREATE TABLE ledger_entries (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED NOT NULL,
      entry_type ENUM('deposit','referral_bonus','energy_order_debit','refund','admin_adjustment') NOT NULL,
      amount DECIMAL(30,6) NOT NULL,
      balance_after DECIMAL(30,6) NOT NULL,
      reference_type VARCHAR(32) NOT NULL,
      reference_id BIGINT UNSIGNED NOT NULL,
      idempotency_key VARCHAR(190) NOT NULL UNIQUE,
      note VARCHAR(500) NULL
    ) ENGINE=InnoDB`);
    const { postBalanceEntry } = require('../src/ledger');
    const [seedUser] = await pool.execute('INSERT INTO users (balance) VALUES (10.000000)');
    const ledgerUserId = seedUser.insertId;
    const postInTransaction = async input => {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const result = await postBalanceEntry(conn, input);
        await conn.commit();
        return result;
      } catch (error) {
        await conn.rollback();
        throw error;
      } finally { conn.release(); }
    };
    const sameKeyInput = {
      userId: ledgerUserId, delta: '2.000000', entryType: 'deposit',
      referenceType: 'recharge', referenceId: 1001,
      idempotencyKey: 'integration-ledger-replay:' + crypto.randomUUID()
    };
    const replayResults = await Promise.all(
      Array.from({ length: 16 }, () => postInTransaction(sameKeyInput))
    );
    assert.equal(replayResults.filter(x => x.posted).length, 1);
    assert.equal(replayResults.filter(x => x.duplicate).length, 15);
    await assert.rejects(() => postInTransaction({
      ...sameKeyInput, referenceId: 9999
    }), /幂等键已存在，但用户或金额不一致/);
    await assert.rejects(() => postInTransaction({
      ...sameKeyInput, entryType: 'refund'
    }), /幂等键已存在，但用户或金额不一致/);
    const [afterReplay] = await pool.execute('SELECT CAST(balance AS CHAR) balance FROM users WHERE id=?', [ledgerUserId]);
    assert.equal(Number(afterReplay[0].balance), 12);
    const debitKey = 'integration-concurrent-debit:' + crypto.randomUUID();
    const debitResults = await Promise.allSettled([
      postInTransaction({
        userId: ledgerUserId, delta: '-7.000000', entryType: 'energy_order_debit',
        referenceType: 'energy_order', referenceId: 2001, idempotencyKey: debitKey + ':a'
      }),
      postInTransaction({
        userId: ledgerUserId, delta: '-7.000000', entryType: 'energy_order_debit',
        referenceType: 'energy_order', referenceId: 2002, idempotencyKey: debitKey + ':b'
      })
    ]);
    assert.equal(debitResults.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(debitResults.filter(x => x.status === 'rejected').length, 1);
    const [afterDebit] = await pool.execute('SELECT CAST(balance AS CHAR) balance FROM users WHERE id=?', [ledgerUserId]);
    assert.equal(Number(afterDebit[0].balance), 5);
    const refundKey = 'integration-refund:' + crypto.randomUUID();
    const refundInput = {
      userId: ledgerUserId, delta: '7.000000', entryType: 'refund',
      referenceType: 'energy_order', referenceId: 2001, idempotencyKey: refundKey
    };
    const refunds = await Promise.all([
      postInTransaction(refundInput), postInTransaction(refundInput)
    ]);
    assert.equal(refunds.filter(x => x.posted).length, 1);
    assert.equal(refunds.filter(x => x.duplicate).length, 1);
    const [afterRefund] = await pool.execute('SELECT CAST(balance AS CHAR) balance FROM users WHERE id=?', [ledgerUserId]);
    assert.equal(Number(afterRefund[0].balance), 12);

    const queue = createDurableQueue({ pool });
    const outbox = createOutbox({ pool });
    const suffix = crypto.randomUUID();
    const txHash = crypto.createHash('sha256').update(suffix).digest('hex');
    const webhookSecret = 'integration-webhook-secret';
    const webhookRaw = Buffer.from(JSON.stringify({ network: 'mainnet', txHash }));
    const webhookSignature = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(webhookRaw).digest('hex');
    const inbox = createEventInbox({ pool, secret: webhookSecret });
    const webhookBurst = await Promise.all(
      Array.from({ length: 16 }, () => inbox.acceptWebhook(webhookRaw, webhookSignature))
    );
    const accepted = webhookBurst.filter(result => result.accepted && !result.duplicate);
    const duplicateEvents = webhookBurst.filter(result => result.accepted && result.duplicate);
    assert.equal(accepted.length, 1, 'exactly one concurrent webhook should create the Inbox event');
    assert.equal(duplicateEvents.length, 15, 'all competing webhooks should be acknowledged as duplicates');
    assert.ok(webhookBurst.every(result => result.eventId === accepted[0].eventId));
    const replayRaw = Buffer.from(JSON.stringify({ network: 'mainnet', txHash, amount: '999999999', retry: true }));
    const replaySignature = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(replayRaw).digest('hex');
    const replayResult = await inbox.acceptWebhook(replayRaw, replaySignature);
    assert.equal(replayResult.duplicate, true);
    assert.equal(replayResult.eventId, accepted[0].eventId);
    const [inboxRows] = await pool.execute(
      'SELECT COUNT(*) count FROM event_inbox WHERE provider=? AND provider_event_id=?',
      ['tron', accepted[0].eventId]
    );
    const [inboxJobs] = await pool.execute(
      'SELECT COUNT(*) count FROM background_jobs WHERE dedupe_key=?',
      ['tron:webhook:' + accepted[0].eventId]
    );
    assert.equal(Number(inboxRows[0].count), 1);
    assert.equal(Number(inboxJobs[0].count), 1);
    await pool.execute('DELETE FROM background_jobs WHERE dedupe_key=?', ['tron:webhook:' + accepted[0].eventId]);
    await pool.execute('DELETE FROM event_inbox WHERE provider=? AND provider_event_id=?', ['tron', accepted[0].eventId]);

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

    const leaseConn = await pool.getConnection();
    const leaseKey = 'outbox-lease:' + suffix;
    await leaseConn.beginTransaction();
    await outbox.enqueue(leaseConn, {
      eventKey: leaseKey, aggregateType: 'test', aggregateId: suffix,
      eventType: 'telegram.send', payload: { telegramId: '1', text: 'lease recovery' }
    });
    await leaseConn.commit();
    const leaseOne = await outbox.claim('telegram.send', 5);
    assert.equal(leaseOne.payload.text, 'lease recovery');
    await pool.execute(
      'UPDATE event_outbox SET lease_expires_at=DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE id=?',
      [leaseOne.id]
    );
    const leaseTwo = await outbox.claim('telegram.send', 5);
    assert.equal(String(leaseTwo.id), String(leaseOne.id));
    assert.notEqual(leaseTwo.lease_token, leaseOne.lease_token);
    assert.equal(await outbox.delivered({ id: leaseOne.id, leaseToken: leaseOne.lease_token }), false);
    assert.equal(await outbox.delivered({ id: leaseTwo.id, leaseToken: leaseTwo.lease_token }), true);

    const deadKey = 'outbox-dead:' + suffix;
    await leaseConn.beginTransaction();
    await outbox.enqueue(leaseConn, {
      eventKey: deadKey, aggregateType: 'test', aggregateId: suffix,
      eventType: 'telegram.send', payload: { telegramId: '1', text: 'dead letter' }
    });
    await leaseConn.commit();
    await pool.execute('UPDATE event_outbox SET attempts=11 WHERE event_key=?', [deadKey]);
    const finalAttempt = await outbox.claim('telegram.send', 5);
    assert.equal(finalAttempt.payload.text, 'dead letter');
    assert.equal(await outbox.failed({
      id: finalAttempt.id, leaseToken: finalAttempt.lease_token,
      error: { code: 'TEST_FINAL_DELIVERY' }
    }), true);
    const [deadOutbox] = await pool.execute('SELECT status,last_error_code FROM event_outbox WHERE event_key=?', [deadKey]);
    assert.equal(deadOutbox[0].status, 'dead');
    assert.equal(deadOutbox[0].last_error_code, 'TEST_FINAL_DELIVERY');

    const retryKey = 'outbox-retry:' + suffix;
    await leaseConn.beginTransaction();
    await outbox.enqueue(leaseConn, {
      eventKey: retryKey, aggregateType: 'test', aggregateId: suffix,
      eventType: 'telegram.send', payload: { telegramId: '1', text: 'retry delivery' }
    });
    await leaseConn.commit();
    const failedAttempt = await outbox.claim('telegram.send', 5);
    assert.equal(failedAttempt.payload.text, 'retry delivery');
    assert.equal(await outbox.failed({
      id: failedAttempt.id, leaseToken: failedAttempt.lease_token,
      error: { code: 'TEST_TRANSIENT_FAILURE' }
    }), true);
    const [retryPending] = await pool.execute('SELECT status,last_error_code FROM event_outbox WHERE event_key=?', [retryKey]);
    assert.equal(retryPending[0].status, 'pending');
    assert.equal(retryPending[0].last_error_code, 'TEST_TRANSIENT_FAILURE');
    await pool.execute('UPDATE event_outbox SET available_at=UTC_TIMESTAMP(3) WHERE event_key=?', [retryKey]);
    const recoveredAttempt = await outbox.claim('telegram.send', 5);
    assert.equal(String(recoveredAttempt.id), String(failedAttempt.id));
    assert.notEqual(recoveredAttempt.lease_token, failedAttempt.lease_token);
    assert.equal(await outbox.delivered({ id: failedAttempt.id, leaseToken: failedAttempt.lease_token }), false);
    assert.equal(await outbox.delivered({ id: recoveredAttempt.id, leaseToken: recoveredAttempt.lease_token }), true);
    leaseConn.release();

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

    // Bounded burst test: concurrent claimers must never receive the same job.
    // This database is disposable CI state; clear unrelated pending fixtures so
    // the queue's intentionally global claim operation cannot affect assertions.
    await pool.execute('DELETE FROM background_jobs');
    const burstSize = 32;
    const burstPrefix = 'integration-burst:' + suffix + ':';
    await Promise.all(Array.from({ length: burstSize }, (_, index) =>
      queue.enqueueJob({
        type: 'test.burst',
        payload: { index, suffix },
        dedupeKey: burstPrefix + index
      })
    ));
    const burstClaims = await Promise.all(
      Array.from({ length: burstSize }, () => queue.claimJob({ leaseSeconds: 30 }))
    );
    assert.equal(burstClaims.filter(Boolean).length, burstSize);
    assert.equal(new Set(burstClaims.map(job => String(job.id))).size, burstSize,
      'parallel claimers must receive unique job IDs');
    assert.equal(new Set(burstClaims.map(job => job.lease_token)).size, burstSize,
      'parallel claimers must receive unique lease tokens');
    const burstCompletions = await Promise.all(burstClaims.map(job =>
      queue.completeJob({ id: job.id, leaseToken: job.lease_token })
    ));
    assert.equal(burstCompletions.filter(Boolean).length, burstSize);
    const burstJobIds = burstClaims.map(job => job.id);
    const [burstStatusRows] = await pool.execute(
      `SELECT id,status FROM background_jobs WHERE id IN (${burstJobIds.map(() => '?').join(',')})`,
      burstJobIds
    );
    assert.equal(burstStatusRows.length, burstSize);
    assert.ok(burstStatusRows.every(row => row.status === 'completed'),
      'every claimed burst job must be completed');

    // Exercise the same burst pattern for notification dispatch claims.
    const outboxPrefix = 'integration-outbox-burst:' + suffix + ':';
    const burstConn = await pool.getConnection();
    try {
      await burstConn.beginTransaction();
      for (let index = 0; index < burstSize; index += 1) {
        await outbox.enqueue(burstConn, {
          eventKey: outboxPrefix + index,
          aggregateType: 'test',
          aggregateId: suffix,
          eventType: 'test.burst.dispatch',
          payload: { index, suffix }
        });
      }
      await burstConn.commit();
    } catch (error) {
      await burstConn.rollback();
      throw error;
    } finally {
      burstConn.release();
    }
    const outboxClaims = await Promise.all(
      Array.from({ length: burstSize }, () => outbox.claim('test.burst.dispatch', 30))
    );
    assert.equal(outboxClaims.filter(Boolean).length, burstSize);
    assert.equal(new Set(outboxClaims.map(event => String(event.id))).size, burstSize,
      'parallel Outbox dispatchers must receive unique event IDs');
    assert.equal(new Set(outboxClaims.map(event => event.lease_token)).size, burstSize,
      'parallel Outbox dispatchers must receive unique lease tokens');
    const outboxCompletions = await Promise.all(outboxClaims.map(event =>
      outbox.delivered({ id: event.id, leaseToken: event.lease_token })
    ));
    assert.equal(outboxCompletions.filter(Boolean).length, burstSize);
    const burstOutboxIds = outboxClaims.map(event => event.id);
    const [outboxStatusRows] = await pool.execute(
      `SELECT id,status FROM event_outbox WHERE id IN (${burstOutboxIds.map(() => '?').join(',')})`,
      burstOutboxIds
    );
    assert.equal(outboxStatusRows.length, burstSize);
    assert.ok(outboxStatusRows.every(row => row.status === 'delivered'),
      'every claimed Outbox burst event must be delivered');
  } finally {
    await pool.end();
  }
});
