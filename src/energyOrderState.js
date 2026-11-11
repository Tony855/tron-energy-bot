'use strict';

const TRANSITIONS = Object.freeze({
  pending_provider: new Set(['submitting', 'processing', 'failed', 'cancelled']),
  submitting: new Set(['submission_unknown', 'processing', 'completed', 'failed']),
  submission_unknown: new Set(['processing', 'completed', 'failed']),
  processing: new Set(['completed', 'failed']),
  completed: new Set(),
  failed: new Set(['refunded']),
  refunded: new Set(),
  cancelled: new Set()
});

function canTransition(from, to) {
  return Boolean(TRANSITIONS[from] && TRANSITIONS[from].has(to));
}

function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    const error = new Error('ENERGY_ORDER_TRANSITION_NOT_ALLOWED');
    error.code = 'ENERGY_ORDER_TRANSITION_NOT_ALLOWED';
    throw error;
  }
}

async function transitionEnergyOrder(conn, {
  id, expectedStatus, nextStatus, providerName, providerOrderId, txHash, failureReason,
  providerReconciled = false, fulfillmentVerified = false, refundLedgerPosted = false
}) {
  assertTransition(expectedStatus, nextStatus);
  if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) throw new Error('INVALID_ENERGY_ORDER_ID');
  if (['submitting', 'submission_unknown'].includes(expectedStatus) && nextStatus !== 'submission_unknown' && providerReconciled !== true) {
    const error = new Error('PROVIDER_RECONCILIATION_REQUIRED');
    error.code = 'PROVIDER_RECONCILIATION_REQUIRED';
    throw error;
  }
  if (nextStatus === 'completed' && (fulfillmentVerified !== true || !/^[a-f0-9]{64}$/i.test(String(txHash || '')))) {
    const error = new Error('VERIFIED_FULFILLMENT_PROOF_REQUIRED');
    error.code = 'VERIFIED_FULFILLMENT_PROOF_REQUIRED';
    throw error;
  }
  if (nextStatus === 'refunded' && refundLedgerPosted !== true) {
    const error = new Error('REFUND_LEDGER_POSTING_REQUIRED');
    error.code = 'REFUND_LEDGER_POSTING_REQUIRED';
    throw error;
  }
  const fields = [];
  const values = [];
  const allowed = {
    providerName: ['provider_name', providerName],
    providerOrderId: ['provider_order_id', providerOrderId],
    txHash: ['tx_hash', txHash],
    failureReason: ['failure_reason', failureReason]
  };
  for (const [, [column, value]] of Object.entries(allowed)) {
    if (value !== undefined) {
      fields.push(column + '=?');
      values.push(value === null ? null : String(value).slice(0, column === 'failure_reason' ? 500 : 190));
    }
  }
  fields.push('status=?');
  values.push(nextStatus);
  fields.push('updated_at=UTC_TIMESTAMP()');
  values.push(id, expectedStatus);
  const [result] = await conn.execute(
    'UPDATE energy_orders SET ' + fields.join(',') + ' WHERE id=? AND status=?',
    values
  );
  if (result.affectedRows !== 1) {
    const error = new Error('ENERGY_ORDER_STATE_CONFLICT');
    error.code = 'ENERGY_ORDER_STATE_CONFLICT';
    throw error;
  }
  const eventKey = 'energy-order:' + id + ':' + expectedStatus + ':' + nextStatus;
  await conn.execute(
    `INSERT IGNORE INTO event_outbox
      (event_key,aggregate_type,aggregate_id,event_type,payload_json,status,available_at)
     VALUES (?, 'energy_order', ?, 'socket.emit', ?, 'pending', UTC_TIMESTAMP(3))`,
    [eventKey, String(id), JSON.stringify({ eventName: 'energy:order:state', data: { orderId: id, from: expectedStatus, to: nextStatus } })]
  );
  return { id, status: nextStatus };
}

module.exports = { TRANSITIONS, canTransition, assertTransition, transitionEnergyOrder };
