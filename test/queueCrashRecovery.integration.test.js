'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { createDurableQueue } = require('../src/durableQueue');
const { createOutbox } = require('../src/outbox');

test('expired final leases become dead letters and cannot be reclaimed', {
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
    timezone: 'Z'
  });
  const suffix = crypto.randomUUID();
  const jobKey = 'crash-final:' + suffix;
  const eventKey = 'crash-final:' + suffix;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS background_jobs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      job_type VARCHAR(100) NOT NULL, payload_json JSON NOT NULL, dedupe_key VARCHAR(190) NULL,
      status ENUM('pending','processing','completed','dead') NOT NULL DEFAULT 'pending',
      priority SMALLINT NOT NULL DEFAULT 0, attempts INT UNSIGNED NOT NULL DEFAULT 0,
      max_attempts INT UNSIGNED NOT NULL DEFAULT 8,
      available_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      lease_token CHAR(36) NULL, lease_expires_at DATETIME(3) NULL,
      last_error_code VARCHAR(80) NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      completed_at DATETIME(3) NULL, UNIQUE KEY uq_background_jobs_dedupe (dedupe_key),
      KEY idx_background_jobs_claim (status, available_at, priority, id),
      KEY idx_background_jobs_lease (status, lease_expires_at)
    ) ENGINE=InnoDB`);
    await pool.query(`CREATE TABLE IF NOT EXISTS event_outbox (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      event_key VARCHAR(190) NOT NULL, aggregate_type VARCHAR(80) NOT NULL,
      aggregate_id VARCHAR(100) NOT NULL, event_type VARCHAR(100) NOT NULL,
      payload_json JSON NOT NULL,
      status ENUM('pending','processing','delivered','dead') NOT NULL DEFAULT 'pending',
      attempts INT UNSIGNED NOT NULL DEFAULT 0, available_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      lease_token CHAR(36) NULL, lease_expires_at DATETIME(3) NULL, last_error_code VARCHAR(80) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), delivered_at DATETIME(3) NULL,
      UNIQUE KEY uq_event_outbox_event_key (event_key),
      KEY idx_event_outbox_dispatch (status, available_at, id),
      KEY idx_event_outbox_lease (status, lease_expires_at)
    ) ENGINE=InnoDB`);

    // This integration test shares the ephemeral CI database with other
    // queue suites. claimJob intentionally claims globally, so clear stale
    // fixture rows before asserting which job is claimed.
    await pool.query('DELETE FROM background_jobs');
    const queue = createDurableQueue({ pool });
    const outbox = createOutbox({ pool });
    const job = await queue.enqueueJob({
      type: 'test.crash.recovery', payload: { marker: suffix },
      dedupeKey: jobKey, maxAttempts: 1
    });
    const claimedJob = await queue.claimJob({ leaseSeconds: 5 });
    assert.equal(String(claimedJob.id), String(job.id));
    await pool.execute(
      'UPDATE background_jobs SET lease_expires_at=DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE id=?',
      [job.id]
    );
    assert.equal(await queue.claimJob({ leaseSeconds: 5 }), null);
    const [deadJob] = await pool.execute(
      'SELECT status,last_error_code,lease_token FROM background_jobs WHERE id=?', [job.id]
    );
    assert.equal(deadJob[0].status, 'dead');
    assert.equal(deadJob[0].last_error_code, 'LEASE_EXPIRED');
    assert.equal(deadJob[0].lease_token, null);
    assert.equal(await queue.completeJob({ id: job.id, leaseToken: claimedJob.lease_token }), false);

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await outbox.enqueue(conn, {
        eventKey, aggregateType: 'test', aggregateId: suffix,
        eventType: 'telegram.send', payload: { telegramId: '1', text: 'crash recovery' }
      });
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
    await pool.execute('UPDATE event_outbox SET attempts=11 WHERE event_key=?', [eventKey]);
    const claimedEvent = await outbox.claim('telegram.send', 5);
    assert.ok(claimedEvent);
    await pool.execute(
      'UPDATE event_outbox SET lease_expires_at=DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE id=?',
      [claimedEvent.id]
    );
    assert.equal(await outbox.claim('telegram.send', 5), null);
    const [deadEvent] = await pool.execute(
      'SELECT status,last_error_code,lease_token FROM event_outbox WHERE event_key=?', [eventKey]
    );
    assert.equal(deadEvent[0].status, 'dead');
    assert.equal(deadEvent[0].last_error_code, 'LEASE_EXPIRED');
    assert.equal(deadEvent[0].lease_token, null);
    assert.equal(await outbox.delivered({ id: claimedEvent.id, leaseToken: claimedEvent.lease_token }), false);
  } finally {
    await pool.execute('DELETE FROM background_jobs WHERE dedupe_key=?', [jobKey]).catch(() => {});
    await pool.execute('DELETE FROM event_outbox WHERE event_key=?', [eventKey]).catch(() => {});
    await pool.end();
  }
});
