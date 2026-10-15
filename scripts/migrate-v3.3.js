// V3.3 customer data isolation migration. Safe to re-run; refuses unsafe existing ownership mismatches.
const { pool } = require('../src/db');

async function exists(sql, params) {
  const [rows] = await pool.execute(sql, params);
  return Number(rows[0]?.n || 0) > 0;
}

async function main() {
  try {
    const mismatches = await exists(
      `SELECT COUNT(*) n FROM recharge_orders r JOIN wallets w ON w.id=r.wallet_id WHERE r.wallet_id IS NOT NULL AND r.user_id<>w.user_id`, []
    );
    if (mismatches) throw new Error('发现充值单 user_id 与钱包所有者不一致；为防止跨客户数据串线，已停止迁移，请先人工核对。');

    const [indexes] = await pool.execute(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='wallets' AND NON_UNIQUE=0`
    );
    const indexNames = new Set(indexes.map(x => x.INDEX_NAME));
    if (indexNames.has('uq_wallet_address')) {
      await pool.query('ALTER TABLE wallets DROP INDEX uq_wallet_address');
      console.log('[migration] removed global wallet-address uniqueness');
    }
    if (!indexNames.has('uq_wallet_user_address')) {
      await pool.query('ALTER TABLE wallets ADD UNIQUE KEY uq_wallet_user_address (user_id,address)');
      console.log('[migration] wallet addresses are now unique per customer, not globally');
    }
    if (!indexNames.has('uq_wallet_id_user')) {
      await pool.query('ALTER TABLE wallets ADD UNIQUE KEY uq_wallet_id_user (id,user_id)');
      console.log('[migration] added composite wallet owner key');
    }

    const oldFk = await exists(
      `SELECT COUNT(*) n FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='recharge_orders' AND CONSTRAINT_NAME='fk_recharge_wallet'`, []
    );
    if (oldFk) await pool.query('ALTER TABLE recharge_orders DROP FOREIGN KEY fk_recharge_wallet');
    const newFk = await exists(
      `SELECT COUNT(*) n FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='recharge_orders' AND CONSTRAINT_NAME='fk_recharge_wallet_owner'`, []
    );
    if (!newFk) {
      await pool.query('ALTER TABLE recharge_orders ADD CONSTRAINT fk_recharge_wallet_owner FOREIGN KEY (wallet_id,user_id) REFERENCES wallets(id,user_id) ON DELETE RESTRICT');
      console.log('[migration] enforced recharge-order wallet ownership');
    }
    console.log('[migration] V3.3 customer isolation constraints are active');
  } finally {
    await pool.end();
  }
}
main().catch(e => { console.error('[migration] failed:', e.message); process.exit(1); });
