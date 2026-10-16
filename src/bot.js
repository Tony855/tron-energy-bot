'use strict';

const { Bot, InlineKeyboard } = require('grammy');
const crypto = require('crypto');
const { query, pool } = require('./db');
const {
  validateAddress, getAccount, getTrc20Balance, getConfirmedTrc20Transfer
} = require('./tron');
const { t, langOf, resolveLang, SUPPORTED, DEFAULT_LANG } = require('./i18n');
const { assignNextDepositAddress } = require('./depositPool');
const { sendTelegramMessage } = require('./notifier');
const { creditRecharge } = require('./ledger');
const { verifyDepositTransfer } = require('./chainDepositVerify');
const {
  validateWithdrawalAmount, validatePendingCount, validateDailyTotal
} = require('./withdrawalPolicy');

function code() { return crypto.randomBytes(5).toString('hex').toUpperCase(); }
function esc(s) {
  return String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function resourceValue(v) {
  if (v === null || v === undefined || v === '') return '0';
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? String(n) : '暂无数据';
}
function shortAddr(a, head = 8, tail = 5) {
  const s = String(a || '');
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}
function fmtUtc(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '时间未知';
  const d = new Date(n);
  return Number.isNaN(d.getTime())
    ? '时间未知'
    : d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

// ---------- 唯一键盘定义（每层一个） ----------
const backHome   = (lang = 'zh-CN') => new InlineKeyboard().text(t(lang, 'menu.home'), 'home');
const cancelMenu = (lang = 'zh-CN') => new InlineKeyboard().text(t(lang, 'menu.cancel'), 'cancel').text(t(lang, 'menu.home_short'), 'home');

const homeMenu = (lang = 'zh-CN') => new InlineKeyboard()
  .text(t(lang, 'menu.wallets'), 'wallets').text(t(lang, 'menu.balance'), 'balance').row()
  .text(t(lang, 'menu.deposit'), 'deposit').text(t(lang, 'menu.withdraw'), 'withdraw').row()
  .text(t(lang, 'menu.transactions'), 'transactions').text(t(lang, 'menu.status'), 'status').row()
  .text(t(lang, 'menu.report'), 'report').text(t(lang, 'menu.energy'), 'energy').row()
  .text(t(lang, 'menu.referral'), 'referral').text(t(lang, 'menu.help'), 'help').row()
  .webApp(t(lang, 'menu.miniapp'), 'https://tron.v2net.cc/miniapp/');

const walletMenu = (lang = 'zh-CN') => new InlineKeyboard()
  .text(t(lang, 'wallet.add'), 'wallet:add').row()
  .text(t(lang, 'wallet.balance'), 'wallet:resources').text(t(lang, 'wallet.history'), 'wallet:history').row()
  .text(t(lang, 'wallet.disable'), 'wallet:remove').text(t(lang, 'wallet.disabled'), 'wallet:disabled').row()
  .text(t(lang, 'menu.home'), 'home');

// ---------- 统一渲染：优先编辑当前消息，避免刷屏 ----------
async function render(ctx, text, keyboard) {
  // keyboard 可以是 InlineKeyboard 实例，或 (lang) => InlineKeyboard 函数
  let kb = keyboard;
  if (typeof keyboard === 'function') {
    const lang = await langOf(ctx, query);
    kb = keyboard(lang);
  }
  const opts = { parse_mode: 'HTML', reply_markup: kb, disable_web_page_preview: true };
  if (ctx.callbackQuery?.message) {
    try { await ctx.editMessageText(text, opts); return; }
    catch (e) {
      const d = String(e.description || e.message || '');
      if (d.includes('message is not modified')) return;
      // 无法编辑（消息过旧、含媒体等）时退回发送新消息
    }
  }
  await ctx.reply(text, opts);
}

async function getOrCreateUser(ctx) {
  const tg = ctx.from;
  let rows = await query('SELECT * FROM users WHERE telegram_id=?', [tg.id]);
  if (rows.length) {
    await query('UPDATE users SET username=?,first_name=? WHERE id=?', [tg.username || null, tg.first_name || null, rows[0].id]);
    return rows[0];
  }
  const start = String(ctx.match || '').trim();
  const referral = start ? await query('SELECT id FROM users WHERE referral_code=?', [start]) : [];
  const referrerId = referral[0]?.id || null;
  await query(
    'INSERT INTO users (telegram_id,username,first_name,referral_code,referred_by) VALUES (?,?,?,?,?)',
    [tg.id, tg.username || null, tg.first_name || null, code(), referrerId]
  );
  rows = await query('SELECT * FROM users WHERE telegram_id=?', [tg.id]);
  return rows[0];
}

function createBot() {
  if (!process.env.BOT_TOKEN) {
    console.warn('[bot] BOT_TOKEN not configured; Telegram bot disabled');
    return null;
  }

  const bot = new Bot(process.env.BOT_TOKEN);
  const pendingInput = new Map();

  const userIdFor = async telegramId => {
    const rows = await query('SELECT id FROM users WHERE telegram_id=?', [telegramId]);
    return rows[0]?.id || null;
  };

  const adminIds = new Set(
    String(process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(x => x.trim()).filter(Boolean)
  );
  const requireAdmin = async ctx => {
    if (!adminIds.has(String(ctx.from.id))) {
      await ctx.reply('无权执行此管理员操作。');
      return false;
    }
    return true;
  };

  const listWallets = (uid, opts = {}) => query(
    `SELECT id,address,label,wallet_type,last_scanned_at
       FROM wallets
      WHERE user_id=? AND is_active=1 ${opts.monitorOnly ? "AND wallet_type='monitor'" : ''}
      ORDER BY id DESC LIMIT 20`,
    [uid]
  );

  const showHome = async ctx => {
    const u = await getOrCreateUser(ctx);
    const lang = await langOf(ctx, query);
    const name = esc(u.first_name || t(lang, 'home.guest'));
    await render(
      ctx,
      `${t(lang, 'home.greeting', { name })}

${t(lang, 'home.balance', { balance: u.balance })}

${t(lang, 'home.prompt')}

${t(lang, 'home.security')}`,
      homeMenu
    );
  };

  const showWalletHome = async (ctx, uid) => {
    const ws = await listWallets(uid);
    const body = ws.length
      ? ws.map(w => {
          const tag = w.wallet_type === 'deposit' ? '📥 充值地址' : '👁 监听地址';
          const label = w.label ? ` · ${esc(w.label)}` : '';
          return `${tag}${label}\n<code>${w.address}</code>\n最近事件：${w.last_scanned_at || '等待事件源推送'}`;
        }).join('\n\n')
      : '暂无启用的地址，请先添加监听地址。';
    await render(
      ctx,
      `🎧 <b>监听管理</b>\n\n${body}\n\n` +
      `监控为只读功能，不会要求私钥。`,
      walletMenu
    );
  };

  const pickMonitorWallet = async (ctx, title, actionPrefix) => {
    const lang = await langOf(ctx, query);
    const uid = await userIdFor(ctx.from.id);
    if (!uid) return ctx.reply('请先发送 /start');
    const ws = await listWallets(uid, { monitorOnly: true });
    if (!ws.length) {
      return render(ctx, '你还没有启用的监听地址，请先添加。', walletMenu);
    }
    const kb = new InlineKeyboard();
    for (const w of ws) kb.text(`👁 ${shortAddr(w.address)}`, `${actionPrefix}:${w.id}`).row();
    kb.text(t(lang, 'wallet.back_home'), 'wallets').row().text(t(lang, 'menu.home_short'), 'home');
    return render(ctx, title, kb);
  };

  const ensureDepositAddress = async uid => {
    const rows = await query(
      "SELECT address FROM wallets WHERE user_id=? AND wallet_type='deposit' AND is_active=1 LIMIT 1",
      [uid]
    );
    if (rows.length) return { address: rows[0].address };
    try {
      const assigned = await assignNextDepositAddress(uid);
      if (assigned.reason === 'pool_empty') return { reason: 'pool_empty' };
      return { address: assigned.address };
    } catch (e) {
      console.error('[deposit] assignment failed:', e.message);
      return { reason: 'error' };
    }
  };

  const showDeposit = async ctx => {
    const lang = await langOf(ctx, query);
    const uid = await userIdFor(ctx.from.id);
    if (!uid) return ctx.reply('请先发送 /start');
    const r = await ensureDepositAddress(uid);
    if (r.reason === 'pool_empty') {
      return render(ctx, t(lang, 'content.deposit.pool_empty'), backHome);
    }
    if (r.reason === 'error') {
      return render(ctx, t(lang, 'content.deposit.assign_fail'), backHome);
    }
    await render(
      ctx,
      `${t(lang, 'content.deposit.title')}\n\n<code>${r.address}</code>\n\n` +
      `${t(lang, 'content.deposit.net')}\n\n` +
      `${t(lang, 'content.deposit.warn')}`,
      new InlineKeyboard()
        .text(t(lang, 'menu.transactions'), 'transactions')
        .text(t(lang, 'deposit.withdraw'), 'withdraw').row()
        .text(t(lang, 'menu.home'), 'home')
    );
  };

  const showWithdrawPrompt = async ctx => {
    pendingInput.set(ctx.from.id, 'withdraw');
    await render(
      ctx,
      '📤 <b>提现申请</b>\n\n' +
      '请按以下格式发送：金额 空格 收款TRON地址\n' +
      '例如：<code>10 Txxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx</code>\n\n' +
      '提交后进入管理员审核，不会立即链上转账。',
      cancelMenu
    );
  };

  const showTransactions = async ctx => {
    const uid = await userIdFor(ctx.from.id);
    if (!uid) return ctx.reply('请先发送 /start');
    const rows = await query(
      `SELECT t.tx_hash,t.event_index,t.token_contract,t.from_address,t.to_address,
              t.amount,t.block_timestamp,w.address
         FROM transactions t
         JOIN wallets w ON w.id=t.wallet_id
        WHERE w.user_id=?
        ORDER BY t.id DESC LIMIT 10`,
      [uid]
    );
    const body = rows.length
      ? rows.map((t, i) => {
          const token = t.token_contract === 'TRX_NATIVE' ? 'TRX' : 'USDT-TRC20';
          return `${i + 1}. ${token} <b>${t.amount}</b>\n` +
                 `${shortAddr(t.from_address, 6, 6)} → ${shortAddr(t.to_address, 6, 6)}\n` +
                 `<code>${t.tx_hash}</code>`;
        }).join('\n\n')
      : '暂无已识别交易。事件源未配置或未推送时，这里不会自动出现新交易。';
    await render(
      ctx,
      `🧾 <b>最近交易（最多 10 笔）</b>\n\n${body}`,
      new InlineKeyboard()
        .text(t(lang, 'tx.refresh'), 'transactions').row()
        .text(t(lang, 'menu.home'), 'home')
    );
  };

  const showStatus = async ctx => {
    const lang = await langOf(ctx, query);
    const uid = await userIdFor(ctx.from.id);
    if (!uid) return ctx.reply('请先发送 /start');
    const [w] = await query(
      'SELECT COUNT(*) count, MAX(last_scanned_at) last_scan FROM wallets WHERE user_id=? AND is_active=1',
      [uid]
    );
    const [tx] = await query(
      `SELECT COUNT(*) count FROM transactions
        WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id=?)
          AND created_at >= NOW() - INTERVAL 24 HOUR`,
      [uid]
    );
    await render(
      ctx,
      `${t(lang, 'content.status.title')}\n\n` +
      `${t(lang, 'content.status.addr', { count: w.count })}\n` +
      `${t(lang, 'content.status.last', { last: w.last_scan || '—' })}\n` +
      `${t(lang, 'content.status.24h', { count: tx.count })}\n\n` +
      `${t(lang, 'content.status.note')}`,
      backHome
    );
  };

  const showReport = async ctx => {
    const lang = await langOf(ctx, query);
    const uid = await userIdFor(ctx.from.id);
    if (!uid) return ctx.reply('请先发送 /start');
    const [w] = await query('SELECT COUNT(*) c FROM wallets WHERE user_id=? AND is_active=1', [uid]);
    const [tx2] = await query(
      `SELECT COUNT(*) c,
              COALESCE(SUM(CASE WHEN token_contract='TRX_NATIVE' THEN amount ELSE 0 END),0) trx_total,
              COALESCE(SUM(CASE WHEN token_contract<>'TRX_NATIVE' THEN amount ELSE 0 END),0) usdt_total
         FROM transactions
        WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id=?)
          AND block_timestamp >= UNIX_TIMESTAMP(UTC_DATE())*1000
          AND block_timestamp <  UNIX_TIMESTAMP(UTC_DATE() + INTERVAL 1 DAY)*1000`,
      [uid]
    );
    await render(
      ctx,
      `${t(lang, 'content.report.title')}\n\n` +
      `${t(lang, 'content.report.addr', { count: w.c })}\n` +
      `${t(lang, 'content.report.events', { count: tx2.c })}\n` +
      `${t(lang, 'content.report.trx', { amount: tx2.trx_total })}\n` +
      `${t(lang, 'content.report.usdt', { amount: tx2.usdt_total })}\n\n` +
      `${t(lang, 'content.report.note')}`,
      backHome
    );
  };

  const showReferral = async ctx => {
    const lang = await langOf(ctx, query);
    const rows = await query('SELECT id,referral_code FROM users WHERE telegram_id=?', [ctx.from.id]);
    if (!rows.length) return ctx.reply('请先发送 /start');
    const botName = (await bot.api.getMe()).username;
    const [stats] = await query('SELECT COUNT(*) c FROM users WHERE referred_by=?', [rows[0].id]);
    await render(
      ctx,
      `${t(lang, 'content.referral.title')}\n\n` +
      `${t(lang, 'content.referral.count', { count: stats.c })}\n` +
      `${t(lang, 'content.referral.percent', { percent: process.env.REFERRAL_COMMISSION_PERCENT || 3 })}\n\n` +
      `${t(lang, 'content.referral.link')}\n` +
      `<code>https://t.me/${botName}?start=${rows[0].referral_code}</code>`,
      backHome
    );
  };

  const showEnergy = async ctx => {
    await render(
      ctx,
      t(lang, 'content.energy.title') + '\n\n' +
      t(lang, 'content.energy.body1') + '\n' +
      t(lang, 'content.energy.body2'),
      backHome
    );
  };

  const showHelp = async ctx => {
    const lang = await langOf(ctx, query);
    await render(
      ctx,
      t(lang, 'content.help.title') + '\n\n' +
      t(lang, 'content.help.l1') + '\n' +
      t(lang, 'content.help.l2') + '\n' +
      t(lang, 'content.help.l3') + '\n' +
      t(lang, 'content.help.l4') + '\n' +
      t(lang, 'content.help.l5') + '\n\n' +
      t(lang, 'content.help.security'),
      backHome
    );
  };

  bot.command('language', async ctx => {
    const lang = await langOf(ctx, query);
    const kb = new InlineKeyboard()
      .text('🇨🇳 中文', 'lang:zh-CN')
      .text('🇬🇧 English', 'lang:en').row()
      .text(t(lang, 'lang.cancel'), 'home');
    await render(ctx, t(lang, 'lang.title'), kb);
  });

  bot.callbackQuery(/^lang:(zh-CN|en)$/, async ctx => {
    const target = ctx.match[1];
    if (!SUPPORTED.includes(target)) {
      await ctx.answerCallbackQuery({ text: 'Unsupported language' });
      return;
    }
    await ctx.answerCallbackQuery();
    const uid = await userIdFor(ctx.from.id);
    if (uid) {
      try { await query('UPDATE users SET language=? WHERE id=?', [target, uid]); }
      catch (e) { console.error('[lang] update failed:', e.message); }
    }
    await render(ctx, t(target, 'lang.changed'), backHome);
  });

  bot.command('start', showHome);
  bot.command('help', ctx => ctx.reply(
    '命令：/start /balance /wallets /addwallet /removewallet /resources /deposit /withdraw /transactions /status /referral /report\n' +
    '管理员：/pendingrecharges /verifyrecharge ID /approverecharge ID /rejectrecharge ID 原因\n' +
    '请勿向机器人发送助记词或私钥。'
  ));

  bot.command('balance', async ctx => {
    const rows = await query('SELECT balance FROM users WHERE telegram_id=?', [ctx.from.id]);
    if (!rows.length) return ctx.reply('请先发送 /start');
    await ctx.reply(`当前可用余额：${rows[0].balance} USDT`);
  });

  bot.command('status', async ctx => {
    const uid = await userIdFor(ctx.from.id);
    if (!uid) return ctx.reply('请先发送 /start');
    const [rows] = await query(
      `SELECT COUNT(*) count, MAX(last_scanned_at) last_scan
         FROM wallets WHERE user_id=? AND is_active=1`,
      [uid]
    );
    const [tx] = await query(
      `SELECT COUNT(*) count FROM transactions
        WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id=?)
          AND created_at >= NOW() - INTERVAL 24 HOUR`,
      [uid]
    );
    await ctx.reply(
      `监听状态\n启用地址：${rows.count}\n最近扫描：${rows.last_scan || '尚未完成首次扫描'}\n` +
      `近 24 小时新入库交易：${tx.count}\n` +
      `支持：TRX 原生转账、配置的 USDT-TRC20 合约\n` +
      `说明：事件驱动模式；未配置第三方推送源时不会自动发现新交易。`
    );
  });

  bot.command('transactions', showTransactions);
  bot.command('deposit', showDeposit);
  bot.command('report', showReport);
  bot.command('referral', showReferral);

  bot.command('wallets', async ctx => {
    const uid = await userIdFor(ctx.from.id);
    if (!uid) return ctx.reply('请先发送 /start');
    await showWalletHome(ctx, uid);
  });

  bot.command('removewallet', async ctx => {
    const address = String(ctx.match || '').trim();
    if (!validateAddress(address)) return ctx.reply('用法：/removewallet T开头的TRON地址');
    const uid = await userIdFor(ctx.from.id);
    if (!uid) return ctx.reply('请先发送 /start');
    const [result] = await pool.execute(
      "UPDATE wallets SET is_active=0 WHERE user_id=? AND address=? AND wallet_type='monitor' AND is_active=1",
      [uid, address]
    );
    await ctx.reply(result.affectedRows
      ? '监听地址已停用；历史交易记录保留。'
      : '没有找到属于你的启用中监听地址。');
  });

  bot.command('addwallet', async ctx => {
    const address = String(ctx.match || '').trim();
    if (!address) {
      pendingInput.set(ctx.from.id, 'addwallet');
      return render(
        ctx,
        '➕ <b>添加只读监听地址</b>\n\n请直接发送 TRON 主网公开地址（T 开头），不要发送私钥。\n发送 /cancel 或点击按钮可取消。',
        cancelMenu
      );
    }
    if (!validateAddress(address)) {
      pendingInput.set(ctx.from.id, 'addwallet');
      return render(ctx, '地址格式不正确，请重新发送 T 开头的有效 TRON 主网地址。', cancelMenu);
    }
    const uid = await userIdFor(ctx.from.id);
    if (!uid) return ctx.reply('请先发送 /start');
    try {
      await query(
        "INSERT INTO wallets (user_id,address,wallet_type,label) VALUES (?,?, 'monitor','用户监控')",
        [uid, address]
      );
      pendingInput.delete(ctx.from.id);
      return render(
        ctx,
        '✅ 地址已添加到你的独立只读监控列表。\n\n地址、交易与通知仅关联你的账户。',
        walletMenu
      );
    } catch (e) {
      pendingInput.delete(ctx.from.id);
      if (e.code === 'ER_DUP_ENTRY') return render(ctx, '该地址已存在，请勿重复添加。', walletMenu);
      console.error('[addwallet]', e.message);
      return render(ctx, '添加失败，请稍后重试。', walletMenu);
    }
  });

  bot.command('resources', async ctx => {
    const address = String(ctx.match || '').trim();
    if (!validateAddress(address)) return ctx.reply('用法：/resources T开头的TRON地址');
    try {
      const r = await getAccount(address);
      await ctx.reply(
        `TRON 账户资源\n地址：${r.address}\nTRX 余额：${r.trx}\n` +
        `Energy：${resourceValue(r.energyUsed)}/${resourceValue(r.energyLimit)}\n` +
        `Bandwidth：${resourceValue(r.netUsed)}/${resourceValue(r.netLimit)}\n` +
        `免费 Bandwidth：${resourceValue(r.freeNetUsed)}/${resourceValue(r.freeNetLimit)}`
      );
    } catch (e) {
      await ctx.reply(`查询失败：${e.message}\n请检查 TRON API 地址、API Key 或网络连接。`);
    }
  });

  bot.command('withdraw', async ctx => {
    const [amount, destination] = String(ctx.match || '').trim().split(/\s+/);
    if (!amount || !destination) return ctx.reply('用法：/withdraw 金额 T开头的TRON地址\n例如：/withdraw 10 T...');
    if (!validateAddress(destination)) return ctx.reply('TRON 地址无效，请检查地址及校验和。');
    try { validateWithdrawalAmount(amount); } catch (e) { return ctx.reply(e.message); }

    const conn = await pool.getConnection();
    let insertId;
    try {
      await conn.beginTransaction();
      const [users] = await conn.execute('SELECT id,balance FROM users WHERE telegram_id=? FOR UPDATE', [ctx.from.id]);
      if (!users.length) { await conn.rollback(); return ctx.reply('请先发送 /start'); }
      const uid = users[0].id;
      const [pending] = await conn.execute(
        "SELECT COUNT(*) count FROM withdrawal_requests WHERE user_id=? AND status IN ('pending','approved')",
        [uid]
      );
      validatePendingCount(pending[0].count);
      const [daily] = await conn.execute(
        `SELECT CAST(COALESCE(SUM(amount),0) AS CHAR) total FROM withdrawal_requests
          WHERE user_id=? AND created_at >= UTC_DATE()
            AND created_at < DATE_ADD(UTC_DATE(), INTERVAL 1 DAY)
            AND status IN ('pending','approved','paid')`,
        [uid]
      );
      validateDailyTotal(daily[0].total || '0', amount);
      const [ins] = await conn.execute(
        "INSERT INTO withdrawal_requests (user_id,amount,currency,destination_address,status) VALUES (?,?, 'USDT',?,'pending')",
        [uid, amount, destination]
      );
      insertId = ins.insertId;
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      return ctx.reply(e.message || '提现申请失败，请稍后重试。');
    } finally { conn.release(); }

    await ctx.reply(
      `提现申请已提交，编号 #${insertId}\n金额：${amount} USDT\n收款地址：${destination}\n` +
      `状态：待管理员审核\n\n批准后将从可用余额扣款，链上转账由管理员人工执行。`
    );
  });

  bot.callbackQuery('home',   async ctx => { await ctx.answerCallbackQuery(); await showHome(ctx); });
  bot.callbackQuery('cancel', async ctx => {
    pendingInput.delete(ctx.from.id);
    await ctx.answerCallbackQuery({ text: '已取消' });
    await showHome(ctx);
  });

  bot.callbackQuery('help',         async ctx => { await ctx.answerCallbackQuery(); await showHelp(ctx); });
  bot.callbackQuery('balance',      async ctx => {
    const lang = await langOf(ctx, query);
    await ctx.answerCallbackQuery();
    const rows = await query('SELECT balance FROM users WHERE telegram_id=?', [ctx.from.id]);
    if (!rows.length) return render(ctx, '请先发送 /start', backHome);
    await render(
      ctx,
      `💰 <b>我的余额</b>\n\n可用余额：<b>${rows[0].balance} USDT</b>\n\n提现需提交申请并通过管理员审核。`,
      new InlineKeyboard()
        .text(t(lang, 'deposit.withdraw'), 'withdraw')
        .text(t(lang, 'balance.deposit'), 'deposit').row()
        .text(t(lang, 'menu.home'), 'home')
    );
  });
  bot.callbackQuery(['wallets', 'wallet:list'],      async ctx => {
    await ctx.answerCallbackQuery();
    const uid = await userIdFor(ctx.from.id);
    if (!uid) return render(ctx, '请先发送 /start', backHome);
    await showWalletHome(ctx, uid);
  });
  bot.callbackQuery('deposit',      async ctx => { await ctx.answerCallbackQuery(); await showDeposit(ctx); });
  bot.callbackQuery('withdraw',     async ctx => { await ctx.answerCallbackQuery(); await showWithdrawPrompt(ctx); });
  bot.callbackQuery('transactions', async ctx => { await ctx.answerCallbackQuery(); await showTransactions(ctx); });
  bot.callbackQuery('status',       async ctx => { await ctx.answerCallbackQuery(); await showStatus(ctx); });
  bot.callbackQuery('report',       async ctx => { await ctx.answerCallbackQuery(); await showReport(ctx); });
  bot.callbackQuery('referral',     async ctx => { await ctx.answerCallbackQuery(); await showReferral(ctx); });
  bot.callbackQuery('energy',       async ctx => { await ctx.answerCallbackQuery(); await showEnergy(ctx); });

  bot.callbackQuery('wallet:add', async ctx => {
    pendingInput.set(ctx.from.id, 'addwallet');
    await ctx.answerCallbackQuery();
    await render(
      ctx,
      '➕ <b>添加监听地址</b>\n\n请发送 TRON 主网公开地址（T 开头）。\n本功能只读监控，不会要求私钥。',
      cancelMenu
    );
  });


  bot.callbackQuery('wallet:resources', async ctx => {
    await ctx.answerCallbackQuery();
    await pickMonitorWallet(
      ctx,
      '🔎 <b>查询余额</b>\n\n请选择要查询的监听地址：',
      'wallet:resource'
    );
  });

  bot.callbackQuery('wallet:history', async ctx => {
    await ctx.answerCallbackQuery();
    await pickMonitorWallet(
      ctx,
      '📜 <b>历史记录</b>\n\n请选择要查询的监听地址：',
      'wallet:history:choose'
    );
  });

  bot.callbackQuery('wallet:remove', async ctx => {
    const lang = await langOf(ctx, query);
    await ctx.answerCallbackQuery();
    const uid = await userIdFor(ctx.from.id);
    if (!uid) return render(ctx, '请先发送 /start', backHome);
    const ws = await query(
      "SELECT id,address FROM wallets WHERE user_id=? AND wallet_type='monitor' AND is_active=1 ORDER BY id DESC LIMIT 10",
      [uid]
    );
    if (!ws.length) return render(ctx, '没有可停用的监听地址。', walletMenu);
    const kb = new InlineKeyboard();
    for (const w of ws) kb.text(`🗑 ${shortAddr(w.address)}`, `wallet:rm:${w.id}`).row();
    kb.text(t(lang, 'wallet.back_home'), 'wallets').row().text(t(lang, 'menu.home_short'), 'home');
    await render(ctx, '选择要停用的地址。停用后不再接收新通知，历史记录保留。', kb);
  });

  bot.callbackQuery(/^wallet:rm:(\d+)$/, async ctx => {
    const lang = await langOf(ctx, query);
    await ctx.answerCallbackQuery();
    const uid = await userIdFor(ctx.from.id);
    if (!uid) return render(ctx, '请先发送 /start', backHome);
    const rows = await query(
      "SELECT id,address FROM wallets WHERE id=? AND user_id=? AND wallet_type='monitor' AND is_active=1 LIMIT 1",
      [Number(ctx.match[1]), uid]
    );
    if (!rows.length) return render(ctx, '地址不存在、已停用或不属于你的账户。', walletMenu);
    await render(
      ctx,
      `请确认是否停用这个监听地址：\n<code>${rows[0].address}</code>\n\n停用后不再接收新通知，历史交易保留。`,
      new InlineKeyboard()
        .text(t(lang, 'wallet.rm_confirm'), `wallet:rm:yes:${rows[0].id}`).row()
        .text(t(lang, 'wallet.cancel'), 'wallets').row()
        .text(t(lang, 'menu.home_short'), 'home')
    );
  });

  bot.callbackQuery(/^wallet:rm:yes:(\d+)$/, async ctx => {
    await ctx.answerCallbackQuery();
    const uid = await userIdFor(ctx.from.id);
    if (!uid) return render(ctx, '请先发送 /start', backHome);
    const [r] = await pool.execute(
      "UPDATE wallets SET is_active=0 WHERE id=? AND user_id=? AND wallet_type='monitor' AND is_active=1",
      [Number(ctx.match[1]), uid]
    );
    await render(
      ctx,
      r.affectedRows ? '✅ 地址已停用，历史交易仍保留。' : '地址不存在、已停用或不属于你的账户。',
      walletMenu
    );
  });

  bot.callbackQuery('wallet:disabled', async ctx => {
    const lang = await langOf(ctx, query);
    await ctx.answerCallbackQuery();
    const uid = await userIdFor(ctx.from.id);
    if (!uid) return render(ctx, '请先发送 /start', backHome);
    const ws = await query(
      "SELECT id,address FROM wallets WHERE user_id=? AND wallet_type='monitor' AND is_active=0 ORDER BY id DESC LIMIT 20",
      [uid]
    );
    if (!ws.length) return render(ctx, '目前没有已停用的监听地址。', walletMenu);
    const kb = new InlineKeyboard();
    for (const w of ws) {
      kb.text(`${t(lang, 'wallet.restore')} ${shortAddr(w.address)}`, `wallet:restore:${w.id}`).row();
      kb.text(`${t(lang, 'wallet.delete')} ${shortAddr(w.address, 6, 4)}`, `wallet:delete:${w.id}`).row();
    }
    kb.text(t(lang, 'wallet.back_home'), 'wallets').row().text(t(lang, 'menu.home_short'), 'home');
    await render(ctx, '♻️ <b>已停用的监听地址</b>\n\n请选择恢复或申请永久删除。', kb);
  });

  bot.callbackQuery(/^wallet:restore:(\d+)$/, async ctx => {
    await ctx.answerCallbackQuery();
    const uid = await userIdFor(ctx.from.id);
    if (!uid) return render(ctx, '请先发送 /start', backHome);
    const [r] = await pool.execute(
      "UPDATE wallets SET is_active=1 WHERE id=? AND user_id=? AND wallet_type='monitor' AND is_active=0",
      [Number(ctx.match[1]), uid]
    );
    await render(
      ctx,
      r.affectedRows ? '✅ 监听地址已恢复启用。' : '地址不存在、已启用或不属于你的账户。',
      walletMenu
    );
  });

  bot.callbackQuery(/^wallet:delete:(\d+)$/, async ctx => {
    const lang = await langOf(ctx, query);
    await ctx.answerCallbackQuery();
    const uid = await userIdFor(ctx.from.id);
    if (!uid) return render(ctx, '请先发送 /start', backHome);
    const rows = await query(
      "SELECT id,address FROM wallets WHERE id=? AND user_id=? AND wallet_type='monitor' AND is_active=0",
      [Number(ctx.match[1]), uid]
    );
    if (!rows.length) return render(ctx, '只能删除属于你自己的已停用监听地址。', walletMenu);
    await render(
      ctx,
      `⚠️ <b>永久删除确认</b>\n\n地址：\n<code>${rows[0].address}</code>\n\n` +
      `只有没有交易、充值、补扫或告警记录的地址才允许删除。此操作不可撤销。`,
      new InlineKeyboard()
        .text(t(lang, 'wallet.del_confirm'), `wallet:delete:confirm:${rows[0].id}`).row()
        .text(t(lang, 'wallet.cancel'), 'wallet:disabled').row()
        .text(t(lang, 'menu.home_short'), 'home')
    );
  });

  bot.callbackQuery(/^wallet:delete:confirm:(\d+)$/, async ctx => {
    await ctx.answerCallbackQuery();
    const uid = await userIdFor(ctx.from.id);
    if (!uid) return render(ctx, '请先发送 /start', backHome);
    const id = Number(ctx.match[1]);
    let conn;
    try {
      conn = await pool.getConnection();
      await conn.beginTransaction();
      const [wallets] = await conn.execute(
        "SELECT id,address,is_active FROM wallets WHERE id=? AND user_id=? AND wallet_type='monitor' FOR UPDATE",
        [id, uid]
      );
      if (!wallets.length || Number(wallets[0].is_active) !== 0) {
        await conn.rollback();
        return render(ctx, '地址不存在、未停用或不属于你的账户，已取消删除。', walletMenu);
      }
      const [tableRows] = await conn.execute(
        "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()"
      );
      const existing = new Set(tableRows.map(r => r.TABLE_NAME));
      const checks = [
        ['transactions',        'SELECT COUNT(*) AS n FROM transactions WHERE wallet_id=?'],
        ['recharge_orders',     'SELECT COUNT(*) AS n FROM recharge_orders WHERE wallet_id=?'],
        ['deposit_address_pool','SELECT COUNT(*) AS n FROM deposit_address_pool WHERE assigned_wallet_id=?'],
        ['chain_backfill_state','SELECT COUNT(*) AS n FROM chain_backfill_state WHERE wallet_id=?'],
        ['chain_alert_events',  'SELECT COUNT(*) AS n FROM chain_alert_events WHERE wallet_id=?']
      ];
      for (const [name, sql] of checks) {
        if (!existing.has(name)) continue;
        const [rows] = await conn.execute(sql, [id]);
        if (Number(rows[0].n) > 0) {
          await conn.rollback();
          return render(
            ctx,
            `⛔ 为保护历史数据，不能永久删除此地址：存在 ${name} 关联记录。你仍可以保留或重新启用该地址。`,
            walletMenu
          );
        }
      }
      const [r] = await conn.execute(
        "DELETE FROM wallets WHERE id=? AND user_id=? AND wallet_type='monitor' AND is_active=0",
        [id, uid]
      );
      if (r.affectedRows !== 1) {
        await conn.rollback();
        return render(ctx, '地址状态已变化，未执行删除。', walletMenu);
      }
      await conn.commit();
      await render(ctx, '✅ 地址已永久删除。未删除任何交易记录。', walletMenu);
    } catch (e) {
      if (conn) { try { await conn.rollback(); } catch (_) {} }
      console.error('[wallet:delete]', e.message);
      await render(
        ctx,
        '删除操作未完成。为保护数据，检查失败时系统会拒绝删除，请保留该地址并检查日志。',
        walletMenu
      );
    } finally {
      if (conn) conn.release();
    }
  });

  bot.callbackQuery(/^wallet:resource:(\d+)$/, async ctx => {
    const lang = await langOf(ctx, query);
    await ctx.answerCallbackQuery();
    const uid = await userIdFor(ctx.from.id);
    if (!uid) return render(ctx, '请先发送 /start', backHome);
    const rows = await query(
      "SELECT id,address FROM wallets WHERE id=? AND user_id=? AND wallet_type='monitor' AND is_active=1 LIMIT 1",
      [Number(ctx.match[1]), uid]
    );
    if (!rows.length) return render(ctx, '地址不存在、已停用或不属于你的账户。', walletMenu);
    const w = rows[0];
    try {
      const [r, usdtBalance] = await Promise.all([
        getAccount(w.address),
        getTrc20Balance(w.address).catch(() => null)
      ]);
      const pct = (u, l) => {
        const lu = Number(l) || 0, uu = Number(u) || 0;
        if (lu <= 0 || uu < 0) return 0;
        return Math.min(100, Math.round(uu * 100 / lu));
      };
      const bar = n => n === null ? '资源数据暂不可用'
        : '▰'.repeat(Math.round(n / 10)) + '▱'.repeat(10 - Math.round(n / 10));
      const ep = pct(r.energyUsed, r.energyLimit);
      const np = pct(
        (Number(r.netUsed) || 0) + (Number(r.freeNetUsed) || 0),
        (Number(r.netLimit) || 0) + (Number(r.freeNetLimit) || 0)
      );
      const fmt = n => `${Number(n) || 0}%`;

      await render(
        ctx,
        `🔍 <b>监听地址余额</b>\n\n` +
        `📍 <b>地址</b>\n<code>${w.address}</code>\n\n` +
        `━━━━━━━━━━━━━━━\n\n` +
        `💰 <b>资产</b>\n` +
        `  🔴 TRX  ·  <b>${r.trx}</b>\n` +
        `  🟢 USDT ·  <b>${usdtBalance ?? '查询不可用'}</b>\n\n` +
        `⚡ <b>资源</b>\n` +
        `  🔋 Energy     <b>${resourceValue(r.energyUsed)}</b> / ${resourceValue(r.energyLimit)}  <i>${fmt(ep)}</i>\n` +
        `     ${bar(ep)}\n` +
        `  📶 Bandwidth  <b>${resourceValue((Number(r.netUsed) || 0) + (Number(r.freeNetUsed) || 0))}</b> / ${resourceValue((Number(r.netLimit) || 0) + (Number(r.freeNetLimit) || 0))}  <i>${fmt(np)}</i>\n` +
        `     ${bar(np)}\n` +
        `     <i>质押 ${resourceValue(r.netUsed)} · 免费 ${resourceValue(r.freeNetLimit)}</i>\n\n` +
        `━━━━━━━━━━━━━━━\n` +
        `ℹ️ 仅显示本系统已记录的链上交易`,
        new InlineKeyboard()
          .text(t(lang, 'wallet.history_in'), `wallet:history:in:${w.id}`)
          .text(t(lang, 'wallet.history_out'), `wallet:history:out:${w.id}`).row()
          .text('🔄 刷新', `wallet:resource:${w.id}`)
          .text(t(lang, 'wallet.other'), 'wallet:resources').row()
          .text(t(lang, 'wallet.back_home'), 'wallets')
          .text(t(lang, 'menu.home_short'), 'home')
      );
    } catch (e) {
      console.error('[wallet:resource]', e.message);
      await render(ctx, '查询失败，请检查 TRON API 配置或网络连接。', walletMenu);
    }
  });

  bot.callbackQuery(/^wallet:history:choose:(\d+)$/, async ctx => {
    const lang = await langOf(ctx, query);
    await ctx.answerCallbackQuery();
    const uid = await userIdFor(ctx.from.id);
    if (!uid) return render(ctx, '请先发送 /start', backHome);
    const rows = await query(
      "SELECT id,address FROM wallets WHERE id=? AND user_id=? AND wallet_type='monitor' AND is_active=1 LIMIT 1",
      [Number(ctx.match[1]), uid]
    );
    if (!rows.length) return render(ctx, '地址不存在、已停用或不属于你的账户。', walletMenu);
    const w = rows[0];
    await render(
      ctx,
      `📜 <b>历史记录</b>\n\n监听地址：\n<code>${w.address}</code>\n\n请选择记录类型：`,
      new InlineKeyboard()
        .text(t(lang, 'wallet.history_in'), `wallet:history:in:${w.id}`)
        .text(t(lang, 'wallet.history_out'), `wallet:history:out:${w.id}`).row()
        .text(t(lang, 'wallet.choose_other'), 'wallet:history').row()
        .text(t(lang, 'menu.home_short'), 'home')
    );
  });

  bot.callbackQuery(/^wallet:history:(in|out):(\d+)$/, async ctx => {
    const lang = await langOf(ctx, query);
    await ctx.answerCallbackQuery();
    const uid = await userIdFor(ctx.from.id);
    if (!uid) return render(ctx, '请先发送 /start', backHome);
    const direction = ctx.match[1];
    const walletId = Number(ctx.match[2]);
    const wallets = await query(
      "SELECT id,address FROM wallets WHERE id=? AND user_id=? AND wallet_type='monitor' AND is_active=1 LIMIT 1",
      [walletId, uid]
    );
    if (!wallets.length) return render(ctx, '地址不存在、已停用或不属于你的账户。', walletMenu);
    const address = wallets[0].address;
    const operator = direction === 'in' ? 'to_address' : 'from_address';
    const rows = await query(
      `SELECT tx_hash,token_contract,from_address,to_address,amount,block_timestamp,confirmed
         FROM transactions
        WHERE wallet_id=? AND ${operator}=?
        ORDER BY COALESCE(block_timestamp,0) DESC, id DESC LIMIT 10`,
      [walletId, address]
    );
    const body = rows.length
      ? rows.map((t, i) => {
          const token = t.token_contract === 'TRX_NATIVE' ? 'TRX' : (t.token_contract || '代币');
          const status = Number(t.confirmed) === 1 ? '已确认' : '待确认';
          return `${i + 1}. ${token} ${t.amount}\n` +
                 `时间：${fmtUtc(t.block_timestamp)}\n状态：${status}\n` +
                 `${shortAddr(t.from_address, 6, 6)} → ${shortAddr(t.to_address, 6, 6)}\n` +
                 `<code>${t.tx_hash}</code>`;
        }).join('\n\n')
      : `暂无此地址已记录的${direction === 'in' ? '收款' : '付款'}交易。\n未被事件源推送或未写入数据库的历史交易不会出现在这里。`;
    await render(
      ctx,
      `${direction === 'in' ? '📥' : '📤'} <b>${direction === 'in' ? '收款' : '付款'}记录（最近 10 笔）</b>\n\n` +
      `地址：<code>${address}</code>\n\n${body}`,
      new InlineKeyboard()
        .text(t(lang, 'wallet.in_short'), `wallet:history:in:${walletId}`)
        .text(t(lang, 'wallet.out_short'), `wallet:history:out:${walletId}`).row()
        .text(t(lang, 'wallet.detail'), `wallet:resource:${walletId}`)
        .text(t(lang, 'wallet.choose_other'), 'wallet:history').row()
        .text(t(lang, 'menu.home_short'), 'home')
    );
  });

  bot.on('message:text', async ctx => {
    const text = String(ctx.message.text || '').trim();
    if (text.startsWith('/')) return;
    const action = pendingInput.get(ctx.from.id);
    if (!action) return;

    if (action === 'addwallet') {
      if (!validateAddress(text)) {
        return render(ctx, '地址格式不正确，请重新发送 T 开头的有效 TRON 主网地址。', cancelMenu);
      }
      pendingInput.delete(ctx.from.id);
      const uid = await userIdFor(ctx.from.id);
      if (!uid) return render(ctx, '请先发送 /start', backHome);
      try {
        await query(
          "INSERT INTO wallets (user_id,address,wallet_type,label) VALUES (?,?, 'monitor','用户监控')",
          [uid, text]
        );
        await render(ctx, '✅ 已添加到你的只读监听地址。', walletMenu);
      } catch (e) {
        await render(
          ctx,
          e.code === 'ER_DUP_ENTRY' ? '该地址已存在，请勿重复添加。' : '添加失败，请稍后重试。',
          walletMenu
        );
      }
      return;
    }

    if (action === 'withdraw') {
      pendingInput.delete(ctx.from.id);
      const parts = text.split(/\s+/);
      if (parts.length !== 2) {
        return render(ctx, '格式不正确。请重新点击“提现申请”，发送：金额 空格 收款TRON地址', homeMenu);
      }
      const [amount, destination] = parts;
      if (!validateAddress(destination)) return render(ctx, '收款地址无效，请重新发起提现申请。', homeMenu);
      try { validateWithdrawalAmount(amount); } catch (e) { return render(ctx, e.message, homeMenu); }

      const conn = await pool.getConnection();
      let insertId;
      try {
        await conn.beginTransaction();
        const [users] = await conn.execute('SELECT id,balance FROM users WHERE telegram_id=? FOR UPDATE', [ctx.from.id]);
        if (!users.length) { await conn.rollback(); return render(ctx, '请先发送 /start', homeMenu); }
        const uid = users[0].id;
        const [pending] = await conn.execute(
          "SELECT COUNT(*) count FROM withdrawal_requests WHERE user_id=? AND status IN ('pending','approved')",
          [uid]
        );
        validatePendingCount(pending[0].count);
        const [daily] = await conn.execute(
          `SELECT CAST(COALESCE(SUM(amount),0) AS CHAR) total FROM withdrawal_requests
            WHERE user_id=? AND created_at >= UTC_DATE()
              AND created_at < DATE_ADD(UTC_DATE(), INTERVAL 1 DAY)
              AND status IN ('pending','approved','paid')`,
          [uid]
        );
        validateDailyTotal(daily[0].total || '0', amount);
        const [ins] = await conn.execute(
          "INSERT INTO withdrawal_requests (user_id,amount,currency,destination_address,status) VALUES (?,?, 'USDT',?,'pending')",
          [uid, amount, destination]
        );
        insertId = ins.insertId;
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        return render(ctx, e.message || '提现申请失败，请稍后重试。', homeMenu);
      } finally { conn.release(); }

      return render(
        ctx,
        `✅ <b>提现申请已提交</b>\n\n编号：#${insertId}\n金额：${amount} USDT\n收款地址：${destination}\n状态：待管理员审核。`,
        backHome
      );
    }
  });

  bot.command('pendingrecharges', async ctx => {
    if (!await requireAdmin(ctx)) return;
    const rows = await query(
      "SELECT id,user_id,amount,tx_hash,event_index,chain_verified_at,created_at FROM recharge_orders WHERE status='pending' ORDER BY id ASC LIMIT 30"
    );
    await ctx.reply(rows.length
      ? '待审核充值（最多 30 笔）：\n' + rows.map(r =>
          `#${r.id} 用户#${r.user_id} ${r.amount} USDT\nTx: ${r.tx_hash || '无链上交易'} / 事件 ${r.event_index}\n链上核验：${r.chain_verified_at || '未核验'}`
        ).join('\n\n')
      : '当前没有待审核充值。');
  });

  bot.command('verifyrecharge', async ctx => {
    if (!await requireAdmin(ctx)) return;
    const id = Number(String(ctx.match || '').trim());
    if (!Number.isSafeInteger(id) || id <= 0) return ctx.reply('用法：/verifyrecharge 充值订单ID');
    const rows = await query(
      "SELECT r.*,w.address FROM recharge_orders r JOIN wallets w ON w.id=r.wallet_id WHERE r.id=? AND r.status='pending' AND r.source='tron'",
      [id]
    );
    if (!rows.length) return ctx.reply('未找到对应的待审核链上充值订单。');
    const order = rows[0];
    try {
      const transfers = await getConfirmedTrc20Transfer(order.tx_hash);
      const verified = verifyDepositTransfer(
        transfers.map(t => ({
          ...t, rawAmount: t.rawAmount, txHash: t.txHash, contract: t.contract,
          to: t.to, decimals: t.decimals, confirmed: t.confirmed
        })),
        {
          contract: process.env.TRON_USDT_CONTRACT,
          to: order.address,
          amount: String(order.amount),
          decimals: Number(process.env.TRON_USDT_DECIMALS || 6)
        }
      );
      if (verified.tx_hash !== String(order.tx_hash).toLowerCase()) throw new Error('核验交易哈希不一致');
      await query(
        "UPDATE recharge_orders SET chain_verified_at=NOW(),chain_verified_json=? WHERE id=? AND status='pending'",
        [JSON.stringify(verified), id]
      );
      await ctx.reply(
        `充值 #${id} 链上核验通过。\n金额：${order.amount} USDT\n地址：${order.address}\n现在可执行 /approverecharge ${id} 完成入账。`
      );
    } catch (e) {
      await ctx.reply(`核验失败，未入账：${e.message}`);
    }
  });

  bot.command('approverecharge', async ctx => {
    if (!await requireAdmin(ctx)) return;
    const id = Number(String(ctx.match || '').trim());
    if (!Number.isSafeInteger(id) || id <= 0) return ctx.reply('用法：/approverecharge 充值订单ID');
    try {
      const result = await creditRecharge(id, `telegram:${ctx.from.id}`);
      if (!result.credited) return ctx.reply(`订单 #${id} 已处理或未入账（${result.reason || 'unknown'}）。`);
      await ctx.reply(`充值 #${id} 已完成入账：${result.amount} USDT，用户 #${result.userId}。`);
      const user = await query('SELECT telegram_id,balance FROM users WHERE id=?', [result.userId]);
      if (user[0]) {
        await sendTelegramMessage(
          user[0].telegram_id,
          `充值已审核通过\n订单：#${id}\n金额：${result.amount} USDT\n当前余额：${user[0].balance} USDT`
        );
      }
    } catch (e) {
      await ctx.reply(`入账失败：${e.message}\n请勿重复手工加余额。`);
    }
  });

  bot.command('rejectrecharge', async ctx => {
    if (!await requireAdmin(ctx)) return;
    const parts = String(ctx.match || '').trim().split(/\s+/);
    const id = Number(parts.shift());
    const reason = parts.join(' ').slice(0, 400);
    if (!Number.isSafeInteger(id) || id <= 0 || !reason) return ctx.reply('用法：/rejectrecharge 充值订单ID 拒绝原因');
    const [result] = await pool.execute(
      "UPDATE recharge_orders SET status='rejected',note=?,reviewed_by=?,reviewed_at=NOW() WHERE id=? AND status='pending'",
      [reason, `telegram:${ctx.from.id}`, id]
    );
    await ctx.reply(result.affectedRows ? `充值 #${id} 已拒绝。` : '订单不存在或已处理。');
  });

  bot.catch(err => console.error('[bot] error:', err.stack || err.message));
  return bot;
}

module.exports = { createBot };
