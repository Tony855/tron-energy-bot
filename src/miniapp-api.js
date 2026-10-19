'use strict';

const express = require('express');
const crypto = require('crypto');
const { query } = require('./db');
const { normalizeLang } = require('./i18n');
const { getAccount, getTrc20Balance, validateAddress } = require('./tron');

const router = express.Router();
const MAX_AGE_SECONDS = 3600;

function msg(lang, zh, en) { return lang === 'en' ? en : zh; }

function verifyInitData(initData) {
  // 先尽力从原始 initData 里推断语言，用于选择错误文案（此步未验证签名，仅用于本地展示）
  let lang = 'zh-CN';
  try {
    if (typeof initData === 'string' && initData) {
      const rawUser = new URLSearchParams(initData).get('user');
      if (rawUser) {
        const u = JSON.parse(rawUser);
        lang = normalizeLang(u && u.language_code) || 'zh-CN';
      }
    }
  } catch {}
  const err = (zh, en) => Object.assign(new Error(lang === 'en' ? en : zh), { status: 401 });

  if (!process.env.BOT_TOKEN) throw err('BOT_TOKEN 未配置', 'BOT_TOKEN not configured');
  if (typeof initData !== 'string' || !initData || initData.length > 8192) {
    throw err('请从 Telegram 内打开此页面', 'Please open this page inside Telegram');
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  const userRaw = params.get('user');

  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash) ||
      !Number.isSafeInteger(authDate) || !userRaw) {
    throw err('Telegram 身份数据不完整', 'Telegram initData is incomplete');
  }

  const now = Math.floor(Date.now() / 1000);
  if (authDate > now + 60 || now - authDate > MAX_AGE_SECONDS) {
    throw err('登录信息已过期，请重新打开 Mini App', 'Login expired; please reopen the Mini App');
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
    throw err('Telegram 身份验证失败', 'Telegram authentication failed');
  }

  let user;
  try { user = JSON.parse(userRaw); } catch {
    throw err('Telegram 用户信息格式无效', 'Invalid Telegram user info format');
  }

  if (!user || !Number.isSafeInteger(Number(user.id)) || Number(user.id) <= 0) {
    throw err('Telegram 用户信息无效', 'Invalid Telegram user info');
  }

  return { telegramId: String(user.id), user };
}

async function authenticate(req, res, next) {
  try {
    const raw = req.get('X-Telegram-Init-Data') || '';
    const verified = verifyInitData(raw);
    const rows = await query(
      'SELECT id,telegram_id,username,first_name,balance,is_blocked,language,tron_wallet_address FROM users WHERE telegram_id=? LIMIT 1',
      [verified.telegramId]
    );

    if (!rows.length) {
      const lang = req.lang || normalizeLang(verified.user && verified.user.language_code) || 'zh-CN';
      const msg = lang === 'en'
        ? 'Account not created yet. Please send /start in the bot first.'
        : '尚未创建账户，请先在机器人中发送 /start';
      return res.status(403).json({ error: msg });
    }
    if (Number(rows[0].is_blocked) === 1) {
      return res.status(403).json({ error: msg(normalizeLang(verified.user && verified.user.language_code) || 'zh-CN', '账户已停用，请联系管理员', 'Account disabled; contact admin') });
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
      firstName: u.first_name || req.telegramUser.first_name || (req.lang === 'en' ? 'User' : '用户'),
      username: u.username || req.telegramUser.username || '',
      balance: String(u.balance),
      currency: 'USDT'
    },
    capabilities: {
      walletMonitoring: true,
      energyProviderConfigured: false,
      automaticCredit: false
    },
    lang: req.lang,
    tron_wallet_address: u.tron_wallet_address || null
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
    return res.status(400).json({ error: msg(req.lang || 'zh-CN', '地址 ID 无效', 'Invalid address ID') });
  }

  const rows = await query(
    `SELECT id,address FROM wallets
      WHERE id=? AND user_id=? AND is_active=1 LIMIT 1`,
    [id, req.miniUser.id]
  );
  if (!rows.length) return res.status(404).json({ error: msg(req.lang || 'zh-CN', '地址不存在', 'Address not found') });

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
    res.status(502).json({ error: msg(req.lang || 'zh-CN', '链上查询暂时不可用，请稍后重试', 'Chain query temporarily unavailable; try again later') });
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

// ------------------ 绑定钱包功能 ------------------
router.post('/bind-wallet', async (req, res) => {
  try {
    const { walletAddress } = req.body;
    if (!walletAddress || !walletAddress.startsWith('T') || walletAddress.length !== 34) {
      return res.status(400).json({ error: msg(req.lang || 'zh-CN', '无效的 TRON 地址格式', 'Invalid TRON address format') });
    }

    await query('UPDATE users SET tron_wallet_address = ? WHERE id = ?', [walletAddress, req.miniUser.id]);
    return res.json({ success: true, message: msg(req.lang || 'zh-CN', '绑定成功', 'Bind successful') });
  } catch (err) {
    console.error('[API] bind-wallet error:', err);
    return res.status(500).json({ error: msg(req.lang || 'zh-CN', '服务器内部错误', 'Internal server error') });
  }
});

router.post('/unbind-wallet', async (req, res) => {
  try {
    await query('UPDATE users SET tron_wallet_address = NULL WHERE id = ?', [req.miniUser.id]);
    return res.json({ success: true });
  } catch (err) {
    console.error('[API] unbind-wallet error:', err);
    return res.status(500).json({ error: msg(req.lang || 'zh-CN', '服务器内部错误', 'Internal server error') });
  }
});

// ------------------ 购买能量功能 ------------------
router.post('/buy-energy', async (req, res) => {
  try {
    const { receiverAddress, energyAmount, durationMinutes } = req.body;
    const userId = req.miniUser.id;

    if (!receiverAddress || receiverAddress.length !== 34) {
      return res.status(400).json({ error: msg(req.lang, '接收地址无效', 'Invalid receiver address') });
    }
    const energy = Number(energyAmount);
    if (!Number.isInteger(energy) || energy <= 0) {
      return res.status(400).json({ error: msg(req.lang, '能量数量必须是正整数', 'Energy must be a positive integer') });
    }
    const price = (energy * 0.0001).toFixed(4);
    if (Number(req.miniUser.balance) < Number(price)) {
      return res.status(400).json({ error: msg(req.lang, '账户余额不足，请先充值', 'Insufficient balance') });
    }
    await query(
      `INSERT INTO energy_orders (user_id, receiver_address, energy_amount, duration_minutes, quoted_price, currency, status) 
       VALUES (?, ?, ?, ?, ?, 'USDT', 'pending')`,
      [userId, receiverAddress, energy, durationMinutes || 1, price]
    );
    return res.json({ success: true, message: msg(req.lang, '下单成功', 'Order placed') });
  } catch (err) {
    console.error('[API] buy-energy error:', err);
    return res.status(500).json({ error: msg(req.lang, '服务器错误', 'Server error') });
  }
});

module.exports = router;
