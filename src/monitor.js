const { query, pool } = require('./db');
const { getTrc20Transfers, getTrxTransfers, extractTrxTransfers, rawToDecimal } = require('./tron');
const { sendTelegramMessage } = require('./notifier');

let running = false;
const PAGE_SIZE = Math.min(200, Math.max(1, Number(process.env.TRON_SCAN_PAGE_SIZE || 200)));
const MAX_PAGES = Math.min(20, Math.max(1, Number(process.env.TRON_SCAN_MAX_PAGES || 5)));
const OVERLAP_MS = Math.max(60_000, Number(process.env.TRON_SCAN_OVERLAP_MS || 300_000));
const BACKFILL_HOURS = Math.max(1, Number(process.env.TRON_INITIAL_BACKFILL_HOURS || 24));

async function scanOnce() {
  if (running) return { skipped: true };
  running = true;
  const summary = { wallets: 0, pages: 0, transfers: 0, errors: 0, incomplete: 0 };
  try {
    const wallets = await query("SELECT * FROM wallets WHERE is_active=1 ORDER BY id ASC");
    for (const wallet of wallets) {
      summary.wallets++;
      try {
        const [stateRows] = await pool.query(
          'SELECT scan_from_timestamp,trc20_cursor,trx_cursor FROM wallets WHERE id=?', [wallet.id]
        );
        const state = stateRows[0] || {};
        let fromTimestamp = Number(state.scan_from_timestamp || 0);
        if (!fromTimestamp) {
          fromTimestamp = wallet.last_scanned_at
            ? Math.max(0, new Date(wallet.last_scanned_at).getTime() - OVERLAP_MS)
            : Date.now() - BACKFILL_HOURS * 3600_000;
          await query('UPDATE wallets SET scan_from_timestamp=? WHERE id=? AND scan_from_timestamp IS NULL', [fromTimestamp, wallet.id]);
        }

        const tokenResult = await scanWalletType(wallet, 'trc20', state.trc20_cursor, fromTimestamp, summary);
        const trxResult = await scanWalletType(wallet, 'trx', state.trx_cursor, fromTimestamp, summary);
        const done = tokenResult.done && trxResult.done;
        if (done) {
          const nextFrom = Math.max(0, Date.now() - OVERLAP_MS);
          await query('UPDATE wallets SET last_scanned_at=NOW(),scan_from_timestamp=?,trc20_cursor=NULL,trx_cursor=NULL WHERE id=?', [nextFrom, wallet.id]);
        } else {
          summary.incomplete++;
        }
      } catch (e) {
        summary.errors++;
        console.error(`[monitor] wallet ${wallet.id}:`, e.message);
      }
    }
    console.log(`[monitor] scan summary ${JSON.stringify(summary)}`);
    return summary;
  } finally { running = false; }
}

async function scanWalletType(wallet, type, savedCursor, minTimestamp, summary) {
  let fingerprint = savedCursor || null;
  let pages = 0;
  let exhausted = false;
  while (pages < MAX_PAGES) {
    const options = { limit: PAGE_SIZE, minTimestamp, fingerprint };
    const response = type === 'trc20'
      ? await getTrc20Transfers(wallet.address, options)
      : await getTrxTransfers(wallet.address, options);
    pages++;
    summary.pages++;
    const records = type === 'trc20'
      ? normalizeTrc20(response, wallet)
      : extractTrxTransfers(response, wallet.address);
    for (const record of records) {
      await saveTransfer(wallet, record, type);
      summary.transfers++;
    }
    const next = response?.meta?.fingerprint || null;
    if (next && next !== fingerprint) {
      fingerprint = next;
      await query(`UPDATE wallets SET ${type === 'trc20' ? 'trc20_cursor' : 'trx_cursor'}=? WHERE id=?`, [fingerprint, wallet.id]);
    } else {
      exhausted = true;
      await query(`UPDATE wallets SET ${type === 'trc20' ? 'trc20_cursor' : 'trx_cursor'}=NULL WHERE id=?`, [wallet.id]);
      break;
    }
    if (!Array.isArray(response?.data) || response.data.length < PAGE_SIZE) {
      exhausted = true;
      await query(`UPDATE wallets SET ${type === 'trc20' ? 'trc20_cursor' : 'trx_cursor'}=NULL WHERE id=?`, [wallet.id]);
      break;
    }
  }
  return { done: exhausted };
}

function normalizeTrc20(response, wallet) {
  return (Array.isArray(response?.data) ? response.data : []).map(t => {
    const txHash = String(t.transaction_id || '').toLowerCase();
    const eventIndex = Number(t.event_index || 0);
    const contract = String(t.token_info?.address || '');
    const from = String(t.from || '');
    const to = String(t.to || '');
    if (!/^[0-9a-f]{64}$/.test(txHash) || !contract || !from || !to) return null;
    if (process.env.TRON_USDT_CONTRACT && contract.toLowerCase() !== process.env.TRON_USDT_CONTRACT.toLowerCase()) return null;
    if (from.toLowerCase() !== wallet.address.toLowerCase() && to.toLowerCase() !== wallet.address.toLowerCase()) return null;
    const decimals = Number(t.token_info?.decimals ?? process.env.TRON_USDT_DECIMALS ?? 6);
    let amount;
    try { amount = rawToDecimal(t.value || '0', decimals); } catch { return null; }
    if (BigInt(String(t.value || '0')) <= 0n) return null;
    return { txHash, eventIndex, contract, from, to, amount, blockTimestamp: t.block_timestamp || null, confirmed: true, type: 'trc20' };
  }).filter(Boolean);
}

