-- 添加用户绑定的 TRON 钱包地址字段
ALTER TABLE users ADD COLUMN IF NOT EXISTS tron_wallet_address VARCHAR(42) DEFAULT NULL;

-- 确保 energy_orders 表拥有最新字段
ALTER TABLE energy_orders ADD COLUMN IF NOT EXISTS tx_hash VARCHAR(100) DEFAULT NULL;
