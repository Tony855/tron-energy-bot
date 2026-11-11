'use strict';

async function dispatchOutboxOnce({ outbox, eventType, deliver, logger = console } = {}) {
  if (!outbox || typeof outbox.claim !== 'function' ||
      typeof outbox.delivered !== 'function' || typeof outbox.failed !== 'function') {
    throw new TypeError('A compatible outbox is required');
  }
  if (typeof deliver !== 'function') throw new TypeError('deliver is required');
  const item = await outbox.claim(eventType, 60);
  if (!item) return false;
  try {
    await deliver(item);
    const acknowledged = await outbox.delivered({ id: item.id, leaseToken: item.lease_token });
    if (!acknowledged) {
      logger.warn('[outbox] delivery completed but lease acknowledgement was lost', item.id);
    }
  } catch (error) {
    await outbox.failed({ id: item.id, leaseToken: item.lease_token, error });
    logger.error('[outbox] delivery failed', item.id, error.code || 'DELIVERY_FAILED');
  }
  return true;
}

module.exports = { dispatchOutboxOnce };