async function saveTransfer(wallet, t, type) {

  // Financial credit is deliberately handled only by the verified recharge service.\n  const conn = await pool.getConnection();
  let rechargeId = null;
  let inserted = false;
  try {
    await conn.beginTransaction();
    const [exists] = await conn.execute(
      'SELECT id FROM transactions WHERE wallet_id=? AND tx_hash=? AND event_index=? FOR UPDATE',
      [wallet.id, t.txHash, t.eventIndex]
    );
    if (exists.length) { await conn.commit(); return false; }
    await conn.execute(
      `INSERT INTO transactions (wallet_id,tx_hash,event_index,token_contract,from_address,to_address,amount,block_timestamp,confirmed)
       VALUES (?,?,?,?,?,?,?,?,1)`,
      [wallet.id, t.txHash, t.eventIndex, t.contract, t.from, t.to, t.amount, t.blockTimestamp]
    );
    inserted = true;
    const incoming = t.to.toLowerCase() === wallet.address.toLowerCase();
    if (type === 'trc20' && incoming && wallet.wallet_type === 'deposit' && Number(t.amount) >= Number(process.env.MIN_DEPOSIT || 1)) {
      const [ins] = await conn.execute(
        `INSERT INTO recharge_orders (user_id,wallet_id,tx_hash,event_index,amount,currency,source,status,note)
         VALUES (?,?,?,?,?,'USDT','tron','pending',?)`,
        [wallet.user_id, wallet.id, t.txHash, t.eventIndex, t.amount, '已由已确认 TRC20 转账识别；默认仍需管理员审核']
      );
      rechargeId = ins.insertId;
    }
    if (inserted) {
      // Persist external notifications atomically with the indexed transfer.
      await conn.execute(
        `INSERT IGNORE INTO event_outbox
          (event_key,aggregate_type,aggregate_id,event_type,payload_json,status,available_at)
         VALUES (?, 'wallet', ?, 'socket.emit', ?, 'pending', UTC_TIMESTAMP(3))`,
        [`tron-transfer:${wallet.id}:${t.txHash}:${t.eventIndex}:socket`, String(wallet.id),
          JSON.stringify({ eventName: 'tron:transfer', data: {
            walletId: wallet.id, txHash: t.txHash, amount: t.amount, from: t.from, to: t.to,
            token: type === 'trx' ? 'TRX' : 'USDT', confirmed: true
          } })]
      );
      if (rechargeId) {
        const adminIds = [...new Set(String(process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(x => x.trim()).filter(x => /^-?\d+$/.test(x)))];
        const alert = `新链上充值待审核\n订单：#${rechargeId}\n用户：#${wallet.user_id}\n金额：${t.amount} USDT\n地址：${wallet.address}\n交易：${t.txHash}\n请先核验链上交易，再审核入账。`;
        for (const adminId of adminIds) {
          await conn.execute(
            `INSERT IGNORE INTO event_outbox
              (event_key,aggregate_type,aggregate_id,event_type,payload_json,status,available_at)
             VALUES (?, 'recharge', ?, 'telegram.send', ?, 'pending', UTC_TIMESTAMP(3))`,
            [`recharge:${rechargeId}:admin:${adminId}`, String(rechargeId),
              JSON.stringify({ telegramId: adminId, text: alert })]
          );
        }
      }
      const stamp = Number(t.blockTimestamp || 0);
      if (stamp > 0 && Date.now() - stamp <= 15 * 60 * 1000) {
        const incoming = t.to.toLowerCase() === wallet.address.toLowerCase();
        const [users] = await conn.execute('SELECT telegram_id FROM users WHERE id=?', [wallet.user_id]);
        if (users[0]?.telegram_id) {
          const unit = type === 'trx' ? 'TRX' : 'USDT-TRC20';
          const shortHash = `${t.txHash.slice(0, 10)}...${t.txHash.slice(-8)}`;
          const message = `TRON 地址交易提醒\n类型：${incoming ? '收到转账' : '转出转账'}\n资产：${unit}\n金额：${t.amount}\n对方地址：${incoming ? t.from : t.to}\n交易：${shortHash}\n状态：已确认\n监控地址：${wallet.address}`;
          await conn.execute(
            `INSERT IGNORE INTO event_outbox
              (event_key,aggregate_type,aggregate_id,event_type,payload_json,status,available_at)
             VALUES (?, 'wallet', ?, 'telegram.send', ?, 'pending', UTC_TIMESTAMP(3))`,
            [`tron-transfer:${wallet.id}:${t.txHash}:${t.eventIndex}:user`, String(wallet.id),
              JSON.stringify({ telegramId: users[0].telegram_id, text: message })]
          );
        }
      }
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    if (e.code !== 'ER_DUP_ENTRY') throw e;
  } finally { conn.release(); }

  return inserted;
}

function startMonitor() {
  const seconds = Math.max(30, Number(process.env.TRON_POLL_SECONDS || 60));
  setInterval(() => scanOnce().catch(e => console.error('[monitor] scan failed:', e.message)), seconds * 1000);
  setTimeout(() => scanOnce().catch(e => console.error('[monitor] initial scan failed:', e.message)), 3000);
  console.log(`[monitor] started; interval=${seconds}s; pageSize=${PAGE_SIZE}; maxPages=${MAX_PAGES}`);
}

module.exports = { startMonitor, scanOnce, normalizeTrc20, saveTransfer };
