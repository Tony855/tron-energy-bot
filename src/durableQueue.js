'use strict';

const crypto = require('node:crypto');

function retryDelaySeconds(attempt, random = Math.random) {
  const n = Math.max(1, Math.min(10, Number(attempt) || 1));
  const base = Math.min(3600, 2 ** n);
  const sample = Number(random());\n  const safeSample = Number.isFinite(sample) ? Math.max(0, Math.min(0.999999, sample)) : 0;\n  const jitter = Math.floor(safeSample * Math.max(1, Math.floor(base / 4)));
  return Math.min(3600, base + jitter);
}

function safeErrorCode(error) {
  const code = String(error?.code || 'JOB_FAILED');
  return /^[A-Z0-9_]{1,80}$/.test(code) ? code : 'JOB_FAILED';
}

function createDurableQueue({ pool, uuid = crypto.randomUUID, random = Math.random } = {}) {
  if (!pool || typeof pool.execute !== 'function') {
    throw new TypeError('A MySQL-compatible pool is required');
  }

  async function enqueueJob({ type, payload, dedupeKey = null, priority = 0, maxAttempts = 8, availableAt = null }) {
    if (!/^[a-zA-Z0-9_.:-]{1,100}$/.test(String(type || ''))) throw new Error('Invalid job type');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Job payload must be an object');
    if (!Number.isInteger(priority) || priority < -32768 || priority > 32767) throw new Error('Invalid job priority');
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) throw new Error('Invalid maxAttempts');
    const [result] = await pool.execute(
      `INSERT INTO background_jobs (job_type,payload_json,dedupe_key,priority,max_attempts,available_at)
       VALUES (?,?,?,?,?,COALESCE(?,UTC_TIMESTAMP(3)))
       ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
      [type, JSON.stringify(payload), dedupeKey, priority, maxAttempts, availableAt]
    );
    return { id: result.insertId, duplicate: result.affectedRows === 0 || result.affectedRows === 2 };
  }

  async function claimJob({ leaseSeconds = 60 } = {}) {
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 3600) {
      throw new Error('leaseSeconds must be between 5 and 3600');
    }
    const leaseToken = uuid();
    const [result] = await pool.execute(
      `UPDATE background_jobs
          SET status='processing', lease_token=?,
              lease_expires_at=DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND),
              attempts=attempts+1
        WHERE id=(
          SELECT candidate.id FROM (
            SELECT id FROM background_jobs
             WHERE attempts < max_attempts
               AND ((status='pending' AND available_at<=UTC_TIMESTAMP(3))
                 OR (status='processing' AND lease_expires_at<=UTC_TIMESTAMP(3)))
             ORDER BY priority DESC, available_at ASC, id ASC
             LIMIT 1
          ) AS candidate
        )
          AND attempts < max_attempts
          AND (status='pending' OR (status='processing' AND lease_expires_at<=UTC_TIMESTAMP(3)))`,
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

  return Object.freeze({ enqueueJob, claimJob, completeJob, failJob });
}

module.exports = { createDurableQueue, retryDelaySeconds, safeErrorCode };
