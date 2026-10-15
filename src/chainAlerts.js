const { query } = require('./db');
const { sendTelegramMessage } = require('./notifier');
const { adminChats, fingerprint } = require('./chainAlertUtils');

let running = false;
async function checkAndAlert() {
  if (running) return { skipped: true, reason: 'already_running' };
  running = true;
  try {
    const minimum = Math.max(0, Number(process.env.MIN_DEPOSIT || 1));
    const [missing, mismatch] = await Promise.all([
      query(`SELECT t.id AS transaction_id,t.wallet_id,w.user_id,w.address AS deposit_address,t.tx_hash,t.event_index,t.amount,t.from_address,t.block_timestamp
        FROM transactions t JOIN wallets w ON w.id=t.wallet_id
        LEFT JOIN recharge_orders r ON r.wallet_id=t.wallet_id AND r.tx_hash=t.tx_hash AND r.event_index=t.event_index
        WHERE w.wallet_type='deposit' AND w.is_active=1 AND LOWER(t.to_address)=LOWER(w.address) AND t.confirmed=1 AND t.amount>=? AND r.id IS NULL
        ORDER BY t.id DESC LIMIT 200`, [minimum]),
      query(`SELECT t.id AS transaction_id,t.wallet_id,w.user_id,t.tx_hash,t.event_index,t.amount AS chain_amount,r.amount AS order_amount,r.id AS recharge_order_id,r.status AS recharge_status
        FROM transactions t JOIN wallets w ON w.id=t.wallet_id
        JOIN recharge_orders r ON r.wallet_id=t.wallet_id AND r.tx_hash=t.tx_hash AND r.event_index=t.event_index
        WHERE w.wallet_type='deposit' AND w.is_active=1 AND LOWER(t.to_address)=LOWER(w.address) AND t.confirmed=1 AND ABS(t.amount-r.amount)>0.000001
        ORDER BY t.id DESC LIMIT 200`)
    ]);
    const events = [...missing.map(row => ({ kind: 'missing_recharge_order', row })), ...mismatch.map(row => ({ kind: 'amount_mismatch', row }))];
    let newAlerts = 0;
    const chats = adminChats();
    for (const event of events) {
      const fp = fingerprint(event.kind, event.row);
      const result = await query('INSERT IGNORE INTO chain_alert_events (fingerprint,alert_type,tx_hash,event_index,wallet_id,details_json) VALUES (?,?,?,?,?,?)',
        [fp, event.kind, event.row.tx_hash, event.row.event_index ?? 0, event.row.wallet_id, JSON.stringify(event.row)]);
      if (!result.affectedRows) continue;
      newAlerts++;
      const r = event.row;
      const message = `⚠️ TRON 充值审计异常\n类型：${event.kind === 'missing_recharge_order' ? '链上入账缺少充值单' : '链上金额与充值单不一致'}\n充值地址：${r.deposit_address || '(请在后台核对)'}\n交易：${r.tx_hash}\n事件序号：${r.event_index}\n链上金额：${r.amount ?? r.chain_amount ?? '未知'} USDT${r.order_amount !== undefined ? `\n充值单金额：${r.order_amount} USDT` : ''}\n钱包 ID：${r.wallet_id}\n处理建议：人工核验链上交易与充值归属；本告警不会修改余额。`;
      for (const chat of chats) await sendTelegramMessage(chat, message);
    }
    return { checked_missing: missing.length, checked_mismatch: mismatch.length, new_alerts: newAlerts, admin_chats_configured: chats.length };
  } finally { running = false; }
}
function startChainAlerts() {
  const seconds = Math.max(300, Number(process.env.CHAIN_AUDIT_INTERVAL_SECONDS || 900));
  if (process.env.CHAIN_ALERTS_ENABLED !== 'true') {
    console.log('[chain-alerts] disabled; set CHAIN_ALERTS_ENABLED=true to enable scheduled alerts');
    return;
  }
  setTimeout(() => checkAndAlert().catch(e => console.error('[chain-alerts]', e.message)), 15000);
  setInterval(() => checkAndAlert().catch(e => console.error('[chain-alerts]', e.message)), seconds * 1000);
  console.log(`[chain-alerts] enabled; interval=${seconds}s`);
}
module.exports = { checkAndAlert, startChainAlerts, adminChats };
