'use strict';

const crypto = require('node:crypto');
const { signatureValid } = require('./eventSignature');
const { pool } = require('./db');

function parseWebhook(raw, signature, secret = process.env.TRON_EVENT_WEBHOOK_SECRET) {
  if (!signatureValid(raw, signature, secret)) {
    throw Object.assign(new Error('invalid signature'), { status: 401 });
  }
  let body;
  try { body = JSON.parse(raw.toString('utf8')); }
  catch { throw Object.assign(new Error('invalid json'), { status: 400 }); }
  if (!body || body.network !== 'mainnet' || !/^[a-f0-9]{64}$/i.test(String(body.txHash || ''))) {
    throw Object.assign(new Error('invalid event'), { status: 400 });
  }
  const txHash = String(body.txHash).toLowerCase();
  // The provider currently sends a transaction-hash hint, not a stable event ID.
  // A deterministic key makes webhook retries idempotent without trusting payload fields.
  const providerEventId = crypto.createHash('sha256')
    .update('tron-mainnet:trc20-transfer:' + txHash).digest('hex');
  return { txHash, network: 'mainnet', providerEventId };
}

async function acceptWebhook(raw, signature) {
  const event = parseWebhook(raw, signature);
  const bodyHash = crypto.createHash('sha256').update(raw).digest('hex');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [insert] = await conn.execute(
      `INSERT IGNORE INTO event_inbox
        (provider,provider_event_id,network,event_type,body_sha256,payload_json,signature_valid,status)
       VALUES ('tron',?,'mainnet','trc20.transfer',?,?,1,'received')`,
      [event.providerEventId, bodyHash, JSON.stringify({ txHash: event.txHash })]
    );
    let inboxId;
    if (insert.affectedRows === 1) {
      inboxId = insert.insertId;
    } else {
      const [existing] = await conn.execute(
        'SELECT id,status,body_sha256 FROM event_inbox WHERE provider=? AND provider_event_id=? FOR UPDATE',
        ['tron', event.providerEventId]
      );
      if (!existing[0]) throw new Error('WEBHOOK_INBOX_CONFLICT');
      inboxId = existing[0].id;
      // Same transaction ID may be re-delivered with different provider metadata.
      // Keep the first signed payload as the canonical event.
    }
    const dedupeKey = 'tron:webhook:' + event.providerEventId;
    await conn.execute(
      `INSERT IGNORE INTO background_jobs
        (job_type,payload_json,dedupe_key,priority,max_attempts,available_at)
       VALUES ('tron.webhook.process',?,?,10,12,UTC_TIMESTAMP(3))`,
      [JSON.stringify({ inboxId, txHash: event.txHash }), dedupeKey]
    );
    await conn.commit();
    return { accepted: true, duplicate: insert.affectedRows !== 1, eventId: event.providerEventId };
  } catch (error) {
    try { await conn.rollback(); } catch {}
    throw error;
  } finally {
    conn.release();
  }
}

module.exports = { parseWebhook, acceptWebhook };
