const { pool } = require('./db');
const { validateAddress } = require('./tron');

async function assignNextDepositAddress(userId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [users] = await conn.execute('SELECT id FROM users WHERE id=? FOR UPDATE', [userId]);
    if (!users.length) throw new Error('用户不存在');

    const [existing] = await conn.execute(
      "SELECT id,address,label FROM wallets WHERE user_id=? AND wallet_type='deposit' AND is_active=1 LIMIT 1 FOR UPDATE",
      [userId]
    );
    if (existing.length) {
      await conn.commit();
      return { assigned: false, existing: true, ...existing[0] };
    }

    const [addresses] = await conn.execute(
      "SELECT id,address FROM deposit_address_pool WHERE status='available' ORDER BY id ASC LIMIT 1 FOR UPDATE SKIP LOCKED"
    );
    if (!addresses.length) {
      await conn.commit();
      return { assigned: false, reason: 'pool_empty' };
    }
    const item = addresses[0];
    const [wallet] = await conn.execute(
      "INSERT INTO wallets (user_id,address,label,wallet_type,is_active) VALUES (?,?, '自动分配充值地址','deposit',1)",
      [userId, item.address]
    );
    await conn.execute(
      "UPDATE deposit_address_pool SET status='assigned',assigned_user_id=?,assigned_wallet_id=?,assigned_at=NOW() WHERE id=? AND status='available'",
      [userId, wallet.insertId, item.id]
    );
    await conn.commit();
    return { assigned: true, wallet_id: wallet.insertId, address: item.address };
  } catch (e) {
    await conn.rollback();
    if (e.code === 'ER_DUP_ENTRY') throw new Error('地址池中存在已被系统使用的地址，请清理后重试');
    throw e;
  } finally {
    conn.release();
  }
}

async function importDepositAddresses(addresses, source = 'admin-import') {
  const normalized = [...new Set(addresses.map(a => String(a).trim()).filter(Boolean))];
  if (!normalized.length) return { imported: 0, skipped: 0, invalid: [] };
  const invalid = normalized.filter(a => !validateAddress(a));
  if (invalid.length) return { imported: 0, skipped: 0, invalid };

  let imported = 0;
  let skipped = 0;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const address of normalized) {
      const [usedWallet] = await conn.execute('SELECT id FROM wallets WHERE address=? LIMIT 1', [address]);
      const [inPool] = await conn.execute('SELECT id FROM deposit_address_pool WHERE address=? LIMIT 1', [address]);
      if (usedWallet.length || inPool.length) { skipped++; continue; }
      await conn.execute(
        "INSERT INTO deposit_address_pool (address,status,source_label) VALUES (?,'available',?)",
        [address, String(source).slice(0, 100)]
      );
      imported++;
    }
    await conn.commit();
    return { imported, skipped, invalid: [] };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = { assignNextDepositAddress, importDepositAddresses };
