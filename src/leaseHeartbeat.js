'use strict';

/**
 * Extends a processing lease while an external or database operation is in flight.
 * A lease that has already expired cannot be revived; renew methods must enforce
 * the current lease token and a still-live expiry timestamp.
 */
function startLeaseHeartbeat({ renew, intervalMs, logger = console, label = 'lease', id = '' } = {}) {
  if (typeof renew !== 'function') throw new TypeError('renew is required');
  if (!Number.isInteger(intervalMs) || intervalMs < 1000) throw new TypeError('intervalMs must be at least 1000ms');
  let stopped = false;
  let lost = false;
  let inFlight = false;
  const timer = setInterval(async () => {
    if (stopped || inFlight || lost) return;
    inFlight = true;
    try {
      if (!await renew()) {
        lost = true;
        logger.warn(`[${label}] lease renewal rejected`, id);
      }
    } catch (error) {
      lost = true;
      logger.error(`[${label}] lease renewal failed`, id, error.code || 'LEASE_RENEW_FAILED');
    } finally {
      inFlight = false;
    }
  }, intervalMs);
  timer.unref?.();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      return lost;
    },
    isLost() { return lost; }
  };
}

module.exports = { startLeaseHeartbeat };
