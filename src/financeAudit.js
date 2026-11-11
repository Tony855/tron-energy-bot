'use strict';

const { pool: defaultPool } = require('./db');
const { decimalToRaw } = require('./tron');

function parseProof(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function validatePaidWithdrawalProof(row, { contract, decimals = 6 } = {}) {
  const proof = parseProof(row.chain_verified_json);
  let expectedRaw;
  try { expectedRaw = decimalToRaw(String(row.amount), decimals); } catch { return false; }
  if (!proof || !row.chain_verified_at ||
      !/^[a-f0-9]{64}$/i.test(String(row.tx_hash || '')) ||
      !/^[a-f0-9]{64}$/i.test(String(proof.tx_hash || row.tx_hash || '')) && proof.tx_hash != null ||
      (proof.tx_hash != null && String(proof.tx_hash).toLowerCase() !== String(row.tx_hash).toLowerCase()) ||
      !String(proof.contract || '').trim() ||
      (contract && String(proof.contract).toLowerCase() !== String(contract).toLowerCase()) ||
      String(proof.to || '').toLowerCase() !== String(row.destination_address || '').toLowerCase() ||
      String(proof.rawAmount ?? proof.raw_amount ?? '') !== expectedRaw ||
      String(proof.receiptResult ?? proof.receipt_result ?? '').toUpperCase() !== 'SUCCESS') {
    return false;
  }
  return true;
}

// Read-only integrity checks. Findings are never auto-repaired: historical
// opening balances and legacy records may require manual financial review.
function createFinanceAudit({ dbPool = defaultPool, env = process.env } = {}) {
  if (!dbPool || typeof dbPool.query !== 'function') throw new TypeError('A MySQL-compatible pool is required');

  async function runFinanceAudit() {
    const checks = {};
    const [balance] = await dbPool.query(`
      SELECT u.id user_id, CAST(u.balance AS DECIMAL(30,6)) current_balance,
             CAST(COALESCE(SUM(le.amount),0) AS DECIMAL(30,6)) ledger_net,
             CAST(u.balance-COALESCE(SUM(le.amount),0) AS DECIMAL(30,6)) difference
        FROM users u LEFT JOIN ledger_entries le ON le.user_id=u.id
       GROUP BY u.id,u.balance
      HAVING ABS(u.balance-COALESCE(SUM(le.amount),0)) > 0.000001
       ORDER BY u.id LIMIT 501`);
    checks.balance_ledger_mismatch = balance;

    const [credited] = await dbPool.query(`
      SELECT r.id recharge_id,r.user_id,r.amount,r.status
        FROM recharge_orders r LEFT JOIN ledger_entries le
          ON le.reference_type='recharge' AND le.reference_id=r.id AND le.entry_type='deposit'
       WHERE r.status IN ('credited','approved') AND le.id IS NULL
       ORDER BY r.id DESC LIMIT 501`);
    checks.credited_recharge_missing_deposit_ledger = credited;

    const [approved] = await dbPool.query(`
      SELECT w.id withdrawal_id,w.user_id,w.amount,w.status
        FROM withdrawal_requests w LEFT JOIN ledger_entries le
          ON le.reference_type='withdrawal' AND le.reference_id=w.id
         AND le.idempotency_key=CONCAT('withdrawal-reserve:',w.id)
       WHERE w.status IN ('approved','paid') AND le.id IS NULL
       ORDER BY w.id DESC LIMIT 501`);
    checks.approved_withdrawal_missing_reserve_ledger = approved;

    const [rejected] = await dbPool.query(`
      SELECT w.id withdrawal_id,w.user_id,w.amount,w.status
        FROM withdrawal_requests w LEFT JOIN ledger_entries le
          ON le.reference_type='withdrawal' AND le.reference_id=w.id
         AND le.idempotency_key=CONCAT('withdrawal-refund:',w.id)
       WHERE w.status='rejected' AND w.reviewed_by IS NOT NULL
         AND EXISTS (SELECT 1 FROM admin_audit_logs a WHERE a.target_type='withdrawal'
                      AND a.target_id=CAST(w.id AS CHAR) AND a.action='withdrawal_approved')
         AND le.id IS NULL
       ORDER BY w.id DESC LIMIT 501`);
    checks.rejected_after_approval_missing_refund = rejected;

    const [dupes] = await dbPool.query(`
      SELECT tx_hash,COUNT(*) count, GROUP_CONCAT(id ORDER BY id) withdrawal_ids
        FROM withdrawal_requests WHERE tx_hash IS NOT NULL AND tx_hash<>''
       GROUP BY tx_hash HAVING COUNT(*)>1 ORDER BY COUNT(*) DESC LIMIT 201`);
    checks.duplicate_withdrawal_tx_hash = dupes;

    const [paidRows] = await dbPool.query(`
      SELECT id withdrawal_id,amount,destination_address,status,tx_hash,chain_verified_at,chain_verified_json
        FROM withdrawal_requests WHERE status='paid'
       ORDER BY id DESC LIMIT 1001`);
    checks.paid_withdrawal_missing_or_mismatched_chain_proof = paidRows
      .filter(row => !validatePaidWithdrawalProof(row, {
        contract: env.TRON_USDT_CONTRACT,
        decimals: Number(env.TRON_USDT_DECIMALS || 6)
      }))
      .map(row => ({ withdrawal_id: row.withdrawal_id || row.id, tx_hash: row.tx_hash || null }));

    const [referrals] = await dbPool.query(`
      SELECT c.id commission_id,c.recharge_order_id,c.referrer_user_id,c.amount
        FROM referral_commissions c LEFT JOIN ledger_entries le
          ON le.reference_type='referral' AND le.reference_id=c.id
         AND le.entry_type='referral_bonus' AND le.idempotency_key=CONCAT('referral:',c.recharge_order_id)
       WHERE c.status='credited' AND le.id IS NULL
       ORDER BY c.id DESC LIMIT 501`);
    checks.credited_referral_missing_bonus_ledger = referrals;

    const truncated = [];
    for (const [key, rows, limit] of [
      ['balance_ledger_mismatch', balance, 500],
      ['credited_recharge_missing_deposit_ledger', credited, 500],
      ['approved_withdrawal_missing_reserve_ledger', approved, 500],
      ['rejected_after_approval_missing_refund', rejected, 500],
      ['duplicate_withdrawal_tx_hash', dupes, 200],
      ['paid_withdrawal_scan', paidRows, 1000],
      ['credited_referral_missing_bonus_ledger', referrals, 500]
    ]) {
      if (rows.length > limit) truncated.push({ check: key, limit });
      if (rows.length > limit) rows.length = limit;
    }
    checks.audit_result_truncated = truncated;
    const counts = Object.fromEntries(Object.entries(checks).map(([key, rows]) => [key, rows.length]));
    return {
      ok: Object.values(counts).every(count => count === 0),
      checked_at: new Date().toISOString(),
      counts,
      findings: checks,
      note: '只读检查，不自动修复余额或账本。余额差异可能来自历史期初余额；链上凭证或返佣差异须人工核实。'
    };
  }

  return Object.freeze({ runFinanceAudit });
}

const defaultAudit = createFinanceAudit();
async function runFinanceAudit() { return defaultAudit.runFinanceAudit(); }

module.exports = { createFinanceAudit, runFinanceAudit, validatePaidWithdrawalProof };
