USE tron_energy;

ALTER TABLE withdrawal_requests
  ADD COLUMN chain_verified_at DATETIME NULL AFTER reviewed_at,
  ADD COLUMN chain_verified_json JSON NULL AFTER chain_verified_at;

CREATE INDEX idx_withdraw_chain_verified ON withdrawal_requests (status, chain_verified_at);
