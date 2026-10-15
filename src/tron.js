const crypto = require('crypto');
const BASE = (process.env.TRON_API_BASE || 'https://api.trongrid.io').replace(/\/$/, '');

function headers() {
  const h = { 'content-type': 'application/json' };
  if (process.env.TRONGRID_API_KEY) h['TRON-PRO-API-KEY'] = process.env.TRONGRID_API_KEY;
  return h;
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: headers(), body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`TRON API HTTP ${res.status}`);
  return res.json();
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: headers(), signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`TRON API HTTP ${res.status}`);
  return res.json();
}

function validateAddress(address) {
  if (typeof address !== 'string' || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return false;
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = 0n;
  for (const ch of address) {
    const digit = alphabet.indexOf(ch);
    if (digit < 0) return false;
    value = value * 58n + BigInt(digit);
  }
  let hex = value.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let decoded = Buffer.from(hex, 'hex');
  let leadingZeros = 0;
  while (leadingZeros < address.length && address[leadingZeros] === '1') leadingZeros++;
  if (leadingZeros) decoded = Buffer.concat([Buffer.alloc(leadingZeros), decoded]);
  if (decoded.length !== 25 || decoded[0] !== 0x41) return false;
  const payload = decoded.subarray(0, 21);
  const checksum = decoded.subarray(21);
  const first = crypto.createHash('sha256').update(payload).digest();
  const second = crypto.createHash('sha256').update(first).digest();
  return crypto.timingSafeEqual(checksum, second.subarray(0, 4));
}

function rawToDecimal(raw, decimals) {
  const n = BigInt(String(raw || '0'));
  const d = BigInt(10) ** BigInt(decimals);
  const whole = n / d;
  const fraction = (n % d).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

async function getAccount(address) {
  const account = await post('/wallet/getaccount', {
    address, visible: true
  });
  const resources = await post('/wallet/getaccountresource', {
    address, visible: true
  });

  const accountResource = account.account_resource || {};

  return {
    address,
    trx: (Number(account.balance || 0) / 1e6).toFixed(6),

    // Energy 额度来自账户自己的资源上限，不使用全网参数。
    // 未返回的字段使用 null，避免把未知数据伪装成 0。
    energyLimit: resources.EnergyLimit == null
      ? null : Number(resources.EnergyLimit),
    energyUsed: resources.EnergyUsed != null
      ? Number(resources.EnergyUsed)
      : accountResource.energy_usage != null
        ? Number(accountResource.energy_usage) : null,

    // 质押带宽与免费带宽分别返回。
    netLimit: resources.NetLimit == null
      ? null : Number(resources.NetLimit),
    netUsed: resources.NetUsed != null
      ? Number(resources.NetUsed)
      : account.net_usage != null
        ? Number(account.net_usage) : null,
    freeNetLimit: resources.freeNetLimit == null
      ? null : Number(resources.freeNetLimit),
    freeNetUsed: account.free_net_usage == null
      ? null : Number(account.free_net_usage)
  };
}

async function getTransactionInfo(txHash) {
  if (!/^[0-9a-fA-F]{64}$/.test(String(txHash || ''))) throw new Error('无效 TRON 交易哈希');
  return post('/wallet/gettransactioninfobyid', { value: String(txHash).toLowerCase() });
}

async function getConfirmedTrc20Transfer(txHash) {
  if (!/^[0-9a-fA-F]{64}$/.test(String(txHash || ''))) throw new Error('无效 TRON 交易哈希');
  const [info, eventData] = await Promise.all([
    getTransactionInfo(txHash),
    get(`/v1/transactions/${encodeURIComponent(txHash.toLowerCase())}/events?only_confirmed=true&limit=200`)
  ]);
  if (!info || !info.id) throw new Error('TRON 节点未找到该交易');
  if (info.receipt?.result !== 'SUCCESS') throw new Error('链上交易尚未成功确认');
  const events = Array.isArray(eventData?.data) ? eventData.data : [];
  const transfers = events.filter(e =>
    String(e.event_name || '') === 'Transfer' &&
    String(e.transaction_id || '').toLowerCase() === String(txHash).toLowerCase() &&
    e.result && e.contract_address
  );
  if (!transfers.length) throw new Error('未找到该交易的已确认 TRC20 Transfer 事件');
  return transfers.map(e => ({
    txHash: String(e.transaction_id).toLowerCase(),
    contract: String(e.contract_address),
    from: String(e.result.from || ''),
    to: String(e.result.to || ''),
    rawAmount: String(e.result.value || ''),
    decimals: Number(e.token_info?.decimals ?? 6),
    blockTimestamp: e.block_timestamp || null,
    confirmed: true,
    receiptResult: info.receipt.result
  }));
}

function decimalToRaw(value, decimals = 6) {
  const s = String(value ?? '').trim();
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(s)) throw new Error('金额格式无效');
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) throw new Error('金额小数位超出代币精度');
  return (BigInt(whole) * (10n ** BigInt(decimals)) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0')).toString();
}

function matchWithdrawalTransfer(transfers, expected) {
  const contract = String(expected.contract || '').toLowerCase();
  const to = String(expected.to || '').toLowerCase();
  const amount = String(expected.rawAmount);
  const matches = (transfers || []).filter(t =>
    t.confirmed === true && String(t.contract || '').toLowerCase() === contract &&
    String(t.to || '').toLowerCase() === to && String(t.rawAmount) === amount
  );
  if (matches.length !== 1) throw new Error(matches.length ? '交易中存在多个匹配转账事件，需人工核验' : '链上交易的合约、收款地址或金额与提现单不一致');
  return matches[0];
}

async function getTrxTransfers(address, options = {}) {
  const limit = Math.min(200, Math.max(1, Number(options.limit || 50)));
  const params = new URLSearchParams({
    only_confirmed: 'true', limit: String(limit),
    order_by: 'block_timestamp,asc'
  });
  if (options.fingerprint) params.set('fingerprint', String(options.fingerprint));
  if (options.minTimestamp != null) params.set('min_timestamp', String(options.minTimestamp));
  if (options.maxTimestamp != null) params.set('max_timestamp', String(options.maxTimestamp));
  return get(`/v1/accounts/${encodeURIComponent(address)}/transactions?${params}`);
}

function extractTrxTransfers(response, walletAddress) {
  const data = Array.isArray(response?.data) ? response.data : [];
  const normalizedWallet = String(walletAddress || '').toLowerCase();
  const result = [];
  for (const tx of data) {
    const txHash = String(tx.txID || tx.txid || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txHash)) continue;
    const ret = Array.isArray(tx.ret) ? tx.ret : [];
    if (ret.length && ret[0].contractRet && ret[0].contractRet !== 'SUCCESS') continue;
    const contracts = tx.raw_data?.contract || [];
    for (let i = 0; i < contracts.length; i++) {
      const c = contracts[i];
      if (c.type !== 'TransferContract') continue;
      const v = c.parameter?.value || {};
      let from = String(v.owner_address || '');
      let to = String(v.to_address || '');
      // TRON API can return hex addresses when visible=false; convert only if it is a valid 21-byte 41-prefixed address.
      const fromHex = from.replace(/^0x/i, '');
      const toHex = to.replace(/^0x/i, '');
      if (/^41[0-9a-fA-F]{40}$/.test(fromHex)) from = hexAddressToBase58(fromHex);
      if (/^41[0-9a-fA-F]{40}$/.test(toHex)) to = hexAddressToBase58(toHex);
      if (!from || !to || (from.toLowerCase() !== normalizedWallet && to.toLowerCase() !== normalizedWallet)) continue;
      const rawAmount = String(v.amount ?? '0');
      if (!/^\d+$/.test(rawAmount) || BigInt(rawAmount) <= 0n) continue;
      result.push({
        txHash, eventIndex: -1 - i, contract: 'TRX_NATIVE', from, to,
        amount: rawToDecimal(rawAmount, 6), blockTimestamp: tx.block_timestamp || null,
        confirmed: true
      });
    }
  }
  return result;
}

