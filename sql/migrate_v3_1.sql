-- V3.1: persistent bounded backfill cursors for TRC20 and native TRX monitoring.
-- MySQL 8.0. ALTER statements are intended for a one-time upgrade.
ALTER TABLE wallets ADD COLUMN scan_from_timestamp BIGINT NULL AFTER last_scanned_at;
ALTER TABLE wallets ADD COLUMN trc20_cursor VARCHAR(512) NULL AFTER scan_from_timestamp;
ALTER TABLE wallets ADD COLUMN trx_cursor VARCHAR(512) NULL AFTER trc20_cursor;
