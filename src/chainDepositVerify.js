const { decimalToRaw } = require('./tron');

function assertRechargeCanCredit(order) {
  if (order && order.source === 'tron' && !order.chain_verified_at) {
    throw new Error('链上充值必须先完成链上核验，拒绝直接入账');
  }
}

function verifyDepositTransfer(transfers, expected) {
  const contract = String(expected.contract || '').trim().toLowerCase();
  const to = String(expected.to || '').trim().toLowerCase();
  if (!contract) throw new Error('未配置 TRON_USDT_CONTRACT，拒绝验证充值');
  if (!to) throw new Error('充值订单没有关联充值地址');
  const decimals = Number(expected.decimals ?? 6);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('代币精度配置无效');
  const expectedRaw = decimalToRaw(String(expected.amount), decimals);
  const candidates = (Array.isArray(transfers) ? transfers : []).filter(t =>
    t && t.confirmed === true &&
    String(t.contract || '').toLowerCase() === contract &&
    String(t.to || '').toLowerCase() === to &&
    Number(t.decimals) === decimals &&
    String(t.rawAmount) === expectedRaw
  );
  if (candidates.length !== 1) {
    throw new Error(candidates.length > 1
      ? '同一交易存在多个完全匹配的充值事件，需人工核验'
      : '链上交易与充值单的 USDT 合约、充值地址或金额不匹配');
  }
  return {
    verified: true,
    tx_hash: String(candidates[0].txHash || '').toLowerCase(),
    contract: String(candidates[0].contract),
    from: String(candidates[0].from || ''),
    to: String(candidates[0].to),
    raw_amount: expectedRaw,
    amount: String(expected.amount),
    decimals,
    confirmed: true,
    receipt_result: candidates[0].receiptResult || 'SUCCESS',
    block_timestamp: candidates[0].blockTimestamp || null
  };
}

module.exports = { verifyDepositTransfer, assertRechargeCanCredit };
