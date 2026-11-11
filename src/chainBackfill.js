const { query, pool } = require('./db');
const { getTrc20Transfers, rawToDecimal } = require('./tron');
const { parseDateRange } = require('./dateRange');

async function indexTransfer(wallet, t, minDeposit) {
  const txHash = String(t.transaction_id || '');
  const eventIndex = Number(t.event_index || 0);
  const contract = String(t.token_info?.address || '');
  const from = String(t.from || '');
  const to = String(t.to || '');
  if (!txHash || !/^[a-fA-F0-9]{64}$/.test(txHash) || !contract || !from || !to) return { skipped: true };
  const configuredContract = String(process.env.TRON_USDT_CONTRACT || '');
  if (!configuredContract || contract !== configuredContract) return { skipped: true };
  if (to !== wallet.address && from !== wallet.address) return { skipped: true };
  const configuredDecimals = Number(process.env.TRON_USDT_DECIMALS || 6);
  const decimals = Number(t.token_info?.decimals ?? configuredDecimals);
  if (!Number.isInteger(configuredDecimals) || configuredDecimals < 0 || configuredDecimals > 18 || decimals !== configuredDecimals) return { skipped: true };
  const amount = rawToDecimal(t.value || '0', decimals);
  if (BigInt(String(t.value || '0')) <= 0n) return { skipped: true };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      `INSERT IGNORE INTO transactions (wallet_id,tx_hash,event_index,token_contract,from_address,to_address,amount,block_timestamp,confirmed)
       VALUES (?,?,?,?,?,?,?,?,1)`,
      [wallet.id, txHash, eventIndex, contract, from, to, amount, t.block_timestamp || null]
    );
    let rechargeCreated = false;
    if (wallet.wallet_type === 'deposit' && to === wallet.address && Number(amount) >= minDeposit) {
      const [existing] = await conn.execute('SELECT id FROM recharge_orders WHERE tx_hash=? AND event_index=? LIMIT 1 FOR UPDATE', [txHash, eventIndex]);
      if (!existing.length) {
        await conn.execute(
          `INSERT IGNORE INTO recharge_orders (user_id,wallet_id,tx_hash,event_index,amount,currency,source,status,note)
           VALUES (?,?,?, ?,?,'USDT','tron','pending',?)`,
          [wallet.user_id, wallet.id, txHash, eventIndex, amount, '历史补扫发现的已确认转账；待管理员核验，未自动入账']
        );
        rechargeCreated = true;
      }
    }
    await conn.commit();
    return { indexed: true, rechargeCreated };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally { conn.release(); }
}

async function runBackfill({ from, to, admin, pagesPerWallet = 3 }) {
  const { fromMs, toMs } = parseDateRange(from, to);
  const maxPages = Math.min(5, Math.max(1, Number(pagesPerWallet) || 3));
  const wallets = await query("SELECT * FROM wallets WHERE is_active=1 AND wallet_type='deposit' ORDER BY id ASC");
  const results = [];
  const minDeposit = Math.max(0, Number(process.env.MIN_DEPOSIT || 1));
  for (const wallet of wallets) {
    let [states] = await query('SELECT * FROM chain_backfill_state WHERE wallet_id=? AND from_timestamp=? AND to_timestamp=?', [wallet.id, fromMs, toMs]);
    if (states && states.status === 'completed') {
      results.push({ wallet_id: wallet.id, status: 'completed', pages_scanned: states.pages_scanned, transfers_seen: states.transfers_seen });
      continue;
    }
    if (!states) {
      const ins = await query("INSERT INTO chain_backfill_state (wallet_id,from_timestamp,to_timestamp,status,started_by) VALUES (?,?,?,'running',?)", [wallet.id, fromMs, toMs, admin]);
      states = { id: ins.insertId, fingerprint: null, pages_scanned: 0, transfers_seen: 0, status: 'running' };
    }
    let fingerprint = states.fingerprint;
    let pages = 0, seen = 0, error = null, completed = false;
    try {
      while (pages < maxPages) {
        const result = await getTrc20Transfers(wallet.address, { limit: 200, fingerprint, minTimestamp: fromMs, maxTimestamp: toMs });
        const transfers = Array.isArray(result.data) ? result.data : [];
        for (const transfer of transfers) {
          await indexTransfer(wallet, transfer, minDeposit);
          seen++;
        }
        pages++;
        const next = result.meta?.fingerprint || null;
        if (!transfers.length || !next || next === fingerprint) {
          completed = true;
          fingerprint = null;
          break;
        }
        fingerprint = next;
      }
      await query("UPDATE chain_backfill_state SET fingerprint=?,status=?,pages_scanned=pages_scanned+?,transfers_seen=transfers_seen+?,last_error=NULL WHERE id=?",
        [fingerprint, completed ? 'completed' : 'running', pages, seen, states.id]);
    } catch (e) {
      error = String(e.message || e).slice(0, 500);
      await query("UPDATE chain_backfill_state SET status='error',last_error=? WHERE id=?", [error, states.id]);
    }
    results.push({ wallet_id: wallet.id, status: error ? 'error' : completed ? 'completed' : 'running', pages_this_run: pages, transfers_seen_this_run: seen, error });
  }
  return { from, to, wallets_processed: results.length, max_pages_per_wallet: maxPages, results,
    disclaimer: '仅扫描当前启用的专属充值地址及配置的 TRC20 合约；补扫发现的充值单保持 pending，不会自动入账。API 返回的确认状态仍应结合区块浏览器/可信节点复核。' };
}

module.exports = { runBackfill };
