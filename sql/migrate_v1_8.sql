USE tron_energy;
CREATE TABLE IF NOT EXISTS chain_alert_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  fingerprint CHAR(64) NOT NULL UNIQUE,
  alert_type VARCHAR(64) NOT NULL,
  tx_hash CHAR(64) NOT NULL,
  event_index INT NOT NULL DEFAULT 0,
  wallet_id BIGINT UNSIGNED NOT NULL,
  details_json JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_chain_alert_created (created_at),
  INDEX idx_chain_alert_wallet (wallet_id, created_at)
) ENGINE=InnoDB;
