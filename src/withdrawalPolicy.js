'use strict';

// Decimal-safe policy helpers. Amounts are represented in integer micro-USDT.
function toMicros(value) {
  const s = String(value ?? '').trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(s)) throw new Error('金额格式无效，最多 6 位小数');
  const [whole, fraction = ''] = s.split('.');
  return BigInt(whole) * 1000000n + BigInt((fraction + '000000').slice(0, 6));
}
function limitMicros(value, name) {
  if (value == null || String(value).trim() === '' || Number(value) <= 0) return 0n;
  try { return toMicros(String(value)); } catch { throw new Error(`${name} 配置无效`); }
}
function validateWithdrawalAmount(amount, env = process.env) {
  const amountMicros = toMicros(amount);
  if (amountMicros <= 0n) throw new Error('提现金额必须大于 0');
  const minimum = limitMicros(env.WITHDRAWAL_MINIMUM || '5', 'WITHDRAWAL_MINIMUM');
  const maximum = limitMicros(env.WITHDRAWAL_MAXIMUM, 'WITHDRAWAL_MAXIMUM');
  if (amountMicros < minimum) throw new Error(`最低提现金额为 ${env.WITHDRAWAL_MINIMUM || '5'} USDT`);
  if (maximum > 0n && amountMicros > maximum) throw new Error(`单笔提现不能超过 ${env.WITHDRAWAL_MAXIMUM} USDT`);
  return amountMicros;
}
function validatePendingCount(count, env = process.env) {
  const max = Number.parseInt(env.WITHDRAWAL_MAX_PENDING || '0', 10);
  if (Number.isInteger(max) && max > 0 && Number(count) >= max) {
    throw new Error(`待处理提现单已达到上限（${max} 笔），请等待管理员处理`);
  }
}
function validateDailyTotal(currentTotal, amount, env = process.env) {
  const limit = limitMicros(env.WITHDRAWAL_DAILY_LIMIT, 'WITHDRAWAL_DAILY_LIMIT');
  if (limit === 0n) return;
  if (toMicros(currentTotal) + toMicros(amount) > limit) {
    throw new Error(`今日提现申请总额超过限额 ${env.WITHDRAWAL_DAILY_LIMIT} USDT`);
  }
}
module.exports = { toMicros, validateWithdrawalAmount, validatePendingCount, validateDailyTotal };
