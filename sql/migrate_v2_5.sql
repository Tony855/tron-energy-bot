USE tron_energy;

-- Run once. MySQL versions without ADD COLUMN IF NOT EXISTS require this one-time migration.
ALTER TABLE admin_users
  ADD COLUMN role ENUM('super_admin','finance','operator','auditor') NOT NULL DEFAULT 'auditor' AFTER password_hash;

-- Existing DB-backed admins are least-privilege auditors until a super-admin promotes them.
-- The environment-based ADMIN_USERNAME remains the emergency super-admin login.
CREATE INDEX idx_admin_users_role_active ON admin_users(role, is_active);
