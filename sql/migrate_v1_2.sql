USE tron_energy;

-- V1.2: pool of pre-generated TRON addresses. No private keys or seed phrases are stored.
CREATE TABLE IF NOT EXISTS deposit_address_pool (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  address VARCHAR(64) NOT NULL UNIQUE,
  status ENUM('available','assigned','disabled') NOT NULL DEFAULT 'available',
  source_label VARCHAR(100) NULL,
  assigned_user_id BIGINT UNSIGNED NULL,
  assigned_wallet_id BIGINT UNSIGNED NULL,
  assigned_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_deposit_pool_status (status, id),
  CONSTRAINT fk_pool_user FOREIGN KEY (assigned_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_pool_wallet FOREIGN KEY (assigned_wallet_id) REFERENCES wallets(id) ON DELETE SET NULL
) ENGINE=InnoDB;
