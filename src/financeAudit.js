const { pool } = require('./db');

// Read-only integrity checks. Balance-vs-ledger differences are findings, not
// automatic repairs: legacy/manual opening balances may legitimately differ.
async function runFinanceAudit() {
  const checks = {};
  const [balance] = await pool.query(`
    SELECT u.id user_id, CAST(u.balance AS DECIMAL(30,6)) current_balance,
           CAST(COALESCE(SUM(le.amount),0) AS DECIMAL(30,6)) ledger_net,
           CAST(u.balance-COALESCE(SUM(le.amount),0) AS DECIMAL(30,6)) difference
      FROM users u LEFT JOIN ledger_entries le ON le.user_id=u.id
     GROUP BY u.id,u.balance
    HAVING ABS(u.balance-COALESCE(SUM(le.amount),0)) > 0.000001
     ORDER BY u.id LIMIT 500`);
  checks.balance_ledger_mismatch = balance;
  const [credited] = await pool.query(`
    SELECT r.id recharge_id,r.user_id,r.amount,r.status
      FROM recharge_orders r LEFT JOIN ledger_entries le
        ON le.reference_type='recharge' AND le.reference_id=r.id AND le.entry_type='deposit'
     WHERE r.status IN ('credited','approved') AND le.id IS NULL
     ORDER BY r.id DESC LIMIT 500`);
  checks.credited_recharge_missing_deposit_ledger = credited;
  const [approved] = await pool.query(`
    SELECT w.id withdrawal_id,w.user_id,w.amount,w.status
      FROM withdrawal_requests w LEFT JOIN ledger_entries le
        ON le.reference_type='withdrawal' AND le.reference_id=w.id
       AND le.idempotency_key=CONCAT('withdrawal-reserve:',w.id)
     WHERE w.status IN ('approved','paid') AND le.id IS NULL
     ORDER BY w.id DESC LIMIT 500`);
  checks.approved_withdrawal_missing_reserve_ledger = approved;
  const [rejected] = await pool.query(`
    SELECT w.id withdrawal_id,w.user_id,w.amount,w.status
      FROM withdrawal_requests w LEFT JOIN ledger_entries le
        ON le.reference_type='withdrawal' AND le.reference_id=w.id
       AND le.idempotency_key=CONCAT('withdrawal-refund:',w.id)
     WHERE w.status='rejected' AND w.reviewed_by IS NOT NULL
       AND EXISTS (SELECT 1 FROM admin_audit_logs a WHERE a.target_type='withdrawal'
                    AND a.target_id=CAST(w.id AS CHAR) AND a.action='withdrawal_approved')
       AND le.id IS NULL
     ORDER BY w.id DESC LIMIT 500`);
  checks.rejected_after_approval_missing_refund = rejected;
  const [dupes] = await pool.query(`
    SELECT tx_hash,COUNT(*) count, GROUP_CONCAT(id ORDER BY id) withdrawal_ids
      FROM withdrawal_requests WHERE tx_hash IS NOT NULL AND tx_hash<>''
     GROUP BY tx_hash HAVING COUNT(*)>1 ORDER BY COUNT(*) DESC LIMIT 200`);
  checks.duplicate_withdrawal_tx_hash = dupes;
  const counts = Object.fromEntries(Object.entries(checks).map(([k,v])=>[k,v.length]));
  return { ok: Object.values(counts).every(n=>n===0), checked_at: new Date().toISOString(), counts, findings: checks,
    note: '只读检查，不自动修复余额或账本。余额差异可能来自历史期初余额，须人工核实。' };
}
module.exports = { runFinanceAudit };
