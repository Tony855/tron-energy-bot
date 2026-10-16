'use strict';

const express = require('express');
const crypto = require('crypto');
const { query } = require('./db');
const { normalizeLang } = require('./i18n');
const { getAccount, getTrc20Balance, validateAddress } = require('./tron');

const router = express.Router();
const MAX_AGE_SECONDS = 3600;

function verifyInitData(initData) {
  if (!process.env.BOT_TOKEN) throw new Error('BOT_TOKEN 未配置');
  if (typeof initData !== 'string' || !initData || initData.length > 8192) {
    throw new Error('请从 Telegram 内打开此页面');
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  const userRaw = params.get('user');

  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash) ||
      !Number.isSafeInteger(authDate) || !userRaw) {
    throw new Error('Telegram 身份数据不完整');
  }

  const now = Math.floor(Date.now() / 1000);
  if (authDate > now + 60 || now - authDate > MAX_AGE_SECONDS) {
    throw new Error('登录信息已过期，请重新打开 Mini App');
  }

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secret = crypto
    .createHmac('sha256', 'WebAppData')
    .update(process.env.BOT_TOKEN)
    .digest();

  const calculatedHash = crypto
    .createHmac('sha256', secret)
    .update(dataCheckString)
    .digest();

  const suppliedHash = Buffer.from(receivedHash, 'hex');

  if (suppliedHash.length !== calculatedHash.length ||
      !crypto.timingSafeEqual(suppliedHash, calculatedHash)) {
    throw new Error('Telegram 身份验证失败');
  }

  let user;
  try { user = JSON.parse(userRaw); } catch {
    throw new Error('Telegram 用户信息格式无效');
  }

  if (!user || !Number.isSafeInteger(Number(user.id)) || Number(user.id) <= 0) {
    throw new Error('Telegram 用户信息无效');
  }

  return { telegramId: String(user.id), user };
}

async function authenticate(req, res, next) {
  try {
    const raw = req.get('X-Telegram-Init-Data') || '';
    const verified = verifyInitData(raw);
    const rows = await query(
      'SELECT id,telegram_id,username,first_name,balance,is_blocked,language FROM users WHERE telegram_id=? LIMIT 1',
      [verified.telegramId]
    );

    if (!rows.length) {
      return res.status(403).json({
        error: '尚未创建账户，请先在机器人中发送 /start'
      });
    }
    if (Number(rows[0].is_blocked) === 1) {
      return res.status(403).json({ error: '账户已停用，请联系管理员' });
    }

    req.miniUser = rows[0];
    req.telegramUser = verified.user;
    // 从 DB → Telegram 顺序解析语言
    req.lang = normalizeLang(rows[0].language)
            || normalizeLang(verified.user.language_code)
            || 'zh-CN';
    next();
  } catch (e) {
    res.status(401).json({
      error: e.message || 'Telegram 身份验证失败'
    });
  }
}

router.use(authenticate);

router.get('/me', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const u = req.miniUser;
  res.json({
    user: {
      firstName: u.first_name || req.telegramUser.first_name || '用户',
      username: u.username || req.telegramUser.username || '',
      balance: String(u.balance),
      currency: 'USDT'
    },
    capabilities: {
      walletMonitoring: true,
      energyProviderConfigured: false,
      automaticCredit: false
    },
    lang: req.lang
  });
});

router.get('/wallets', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const rows = await query(
    `SELECT id,address,label,wallet_type,is_active,last_scanned_at,created_at
       FROM wallets
      WHERE user_id=? AND is_active=1
      ORDER BY id DESC LIMIT 100`,
    [req.miniUser.id]
  );
  res.json({ wallets: rows });
});

router.get('/wallets/:id/resources', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).json({ error: '地址 ID 无效' });
  }

  const rows = await query(
    `SELECT id,address FROM wallets
      WHERE id=? AND user_id=? AND is_active=1 LIMIT 1`,
    [id, req.miniUser.id]
  );
  if (!rows.length) return res.status(404).json({ error: '地址不存在' });

  try {
    const [account, usdt] = await Promise.all([
      getAccount(rows[0].address),
      getTrc20Balance(rows[0].address).catch(() => null)
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({
      address: account.address,
      trx: account.trx,
      usdt,
      energyLimit: account.energyLimit,
      energyUsed: account.energyUsed,
      netLimit: account.netLimit,
      netUsed: account.netUsed,
      freeNetLimit: account.freeNetLimit,
      freeNetUsed: account.freeNetUsed
    });
  } catch {
    res.status(502).json({ error: '链上查询暂时不可用，请稍后重试' });
  }
});

router.get('/transactions', async (req, res) => {
  const rows = await query(
    `SELECT t.tx_hash,t.event_index,t.token_contract,t.from_address,
            t.to_address,t.amount,t.block_timestamp,t.confirmed,
            w.address AS wallet_address
       FROM transactions t
       JOIN wallets w ON w.id=t.wallet_id
      WHERE w.user_id=?
      ORDER BY t.id DESC LIMIT 50`,
    [req.miniUser.id]
  );
  res.set('Cache-Control', 'no-store');
  res.json({ transactions: rows });
});

router.get('/energy-orders', async (req, res) => {
  const rows = await query(
    `SELECT id,receiver_address,energy_amount,duration_minutes,
            quoted_price,currency,status,tx_hash,created_at
       FROM energy_orders
      WHERE user_id=?
      ORDER BY id DESC LIMIT 30`,
    [req.miniUser.id]
  );
  res.set('Cache-Control', 'no-store');
  res.json({ orders: rows });
});

module.exports = router;
