'use strict';

/**
 * Deprecated legacy worker.
 *
 * The former implementation mutated users.balance directly, had no row claim,
 * no transaction spanning order and ledger state, and no idempotency protection.
 * Calling it could therefore double-debit/refund orders after retries.
 *
 * Energy fulfillment is intentionally disabled until the V4 order state machine,
 * durable job leases, and ledger-only settlement are implemented.
 */
function startWorker() {
  const error = new Error(
    'LEGACY_ENERGY_WORKER_DISABLED: use the V4 energy order processor after it is enabled'
  );
  error.code = 'LEGACY_ENERGY_WORKER_DISABLED';
  throw error;
}

async function processPendingOrders() {
  const error = new Error(
    'LEGACY_ENERGY_WORKER_DISABLED: pending orders must not be processed by the legacy worker'
  );
  error.code = 'LEGACY_ENERGY_WORKER_DISABLED';
  throw error;
}

module.exports = { startWorker, processPendingOrders };