function hexAddressToBase58(hexAddress) {
  const bytes = Buffer.from(hexAddress, 'hex');
  if (bytes.length !== 21 || bytes[0] !== 0x41) return '';
  const first = crypto.createHash('sha256').update(bytes).digest();
  const checksum = crypto.createHash('sha256').update(first).digest().subarray(0, 4);
  const all = Buffer.concat([bytes, checksum]);
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt('0x' + all.toString('hex'));
  let out = '';
  while (n > 0n) { const rem = Number(n % 58n); out = alphabet[rem] + out; n /= 58n; }
  for (const b of all) { if (b !== 0) break; out = '1' + out; }
  return out;
}

async function getTrc20Transfers(address, options = {}) {
  const contract = process.env.TRON_USDT_CONTRACT;
  const limit = Math.min(200, Math.max(1, Number(options.limit || 50)));
  const params = new URLSearchParams({
    only_confirmed: 'true',
    limit: String(limit),
    order_by: 'block_timestamp,asc'
  });
  if (contract) params.set('contract_address', contract);
  if (options.fingerprint) params.set('fingerprint', String(options.fingerprint));
  if (options.minTimestamp != null) params.set('min_timestamp', String(options.minTimestamp));
  if (options.maxTimestamp != null) params.set('max_timestamp', String(options.maxTimestamp));
  return get(`/v1/accounts/${encodeURIComponent(address)}/transactions/trc20?${params}`);
}


