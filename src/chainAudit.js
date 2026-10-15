function classifyTransfer(transfer, order, minDeposit = 1) {
  const amount = Number(transfer.amount);
  const minimum = Number(minDeposit);
  if (!Number.isFinite(amount) || amount <= 0) return { type: 'invalid_amount', severity: 'high' };
  if (amount < minimum) return { type: 'below_minimum', severity: 'info' };
  if (!order) return { type: 'missing_recharge_order', severity: 'high' };
  const orderAmount = Number(order.amount);
  if (!Number.isFinite(orderAmount) || Math.abs(amount - orderAmount) > 0.000001) {
    return { type: 'amount_mismatch', severity: 'high' };
  }
  return { type: 'matched', severity: 'ok' };
}
module.exports = { classifyTransfer };
