'use strict';

const crypto = require('node:crypto');

function retryDelaySeconds(attempt, random = Math.random) {
  const n = Math.max(1, Math.min(10, Number(attempt) || 1));
  const base = Math.min(3600, 2 ** n);
  const sample = Number(random());
  const safeSample = Number.isFinite(sample) ? Math.max(0, Math.min(0.999999, sample)) : 0;
  const jitter = Math.floor(safeSample * Math.max(1, Math.floor(base / 4)));
  return Math.min(3600, base + jitter);
}

function safeErrorCode(error) {
  const code = String(error?.code || 'JOB_FAILED');
  return /^[A-Z0-9_]{1,80}$/.test(code) ? code : 'JOB_FAILED';
}

function createDurableQueue({ pool, uuid = crypto.randomUUID, random = Math.random, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!pool || typeof pool.execute !== 'function') {
    throw new TypeError('A MySQL-compatible pool is required');
  }

  async function executeClaimUpdate(sql, params) {
    const maxAttempts = 4;
    for (let attempt = 0; ; attempt++) {
      try {
        return await pool.execute(sql, params);
      } catch (error) {
        const retryable = error?.code === 'ER_LOCK_DEADLOCK' ||
          error?.code === 'ER_LOCK_WAIT_TIMEOUT' || error?.sqlState === '40001';
        if (!retryable || attempt >= maxAttempts - 1) throw error;
        await sleep(Math.min(80, 10 * (2 ** attempt)));
      }
    }
  }

  async function enqueueJob({ type, payload, dedupeKey = null, priority = 0, maxAttempts = 8, availableAt = null }) {
    if (!/^[a-zA-Z0-9_.:-]{1,100}$/.test(String(type || ''))) throw new Error('Invalid job type');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Job payload must be an object');
    if (dedupeKey !== null && (typeof dedupeKey !== 'string' || dedupeKey.length < 1 || dedupeKey.length > 190)) throw new Error('Invalid dedupeKey');
    if (!Number.isInteger(priority) || priority < -32768 || priority > 32767) throw new Error('Invalid job priority');
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) throw new Error('Invalid maxAttempts');
    const [result] = await pool.execute(
      `INSERT IGNORE INTO background_jobs (job_type,payload_json,dedupe_key,priority,max_attempts,available_at)
       VALUES (?,?,?,?,?,COALESCE(?,UTC_TIMESTAMP(3)))`,
      [type, JSON.stringify(payload), dedupeKey, priority, maxAttempts, availableAt]
    );
    if (result.affectedRows === 1) return { id: result.insertId, duplicate: false };
    if (dedupeKey === null) throw new Error('Job insert was ignored unexpectedly');
    const [existing] = await pool.execute(
      'SELECT id FROM background_jobs WHERE dedupe_key=? LIMIT 1',
      [dedupeKey]
    );
    if (!existing[0]) throw new Error('Idempotent job record could not be recovered');
    return { id: existing[0].id, duplicate: true };
  }

  async function claimJob({ leaseSeconds = 60 } = {}) {
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 3600) {
      throw new Error('leaseSeconds must be between 5 and 3600');
    }
    const leaseToken = uuid();
    await executeClaimUpdate(
      `UPDATE background_jobs
          SET status='dead', lease_token=NULL, lease_expires_at=NULL, last_error_code='LEASE_EXPIRED'
        WHERE status='processing' AND lease_expires_at<=UTC_TIMESTAMP(3) AND attempts>=max_attempts`
    );
    const [result] = await executeClaimUpdate(
      `UPDATE background_jobs
          SET status='processing', lease_token=?,
              lease_expires_at=DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND),
              attempts=attempts+1
        WHERE attempts < max_attempts
          AND ((status='pending' AND available_at<=UTC_TIMESTAMP(3))
            OR (status='processing' AND lease_expires_at<=UTC_TIMESTAMP(3)))
        ORDER BY priority DESC, available_at ASC, id ASC
        LIMIT 1`,
      [leaseToken, leaseSeconds]
    );
    if (!result.affectedRows) return null;
    const [rows] = await pool.execute(
      'SELECT id,job_type,payload_json,attempts,max_attempts,lease_token,lease_expires_at FROM background_jobs WHERE lease_token=? LIMIT 1',
      [leaseToken]
    );
    if (!rows[0]) return null;
    let payload = rows[0].payload_json;
    if (typeof payload === 'string') payload = JSON.parse(payload);
    return { ...rows[0], payload };
  }

  async function renewJob({ id, leaseToken, leaseSeconds = 90 }) {
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 3600) {
      throw new Error('leaseSeconds must be between 5 and 3600');
    }
    const [result] = await pool.execute(
      `UPDATE background_jobs
          SET lease_expires_at=DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND)
        WHERE id=? AND status='processing' AND lease_token=?
          AND lease_expires_at>UTC_TIMESTAMP(3)`,
      [leaseSeconds, id, leaseToken]
    );
    return result.affectedRows === 1;
  }

  async function completeJob({ id, leaseToken }) {
    const [result] = await pool.execute(
      `UPDATE background_jobs
          SET status='completed', completed_at=UTC_TIMESTAMP(3),
              lease_token=NULL, lease_expires_at=NULL
        WHERE id=? AND status='processing' AND lease_token=?`,
      [id, leaseToken]
    );
    return result.affectedRows === 1;
  }

  async function failJob({ id, leaseToken, error }) {
    const [rows] = await pool.execute(
      'SELECT attempts,max_attempts FROM background_jobs WHERE id=? AND status=\'processing\' AND lease_token=? LIMIT 1',
      [id, leaseToken]
    );
    if (!rows[0]) return false;
    const dead = Number(rows[0].attempts) >= Number(rows[0].max_attempts);
    const delay = retryDelaySeconds(rows[0].attempts, random);
    const [result] = await pool.execute(
      `UPDATE background_jobs
          SET status=?, available_at=DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND),
              lease_token=NULL, lease_expires_at=NULL, last_error_code=?
        WHERE id=? AND status='processing' AND lease_token=?`,
      [dead ? 'dead' : 'pending', delay, safeErrorCode(error), id, leaseToken]
    );
    return result.affectedRows === 1;
  }

  return Object.freeze({ enqueueJob, claimJob, renewJob, completeJob, failJob });
}

module.exports = { createDurableQueue, retryDelaySeconds, safeErrorCode };
