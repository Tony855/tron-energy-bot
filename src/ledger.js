const { pool } = require('./db');

const { normalizeAmount } = require('./money');
const { toMicros } = require('./withdrawalPolicy');
const { assertRechargeCanCredit } = require('./chainDepositVerify');

// 微单位 → 6 位小数字符串（与 DB DECIMAL(30,6) 精度一致）。
function microsToDecimal(m) {
  const neg = m < 0n;
  const abs = neg ? -m : m;
  const whole = abs / 1000000n;
  const frac = (abs % 1000000n).toString().padStart(6, '0');
  const s = `${whole}.${frac}`;
  return neg ? `-${s}` : s;
}


// Must be called inside a caller-owned MySQL transaction. The unique ledger
// idempotency_key is the final concurrency guard; the user row lock serializes
// balance changes for the same account.
async function postBalanceEntry(conn, {
  userId, delta, entryType, referenceType, referenceId, idempotencyKey, note = null
}) {
  if (!Number.isSafeInteger(Number(userId)) || Number(userId) <= 0) throw new Error('无效用户 ID');
  if (!idempotencyKey || String(idempotencyKey).length > 190) throw new Error('无效幂等键');
  if (!VALID_ENTRY_TYPES.has(entryType)) throw new Error(`无效账本类型: ${entryType}`);
  if (!VALID_REFERENCE_TYPES.has(referenceType)) throw new Error(`无效业务引用类型: ${referenceType}`);
  const amount = normalizeAmount(delta);
  // Lock the account first: serializes all balance mutations for this user.
  const [users] = await conn.execute('SELECT id,balance FROM users WHERE id=? FOR UPDATE', [userId]);
  if (!users[0]) throw new Error('用户不存在');
  const [existing] = await conn.execute(
    'SELECT id,user_id,amount,balance_after FROM ledger_entries WHERE idempotency_key=? FOR UPDATE',
    [idempotencyKey]
  );
  if (existing.length) {
    const row = existing[0];
    if (String(row.user_id) !== String(userId) || normalizeAmount(row.amount) !== amount) {
      throw new Error('幂等键已存在，但用户或金额不一致');
    }
    return { posted: false, duplicate: true, ledgerId: row.id, balanceAfter: row.balance_after };
  }
  const negative = amount.startsWith('-') && !/^(-0+(?:\.0{1,6})?)$/.test(amount);
  if (negative) {
    const debit = amount.slice(1);
    const [upd] = await conn.execute(
      'UPDATE users SET balance=balance-? WHERE id=? AND balance>=?', [debit, userId, debit]
    );
    if (!upd.affectedRows) throw new Error('余额不足，拒绝扣款');
  } else {
    await conn.execute('UPDATE users SET balance=balance+? WHERE id=?', [amount, userId]);
  }
  const [afterRows] = await conn.execute('SELECT CAST(balance AS CHAR) balance FROM users WHERE id=?', [userId]);
  const [insert] = await conn.execute(
    `INSERT INTO ledger_entries
      (user_id,entry_type,amount,balance_after,reference_type,reference_id,idempotency_key,note)
     VALUES (?,?,?,?,?,?,?,?)`,
    [userId, entryType, amount, afterRows[0].balance, referenceType, referenceId, idempotencyKey, note]
  );
  return { posted: true, duplicate: false, ledgerId: insert.insertId, balanceAfter: afterRows[0].balance };
}

