USE tron_energy;

CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  amount DECIMAL(30,6) NOT NULL,
  currency VARCHAR(12) NOT NULL DEFAULT 'USDT',
  destination_address VARCHAR(64) NOT NULL,
  status ENUM('pending','approved','paid','rejected','cancelled') NOT NULL DEFAULT 'pending',
  tx_hash VARCHAR(100) NULL,
  reviewed_by VARCHAR(128) NULL,
  reviewed_at DATETIME NULL,
  note VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_withdraw_user_status (user_id, status, created_at),
  UNIQUE KEY uq_withdraw_tx (tx_hash),
  CONSTRAINT fk_withdraw_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES
('withdrawal_minimum', '5'),
('withdrawal_mode', 'manual_review');
