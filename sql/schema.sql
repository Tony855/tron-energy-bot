CREATE DATABASE IF NOT EXISTS tron_energy CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE tron_energy;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  telegram_id BIGINT NOT NULL UNIQUE,
  username VARCHAR(128) NULL,
  first_name VARCHAR(128) NULL,
  referral_code VARCHAR(32) NOT NULL UNIQUE,
  referred_by BIGINT UNSIGNED NULL,
  balance DECIMAL(30,6) NOT NULL DEFAULT 0,
  is_blocked TINYINT(1) NOT NULL DEFAULT 0,
  language VARCHAR(8) NULL,
  tron_wallet_address VARCHAR(42) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_users_referrer FOREIGN KEY (referred_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_users_created (created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS wallets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  address VARCHAR(64) NOT NULL,
  label VARCHAR(100) NULL,
  wallet_type ENUM('monitor','deposit') NOT NULL DEFAULT 'monitor',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  last_scanned_at DATETIME NULL,
  scan_from_timestamp BIGINT NULL,
  trc20_cursor VARCHAR(512) NULL,
  trx_cursor VARCHAR(512) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_wallet_user_address (user_id, address),
  UNIQUE KEY uq_wallet_id_user (id, user_id),
  INDEX idx_wallet_user (user_id),
  CONSTRAINT fk_wallet_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;


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

CREATE TABLE IF NOT EXISTS transactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  wallet_id BIGINT UNSIGNED NOT NULL,
  tx_hash CHAR(64) NOT NULL,
  event_index INT NOT NULL DEFAULT 0,
  token_contract VARCHAR(64) NOT NULL,
  from_address VARCHAR(64) NOT NULL,
  to_address VARCHAR(64) NOT NULL,
  amount DECIMAL(30,6) NOT NULL,
  block_timestamp BIGINT NULL,
  confirmed TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_wallet_tx_event (wallet_id, tx_hash, event_index),
  INDEX idx_tx_wallet_time (wallet_id, block_timestamp),
  CONSTRAINT fk_tx_wallet FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS recharge_orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  wallet_id BIGINT UNSIGNED NULL,
  tx_hash CHAR(64) NULL,
  event_index INT NOT NULL DEFAULT 0,
  amount DECIMAL(30,6) NOT NULL,
  currency VARCHAR(12) NOT NULL DEFAULT 'USDT',
  source ENUM('manual','tron') NOT NULL DEFAULT 'manual',
  status ENUM('pending','approved','rejected','credited') NOT NULL DEFAULT 'pending',
  note VARCHAR(500) NULL,
  reviewed_by VARCHAR(128) NULL,
  reviewed_at DATETIME NULL,
  chain_verified_at DATETIME NULL,
  chain_verified_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_recharge_tx_event (tx_hash, event_index),
  INDEX idx_recharge_chain_verified (chain_verified_at, status),
  INDEX idx_recharge_status (status, created_at),
  CONSTRAINT fk_recharge_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_recharge_wallet_owner FOREIGN KEY (wallet_id, user_id) REFERENCES wallets(id, user_id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ledger_entries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  entry_type ENUM('deposit','referral_bonus','energy_order_debit','refund','admin_adjustment') NOT NULL,
  amount DECIMAL(30,6) NOT NULL,
  balance_after DECIMAL(30,6) NOT NULL,
  reference_type VARCHAR(32) NOT NULL,
  reference_id BIGINT UNSIGNED NOT NULL,
  idempotency_key VARCHAR(190) NOT NULL UNIQUE,
  note VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ledger_user_time (user_id, created_at),
  CONSTRAINT fk_ledger_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS referral_commissions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  referrer_user_id BIGINT UNSIGNED NOT NULL,
  referred_user_id BIGINT UNSIGNED NOT NULL,
  recharge_order_id BIGINT UNSIGNED NOT NULL,
  amount DECIMAL(30,6) NOT NULL,
  percent DECIMAL(7,4) NOT NULL,
  status ENUM('credited','voided') NOT NULL DEFAULT 'credited',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_referral_recharge (recharge_order_id),
  CONSTRAINT fk_comm_referrer FOREIGN KEY (referrer_user_id) REFERENCES users(id),
  CONSTRAINT fk_comm_referred FOREIGN KEY (referred_user_id) REFERENCES users(id),
  CONSTRAINT fk_comm_recharge FOREIGN KEY (recharge_order_id) REFERENCES recharge_orders(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS energy_orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  receiver_address VARCHAR(64) NOT NULL,
  energy_amount BIGINT UNSIGNED NOT NULL,
  duration_minutes INT NOT NULL DEFAULT 60,
  quoted_price DECIMAL(30,6) NOT NULL,
  currency VARCHAR(12) NOT NULL DEFAULT 'USDT',
  status ENUM('pending_provider','submitting','submission_unknown','processing','completed','failed','refunded','cancelled') NOT NULL DEFAULT 'pending_provider',
  provider_name VARCHAR(100) NULL,
  provider_order_id VARCHAR(190) NULL,
  tx_hash VARCHAR(100) NULL,
  failure_reason VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_energy_user_time (user_id, created_at),
  INDEX idx_energy_status (status, created_at),
  CONSTRAINT fk_energy_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS admin_users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(128) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('super_admin','finance','operator','auditor') NOT NULL DEFAULT 'auditor',
  token_version INT UNSIGNED NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_admin_users_role_active (role, is_active)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS app_settings (
  setting_key VARCHAR(100) NOT NULL PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES
('referral_commission_percent', '3'),
('energy_provider_mode', 'disabled'),
('minimum_deposit', '1');

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


CREATE TABLE IF NOT EXISTS admin_login_limits (
  key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fail_count INT UNSIGNED NOT NULL DEFAULT 0,
  window_started_at DATETIME NOT NULL,
  locked_until DATETIME NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (key_hash),
  KEY idx_admin_login_limits_locked_until (locked_until),
  KEY idx_admin_login_limits_updated_at (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
