USE tron_energy;

CREATE TABLE IF NOT EXISTS chain_backfill_state (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  wallet_id BIGINT UNSIGNED NOT NULL,
  from_timestamp BIGINT NOT NULL,
  to_timestamp BIGINT NOT NULL,
  fingerprint VARCHAR(512) NULL,
  status ENUM('running','completed','error') NOT NULL DEFAULT 'running',
  pages_scanned INT UNSIGNED NOT NULL DEFAULT 0,
  transfers_seen BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_error VARCHAR(500) NULL,
  started_by VARCHAR(128) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_backfill_wallet_range (wallet_id, from_timestamp, to_timestamp),
  INDEX idx_backfill_status (status, updated_at),
  CONSTRAINT fk_backfill_wallet FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE
) ENGINE=InnoDB;
