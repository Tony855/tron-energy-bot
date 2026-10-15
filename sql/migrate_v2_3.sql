-- V2.3 one-time migration. Run once after backup.
USE tron_energy;
ALTER TABLE recharge_orders
  ADD COLUMN chain_verified_at DATETIME NULL,
  ADD COLUMN chain_verified_json JSON NULL;
CREATE INDEX idx_recharge_chain_verified ON recharge_orders (chain_verified_at, status);
