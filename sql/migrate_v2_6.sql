USE tron_energy;

-- Run once. Adds server-side token revocation and shared login rate limits.
ALTER TABLE admin_users
  ADD COLUMN token_version INT UNSIGNED NOT NULL DEFAULT 0 AFTER role;

CREATE TABLE admin_login_limits (
  key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fail_count INT UNSIGNED NOT NULL DEFAULT 0,
  window_started_at DATETIME NOT NULL,
  locked_until DATETIME NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (key_hash),
  KEY idx_admin_login_limits_locked_until (locked_until),
  KEY idx_admin_login_limits_updated_at (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
