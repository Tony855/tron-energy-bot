USE tron_energy;

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_by VARCHAR(128) NOT NULL,
  date_from DATE NOT NULL,
  date_to DATE NOT NULL,
  deposit_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  deposit_amount DECIMAL(30,6) NOT NULL DEFAULT 0,
  credited_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  credited_amount DECIMAL(30,6) NOT NULL DEFAULT 0,
  pending_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  pending_amount DECIMAL(30,6) NOT NULL DEFAULT 0,
  withdrawal_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  withdrawal_amount DECIMAL(30,6) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_recon_created (created_at)
) ENGINE=InnoDB;

CREATE INDEX idx_recharge_created_status ON recharge_orders (created_at, status);
CREATE INDEX idx_ledger_created_type ON ledger_entries (created_at, entry_type);
CREATE INDEX idx_withdraw_created_status ON withdrawal_requests (created_at, status);
