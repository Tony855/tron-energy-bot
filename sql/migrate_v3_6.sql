USE tron_energy;
-- V3.6: 用户语言偏好。NULL 表示按 Telegram 客户端语言自动判定。
ALTER TABLE users ADD COLUMN language VARCHAR(8) NULL AFTER first_name;
