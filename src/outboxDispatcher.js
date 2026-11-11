'use strict';

const { startLeaseHeartbeat } = require('./leaseHeartbeat');

async function dispatchOutboxOnce({ outbox, eventType, deliver, logger = console } = {}) {
  if (!outbox || typeof outbox.claim !== 'function' ||
      typeof outbox.delivered !== 'function' || typeof outbox.failed !== 'function' || typeof outbox.renew !== 'function') {
    throw new TypeError('A compatible outbox is required');
  }
  if (typeof deliver !== 'function') throw new TypeError('deliver is required');
  const item = await outbox.claim(eventType, 60);
  if (!item) return false;
  const heartbeat = startLeaseHeartbeat({
    renew: () => outbox.renew({ id: item.id, leaseToken: item.lease_token, leaseSeconds: 60 }),
    intervalMs: 20000, logger, label: 'outbox', id: item.id
  });
  try {
    await deliver(item);
    if (await heartbeat.stop()) throw Object.assign(new Error('OUTBOX_LEASE_LOST'), { code: 'OUTBOX_LEASE_LOST' });
    const acknowledged = await outbox.delivered({ id: item.id, leaseToken: item.lease_token });
    if (!acknowledged) {
      logger.warn('[outbox] delivery completed but lease acknowledgement was lost', item.id);
    }
  } catch (error) {
    await heartbeat.stop();
    await outbox.failed({ id: item.id, leaseToken: item.lease_token, error });
    logger.error('[outbox] delivery failed', item.id, error.code || 'DELIVERY_FAILED');
  }
  return true;
}

module.exports = { dispatchOutboxOnce };
