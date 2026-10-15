USE tron_energy;

-- Run once on an existing V1.0 installation after backing up the database.
-- Before adding global address uniqueness, ensure no address is registered more than once:
-- SELECT address, COUNT(*) c FROM wallets GROUP BY address HAVING c > 1;

ALTER TABLE wallets DROP INDEX uq_wallet_address_type;
ALTER TABLE wallets ADD UNIQUE KEY uq_wallet_address (address);

ALTER TABLE recharge_orders ADD COLUMN event_index INT NOT NULL DEFAULT 0 AFTER tx_hash;
ALTER TABLE recharge_orders DROP INDEX uq_recharge_tx;
ALTER TABLE recharge_orders ADD UNIQUE KEY uq_recharge_tx_event (tx_hash, event_index);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  admin_username VARCHAR(128) NOT NULL,
  action VARCHAR(100) NOT NULL,
  target_type VARCHAR(64) NOT NULL,
  target_id VARCHAR(128) NULL,
  details_json JSON NULL,
  ip_address VARCHAR(64) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_created (created_at),
  INDEX idx_audit_target (target_type, target_id)
) ENGINE=InnoDB;
