'use strict';

const crypto = require('node:crypto');

function createOutbox({ pool, uuid = crypto.randomUUID } = {}) {
  if (!pool || typeof pool.execute !== 'function') throw new TypeError('A MySQL-compatible pool is required');

  async function enqueue(conn, { eventKey, aggregateType, aggregateId, eventType, payload }) {
    if (!/^[a-zA-Z0-9_.:-]{1,190}$/.test(String(eventKey || ''))) throw new Error('Invalid outbox event key');
    if (!/^[a-zA-Z0-9_.:-]{1,80}$/.test(String(eventType || ''))) throw new Error('Invalid outbox event type');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid outbox payload');
    const [result] = await conn.execute(
      `INSERT IGNORE INTO event_outbox
        (event_key,aggregate_type,aggregate_id,event_type,payload_json,status,available_at)
       VALUES (?,?,?,?,?,'pending',UTC_TIMESTAMP(3))`,
      [eventKey, String(aggregateType || 'system').slice(0, 80), String(aggregateId || '0').slice(0, 100),
       eventType, JSON.stringify(payload)]
    );
    return { inserted: result.affectedRows === 1 };
  }

  async function claim(eventType, leaseSeconds = 60) {
    if (!/^[a-zA-Z0-9_.:-]{1,80}$/.test(String(eventType || ''))) throw new Error('Invalid event type');
    const leaseToken = uuid();
    await pool.execute(
      "UPDATE event_outbox SET status='dead',lease_token=NULL,lease_expires_at=NULL,last_error_code='LEASE_EXPIRED' WHERE status='processing' AND lease_expires_at<=UTC_TIMESTAMP(3) AND attempts>=12 AND event_type=?",
      [eventType]
    );
    const [result] = await pool.execute(
      `UPDATE event_outbox SET status='processing',lease_token=?,
        lease_expires_at=DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND),attempts=attempts+1
       WHERE event_type=? AND attempts<12
         AND ((status='pending' AND available_at<=UTC_TIMESTAMP(3))
           OR (status='processing' AND lease_expires_at<=UTC_TIMESTAMP(3)))
       ORDER BY id ASC LIMIT 1`,
      [leaseToken, leaseSeconds, eventType]
    );
    if (!result.affectedRows) return null;
    const [rows] = await pool.execute(
      'SELECT id,event_type,payload_json,attempts,lease_token FROM event_outbox WHERE lease_token=? LIMIT 1',
      [leaseToken]
    );
    if (!rows[0]) return null;
    let payload = rows[0].payload_json;
    if (typeof payload === 'string') payload = JSON.parse(payload);
    return { ...rows[0], payload };
  }

  async function delivered({ id, leaseToken }) {
    const [result] = await pool.execute(
      "UPDATE event_outbox SET status='delivered',delivered_at=UTC_TIMESTAMP(3),lease_token=NULL,lease_expires_at=NULL WHERE id=? AND status='processing' AND lease_token=?",
      [id, leaseToken]
    );
    return result.affectedRows === 1;
  }

  async function failed({ id, leaseToken, error }) {
    const [rows] = await pool.execute(
      "SELECT attempts FROM event_outbox WHERE id=? AND status='processing' AND lease_token=? LIMIT 1",
      [id, leaseToken]
    );
    if (!rows[0]) return false;
    const attempts = Number(rows[0].attempts);
    const dead = attempts >= 12;
    const code = /^[A-Z0-9_]{1,80}$/.test(String(error?.code || '')) ? String(error.code) : 'DELIVERY_FAILED';
    const delay = Math.min(3600, 2 ** Math.min(10, attempts));
    const [result] = await pool.execute(
      `UPDATE event_outbox SET status=?,available_at=DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND),
        lease_token=NULL,lease_expires_at=NULL,last_error_code=?
       WHERE id=? AND status='processing' AND lease_token=?`,
      [dead ? 'dead' : 'pending', delay, code, id, leaseToken]
    );
    return result.affectedRows === 1;
  }

  return Object.freeze({ enqueue, claim, delivered, failed });
}

module.exports = { createOutbox };
