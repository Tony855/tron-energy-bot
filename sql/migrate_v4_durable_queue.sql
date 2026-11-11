-- V4 durable event and job primitives.
-- Apply only after taking an encrypted backup and verifying the target schema.
-- This migration is additive and does not enable automatic financial processing.

CREATE TABLE IF NOT EXISTS event_inbox (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  provider VARCHAR(64) NOT NULL,
  provider_event_id VARCHAR(190) NOT NULL,
  network VARCHAR(32) NOT NULL,
  event_type VARCHAR(80) NOT NULL,
  body_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_json JSON NOT NULL,
  signature_valid TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('received','processing','processed','failed','rejected','dead') NOT NULL DEFAULT 'received',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  available_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  lease_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_expires_at DATETIME(3) NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  processed_at DATETIME(3) NULL,
  last_error_code VARCHAR(80) NULL,
  UNIQUE KEY uq_event_inbox_provider_event (provider, provider_event_id),
  KEY idx_event_inbox_status_received (status, available_at, received_at),
  KEY idx_event_inbox_lease (status, lease_expires_at),
  KEY idx_event_inbox_network_type (network, event_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS background_jobs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  job_type VARCHAR(100) NOT NULL,
  payload_json JSON NOT NULL,
  dedupe_key VARCHAR(190) NULL,
  status ENUM('pending','processing','completed','dead') NOT NULL DEFAULT 'pending',
  priority SMALLINT NOT NULL DEFAULT 0,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts INT UNSIGNED NOT NULL DEFAULT 8,
  available_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  lease_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_expires_at DATETIME(3) NULL,
  last_error_code VARCHAR(80) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) NULL,
  UNIQUE KEY uq_background_jobs_dedupe (dedupe_key),
  KEY idx_background_jobs_claim (status, available_at, priority, id),
  KEY idx_background_jobs_lease (status, lease_expires_at),
  KEY idx_background_jobs_type_created (job_type, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS event_outbox (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_key VARCHAR(190) NOT NULL,
  aggregate_type VARCHAR(80) NOT NULL,
  aggregate_id VARCHAR(100) NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  payload_json JSON NOT NULL,
  status ENUM('pending','processing','delivered','dead') NOT NULL DEFAULT 'pending',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  available_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  lease_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_expires_at DATETIME(3) NULL,
  last_error_code VARCHAR(80) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  delivered_at DATETIME(3) NULL,
  UNIQUE KEY uq_event_outbox_event_key (event_key),
  KEY idx_event_outbox_dispatch (status, available_at, id),
  KEY idx_event_outbox_lease (status, lease_expires_at),
  KEY idx_event_outbox_aggregate (aggregate_type, aggregate_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