async function creditRecharge(rechargeId, reviewer = 'system') {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [orders] = await conn.execute('SELECT * FROM recharge_orders WHERE id=? FOR UPDATE', [rechargeId]);
    const order = orders[0];
    if (!order) throw new Error('充值订单不存在');
    if (order.status === 'credited' || order.status === 'approved') {
      await conn.commit();
      return { credited: false, reason: 'already_processed' };
    }
    if (order.status !== 'pending') throw new Error('订单状态不允许审核');
    let depositAddress = null;
    if (order.source === 'tron') {
      const [walletRows] = await conn.execute(
        'SELECT address FROM wallets WHERE id=? AND user_id=? LIMIT 1',
        [order.wallet_id, order.user_id]
      );
      depositAddress = walletRows[0]?.address || null;
      if (!depositAddress) throw new Error('链上充值订单关联的钱包不存在，拒绝入账');
    }
    assertRechargeCanCredit(order, { walletAddress: depositAddress });
    const posting = await postBalanceEntry(conn, {
      userId: Number(order.user_id), delta: String(order.amount), entryType: 'deposit',
      referenceType: 'recharge', referenceId: order.id,
      idempotencyKey: `deposit:${order.id}`, note: `充值入账，审核人：${reviewer}`
    });
    if (!posting.posted) throw new Error('充值账本记录已存在，但订单仍待审核；需要财务核查，未重复入账');
    await conn.execute(
      "UPDATE recharge_orders SET status='credited', reviewed_by=?, reviewed_at=NOW() WHERE id=? AND status='pending'",
      [reviewer, order.id]
    );
    const [creditedUsers] = await conn.execute('SELECT telegram_id FROM users WHERE id=? LIMIT 1', [order.user_id]);
    if (creditedUsers[0]?.telegram_id) {
      await conn.execute(
        `INSERT IGNORE INTO event_outbox
          (event_key,aggregate_type,aggregate_id,event_type,payload_json,status,available_at)
         VALUES (?, 'recharge', ?, 'telegram.send', ?, 'pending', UTC_TIMESTAMP(3))`,
        [`recharge:${order.id}:credited:${creditedUsers[0].telegram_id}`, String(order.id),
          JSON.stringify({ telegramId: creditedUsers[0].telegram_id,
            text: `充值已审核入账\\n订单：#${order.id}\\n金额：${order.amount} USDT` })]
      );
    }
    await conn.execute(
      `INSERT IGNORE INTO event_outbox
        (event_key,aggregate_type,aggregate_id,event_type,payload_json,status,available_at)
       VALUES (?, 'recharge', ?, 'socket.emit', ?, 'pending', UTC_TIMESTAMP(3))`,
      [`recharge:${order.id}:credited:socket`, String(order.id),
        JSON.stringify({ eventName: 'recharge:credited', data: {
          orderId: order.id, userId: order.user_id, amount: String(order.amount), status: 'credited'
        } })]
    );
    const [refRows] = await conn.execute('SELECT referred_by FROM users WHERE id=?', [order.user_id]);
    if (refRows[0]?.referred_by) {
      const [settings] = await conn.execute("SELECT setting_value FROM app_settings WHERE setting_key='referral_commission_percent' LIMIT 1");
      const percent = Number(settings[0]?.setting_value ?? process.env.REFERRAL_COMMISSION_PERCENT ?? 3);
      if (Number.isFinite(percent) && percent > 0 && percent <= 100) {
        const amtMicros = toMicros(String(order.amount));
        // 微单位 × 百分比 ÷ 100，向下取整；百分比用 1/100 精度（如 3.25 → 325/10000）
        const pctScaled = BigInt(Math.round(percent * 100));
        const commissionMicros = (amtMicros * pctScaled) / 10000n;
        const amount = microsToDecimal(commissionMicros);
        if (commissionMicros > 0n) {
          const [existing] = await conn.execute('SELECT id FROM referral_commissions WHERE recharge_order_id=? FOR UPDATE', [order.id]);
          if (!existing.length) {
            const [referrers] = await conn.execute('SELECT id FROM users WHERE id=? FOR UPDATE', [refRows[0].referred_by]);
            if (referrers[0]) {
              const [comm] = await conn.execute(
                'INSERT INTO referral_commissions (referrer_user_id,referred_user_id,recharge_order_id,amount,percent) VALUES (?,?,?,?,?)',
                [referrers[0].id, order.user_id, order.id, amount, percent]
              );
              await postBalanceEntry(conn, {
                userId: Number(referrers[0].id), delta: amount, entryType: 'referral_bonus',
                referenceType: 'referral', referenceId: comm.insertId,
                idempotencyKey: `referral:${order.id}`, note: `邀请返佣 ${percent}%`
              });
            }
          }
        }
      }
    }
    await conn.commit();
    return { credited: true, amount: order.amount, userId: order.user_id };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally { conn.release(); }
}


const VALID_ENTRY_TYPES = new Set([
  'deposit', 'referral_bonus', 'energy_order_debit', 'refund', 'admin_adjustment'
]);
const VALID_REFERENCE_TYPES = new Set([
  'recharge', 'referral', 'withdrawal', 'energy_order', 'manual'
]);

module.exports = { creditRecharge, postBalanceEntry };