async function getTrc20Balance(address) {
  const contract = process.env.TRON_USDT_CONTRACT;
  const decimals = Number(process.env.TRON_USDT_DECIMALS || 6);

  if (!contract || !validateAddress(contract)) {
    throw new Error('TRON_USDT_CONTRACT 未配置或格式不正确');
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error('TRON_USDT_DECIMALS 配置无效');
  }

  // 查询 TRC20 合约的 balanceOf(address)，不需要钱包私钥。
  const hexAddress = (() => {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let n = 0n;
    for (const ch of address) n = n * 58n + BigInt(alphabet.indexOf(ch));
    let hex = n.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    let bytes = Buffer.from(hex, 'hex');
    let zeros = 0;
    while (zeros < address.length && address[zeros] === '1') zeros++;
    if (zeros) bytes = Buffer.concat([Buffer.alloc(zeros), bytes]);
    if (bytes.length !== 25 || bytes[0] !== 0x41) throw new Error('监听地址无效');
    return bytes.subarray(1, 21).toString('hex');
  })();

  const contractHex = (() => {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let n = 0n;
    for (const ch of contract) n = n * 58n + BigInt(alphabet.indexOf(ch));
    let hex = n.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    let bytes = Buffer.from(hex, 'hex');
    let zeros = 0;
    while (zeros < contract.length && contract[zeros] === '1') zeros++;
    if (zeros) bytes = Buffer.concat([Buffer.alloc(zeros), bytes]);
    if (bytes.length !== 25 || bytes[0] !== 0x41) throw new Error('USDT 合约地址无效');
    return bytes.subarray(1, 21).toString('hex');
  })();

  const result = await post('/wallet/triggerconstantcontract', {
    owner_address: address,
    contract_address: contract,
    function_selector: 'balanceOf(address)',
    parameter: hexAddress.padStart(64, '0'),
    visible: true
  });

  if (result?.result?.result !== true) {
    throw new Error('TRC20 balanceOf 查询失败');
  }

  const raw = result.constant_result?.[0];
  if (!raw || !/^[0-9a-fA-F]+$/.test(raw)) {
    throw new Error('TRC20 返回的余额数据无效');
  }

  // 防止误将其他合约结果当作 USDT；请求本身以配置的合约地址为准。
  void contractHex;
  return rawToDecimal(BigInt('0x' + raw).toString(), decimals);
}

module.exports = { validateAddress, getAccount, getTrc20Balance, getTrc20Transfers, getTrxTransfers, extractTrxTransfers, rawToDecimal, decimalToRaw, getConfirmedTrc20Transfer, matchWithdrawalTransfer };