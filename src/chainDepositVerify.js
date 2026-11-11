'use strict';

const { decimalToRaw } = require('./tron');

function parseVerification(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function assertRechargeCanCredit(order, { walletAddress, env = process.env } = {}) {
  if (!order || order.source !== 'tron') return;
  if (!order.chain_verified_at) {
    throw new Error('链上充值必须先完成链上核验，拒绝直接入账');
  }

  const verification = parseVerification(order.chain_verified_json);
  const txHash = String(order.tx_hash || '').toLowerCase();
  const proofHash = String(verification?.tx_hash || '').toLowerCase();
  const configuredContract = String(env.TRON_USDT_CONTRACT || '').trim();
  const contract = String(verification?.contract || '').trim();
  const configuredDecimals = Number(env.TRON_USDT_DECIMALS || 6);
  const decimals = Number(verification?.decimals);
  const destination = String(verification?.to || '').trim();
  const expectedDestination = String(walletAddress || '').trim();
  let expectedRaw = null;
  try {
    if (Number.isInteger(decimals) && decimals >= 0 && decimals <= 18) {
      expectedRaw = decimalToRaw(String(order.amount), decimals);
    }
  } catch {}

  const rawAmount = String(verification?.raw_amount ?? verification?.rawAmount ?? '');
  const receiptResult = String(verification?.receipt_result ?? verification?.receiptResult ?? '').toUpperCase();
  if (!verification || verification.verified !== true || verification.confirmed !== true ||
      !/^[a-f0-9]{64}$/.test(txHash) || !/^[a-f0-9]{64}$/.test(proofHash) ||
      proofHash !== txHash || !contract ||
      (!configuredContract || contract !== configuredContract) ||
      !Number.isInteger(configuredDecimals) || configuredDecimals < 0 || configuredDecimals > 18 ||
      decimals !== configuredDecimals || !destination ||
      (expectedDestination && destination !== expectedDestination) ||
      !expectedRaw || !/^\d+$/.test(rawAmount) || rawAmount !== expectedRaw ||
      receiptResult !== 'SUCCESS') {
    throw new Error('链上充值核验凭证无效或与订单不匹配，拒绝入账');
  }
}

function verifyDepositTransfer(transfers, expected) {
  const contract = String(expected.contract || '').trim();
  const to = String(expected.to || '').trim();
  if (!contract) throw new Error('未配置 TRON_USDT_CONTRACT，拒绝验证充值');
  if (!to) throw new Error('充值订单没有关联充值地址');
  const decimals = Number(expected.decimals ?? 6);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('代币精度配置无效');
  const expectedRaw = decimalToRaw(String(expected.amount), decimals);
  const candidates = (Array.isArray(transfers) ? transfers : []).filter(t => {
    const txHash = String(t?.txHash || t?.tx_hash || '').toLowerCase();
    const receiptResult = String(t?.receiptResult ?? t?.receipt_result ?? '').toUpperCase();
    const rawAmount = String(t?.rawAmount ?? t?.raw_amount ?? '');
    return t && t.confirmed === true &&
      /^[a-f0-9]{64}$/.test(txHash) &&
      receiptResult === 'SUCCESS' &&
      /^\d+$/.test(rawAmount) && BigInt(rawAmount) > 0n &&
      String(t.contract || '') === contract &&
      String(t.to || '') === to &&
      Number(t.decimals) === decimals &&
      rawAmount === expectedRaw;
  });
  if (candidates.length !== 1) {
    throw new Error(candidates.length > 1
      ? '同一交易存在多个完全匹配的充值事件，需人工核验'
      : '链上交易与充值单的 USDT 合约、充值地址、金额或成功回执不匹配');
  }
  const transfer = candidates[0];
  return {
    verified: true,
    tx_hash: String(transfer.txHash || transfer.tx_hash).toLowerCase(),
    contract: String(transfer.contract),
    from: String(transfer.from || ''),
    to: String(transfer.to),
    raw_amount: expectedRaw,
    amount: String(expected.amount),
    decimals,
    confirmed: true,
    receipt_result: 'SUCCESS',
    block_timestamp: transfer.blockTimestamp || transfer.block_timestamp || null
  };
}

module.exports = { verifyDepositTransfer, assertRechargeCanCredit };
