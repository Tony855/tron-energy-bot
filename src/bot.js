
function resourceValue(value) {
  if (value === null || value === undefined || value === '') return '0';
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? String(n) : '暂无数据';
}

const { Bot, InlineKeyboard } = require('grammy');
const crypto = require('crypto');
const { query } = require('./db');
const { validateAddress, getAccount } = require('./tron');
const { assignNextDepositAddress } = require('./depositPool');
const { sendTelegramMessage } = require('./notifier');
const { creditRecharge } = require('./ledger');
const { getConfirmedTrc20Transfer } = require('./tron');
const { verifyDepositTransfer } = require('./chainDepositVerify');

function code() { return crypto.randomBytes(5).toString('hex').toUpperCase(); }

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

const menu = new InlineKeyboard()
  .text('👛 钱包管理', 'wallets').text('💰 余额查询', 'balance').row()
  .text('📥 充值地址', 'deposit').text('📤 提现申请', 'withdraw').row()
  .text('🧾 交易记录', 'transactions').text('📡 监听状态', 'status').row()
  .text('📊 今日简报', 'report').text('⚡ 能量服务', 'energy').row()
  .text('🎁 邀请好友', 'referral').text('❔ 使用帮助', 'help').row()
  .webApp('▣ 打开钱包控制台', 'https://tron.v2net.cc/miniapp/');

const homeKeyboard = () => new InlineKeyboard().text('🏠 返回主菜单', 'home');
const walletKeyboard = () => new InlineKeyboard()
  .text('➕ 添加监控地址', 'wallet:add').row()
  .text('📋 我的地址', 'wallet:list').text('🗑 停用地址', 'wallet:remove').row()
  .text('♻️ 已停用地址', 'wallet:disabled').row()
  .text('🔎 查询资源与余额', 'wallet:resources').row()
  .text('📜 历史记录', 'wallet:history').row()
  .text('🏠 返回主菜单', 'home');
const cancelKeyboard = () => new InlineKeyboard().text('✖️ 取消操作', 'cancel').text('🏠 主菜单', 'home');

function createBot() {
  if (!process.env.BOT_TOKEN) {
    console.warn('[bot] BOT_TOKEN not configured; Telegram bot disabled');
    return null;
  }
  const bot = new Bot(process.env.BOT_TOKEN);
  const pendingInput = new Map();
  const userIdFor = async telegramId => { const rows = await query('SELECT id FROM users WHERE telegram_id=?', [telegramId]); return rows[0]?.id || null; };
  const showHome = async ctx => {
    const u = await getOrCreateUser(ctx);
    const text = `👋 欢迎回来，${u.first_name || '顾客'}！\n\n💰 可用余额：${u.balance} USDT\n请选择下面的服务。\n\n🔐 请勿发送助记词、私钥或验证码。`;

    // 点击内联“主菜单”时优先编辑原消息，避免重复发送菜单。
    if (ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText(text, { reply_markup: menu });
        return;
      } catch (e) {
        if (!String(e.description || e.message || '').includes('message is not modified')) {
          // 原消息不能编辑时，退回发送新消息。
        } else {
          return;
        }
      }
    }

    await ctx.reply(text, { reply_markup: menu });
  };
  bot.command('start', showHome);
  bot.command('help', ctx => ctx.reply('命令：/start /balance /wallets /addwallet /removewallet /resources /deposit /withdraw /transactions /status /referral /report\n管理员：/pendingrecharges /verifyrecharge ID /approverecharge ID /rejectrecharge ID 原因\n请勿向机器人发送助记词或私钥。'));
  bot.command('balance', async ctx => {
    const rows = await query('SELECT balance FROM users WHERE telegram_id=?', [ctx.from.id]);
    if (!rows.length) return ctx.reply('请先发送 /start');
    ctx.reply(`当前可用余额：${rows[0].balance} USDT`);
  });
  bot.command('status', async ctx => {
    const users = await query('SELECT id FROM users WHERE telegram_id=?', [ctx.from.id]);
    if (!users.length) return ctx.reply('请先发送 /start');
    const [rows] = await query(`SELECT COUNT(*) count, MAX(last_scanned_at) last_scan FROM wallets WHERE user_id=? AND is_active=1`, [users[0].id]);
    const [tx] = await query(`SELECT COUNT(*) count FROM transactions WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id=?) AND created_at >= NOW() - INTERVAL 24 HOUR`, [users[0].id]);
    await ctx.reply(`监听状态\n启用地址：${rows.count}\n最近扫描：${rows.last_scan || '尚未完成首次扫描'}\n近24小时新入库交易：${tx.count}\n支持：TRX 原生转账、配置的 USDT-TRC20 合约\n说明：事件驱动模式；实时性取决于已配置的第三方 TRON 事件推送服务。未配置推送源时不会自动发现新交易。`);
  });
  bot.command('transactions', async ctx => {
    const users = await query('SELECT id FROM users WHERE telegram_id=?', [ctx.from.id]);
    if (!users.length) return ctx.reply('请先发送 /start');
    const rows = await query(`SELECT t.tx_hash,t.event_index,t.token_contract,t.from_address,t.to_address,t.amount,t.block_timestamp,w.address
      FROM transactions t JOIN wallets w ON w.id=t.wallet_id WHERE w.user_id=? ORDER BY t.id DESC LIMIT 10`, [users[0].id]);
    if (!rows.length) return ctx.reply('暂时没有已识别的交易。');
    await ctx.reply('最近 10 笔已识别交易：\n' + rows.map((t,i) => `${i+1}. ${t.token_contract === 'TRX_NATIVE' ? 'TRX' : 'USDT-TRC20'} ${t.amount}\n${t.from_address} → ${t.to_address}\nTx: ${t.tx_hash}`).join('\n\n'));
  });
  bot.command('removewallet', async ctx => {
    const address = String(ctx.match || '').trim();
    if (!validateAddress(address)) return ctx.reply('用法：/removewallet T开头的TRON地址');
    const users = await query('SELECT id FROM users WHERE telegram_id=?', [ctx.from.id]);
    if (!users.length) return ctx.reply('请先发送 /start');
    const [result] = await require('./db').pool.execute(
      "UPDATE wallets SET is_active=0 WHERE user_id=? AND address=? AND wallet_type='monitor' AND is_active=1",
      [users[0].id, address]
    );
    await ctx.reply(result.affectedRows ? '监控地址已停用；历史交易记录保留。' : '没有找到属于你的启用中监控地址。');
  });
  bot.command('wallets', async ctx => {
    const u = await query('SELECT id FROM users WHERE telegram_id=?', [ctx.from.id]);
    if (!u.length) return ctx.reply('请先发送 /start');
    const ws = await query("SELECT address,label,wallet_type,last_scanned_at FROM wallets WHERE user_id=? AND is_active=1", [u[0].id]);
    await ctx.reply('👛 我的地址\n\n' + (ws.length ? ws.map(w => `${w.wallet_type === 'deposit' ? '📥 专属充值地址' : '👁 只读监控地址'} ${w.label || ''}\n<code>${w.address}</code>\n最近事件：${w.last_scanned_at || '等待事件源推送'}`).join('\n\n') : '你还没有绑定地址。') + '\n\n⚠️ 只读监控地址不会自动成为充值地址。', { parse_mode: 'HTML', reply_markup: walletKeyboard() });
  });
  bot.command('addwallet', async ctx => {
    const address = String(ctx.match || '').trim();

    // 仅输入 /addwallet 时，进入引导输入模式。
    if (!address) {
      pendingInput.set(ctx.from.id, 'addwallet');
      return ctx.reply(
        '➕ <b>添加只读监控地址</b>\n\n请直接发送 TRON 主网公开地址（T 开头），不要发送私钥。\n发送 /cancel 可取消。',
        { parse_mode: 'HTML', reply_markup: cancelKeyboard() }
      );
    }

    if (!validateAddress(address)) {
      pendingInput.set(ctx.from.id, 'addwallet');
      return ctx.reply(
        '地址格式不正确，请重新发送 T 开头的有效 TRON 主网地址，或点击取消。',
        { reply_markup: cancelKeyboard() }
      );
    }

    const users = await query('SELECT id FROM users WHERE telegram_id=?', [ctx.from.id]);
    if (!users.length) return ctx.reply('请先发送 /start');

    try {
      await query(
        "INSERT INTO wallets (user_id,address,wallet_type,label) VALUES (?,?, 'monitor','用户监控')",
        [users[0].id, address]
      );
      pendingInput.delete(ctx.from.id);
      return ctx.reply(
        '✅ 地址已添加到你的独立只读监控列表。\n\n钱包、交易与通知仅关联你的账户。实时发现交易需要管理员配置第三方 TRON 事件推送服务。',
        { reply_markup: walletKeyboard() }
      );
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        pendingInput.delete(ctx.from.id);
        return ctx.reply('该地址已存在，请勿重复添加。', {
          reply_markup: walletKeyboard()
        });
      }
      console.error('[addwallet]', e.message);
      return ctx.reply('添加失败，请重试或发送 /cancel 取消。', {
        reply_markup: cancelKeyboard()
      });
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
  bot.command('deposit', async ctx => {
    const u = await query('SELECT id FROM users WHERE telegram_id=?', [ctx.from.id]);
    if (!u.length) return ctx.reply('请先发送 /start');
    let ws = await query("SELECT address FROM wallets WHERE user_id=? AND wallet_type='deposit' AND is_active=1 LIMIT 1", [u[0].id]);
    if (!ws.length) {
      try {
        const assigned = await assignNextDepositAddress(u[0].id);
        if (assigned.reason === 'pool_empty') return ctx.reply('当前没有可分配的充值地址，请稍后再试或联系管理员。请勿向其他地址转账。');
        ws = [{ address: assigned.address }];
      } catch (e) {
        console.error('[deposit] address assignment failed:', e.message);
        return ctx.reply('暂时无法分配充值地址，请联系管理员。请勿向其他地址转账。');
      }
    }
    await ctx.reply(`📥 <b>你的专属充值地址</b>\n\n<code>${ws[0].address}</code>\n\n网络：TRON 主网\n币种：USDT-TRC20\n\n⚠️ 仅发送指定合约的 USDT。请勿发送 TRX 或其他代币。到账识别后仍需链上核验与审核。`, { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🔄 查看充值地址', 'deposit').row().text('🧾 我的交易', 'transactions').row().text('🏠 主菜单', 'home') });
  });
  bot.command('withdraw', async ctx => {
    const args = String(ctx.match || '').trim().split(/\s+/);
    const amount = args[0];
    const destination = args[1];
    if (!amount || !destination) return ctx.reply('用法：/withdraw 金额 T开头的TRON地址\n例如：/withdraw 10 T...');
    const { validateAddress } = require('./tron');
    const { validateWithdrawalAmount, validatePendingCount, validateDailyTotal } = require('./withdrawalPolicy');
    if (!validateAddress(destination)) return ctx.reply('TRON 地址无效，请检查地址及校验和。');
    try { validateWithdrawalAmount(amount); } catch (e) { return ctx.reply(e.message); }
    const { pool } = require('./db');
    const conn = await pool.getConnection();
    let result;
    try {
      await conn.beginTransaction();
      const [users] = await conn.execute('SELECT id,balance FROM users WHERE telegram_id=? FOR UPDATE', [ctx.from.id]);
      if (!users.length) { await conn.rollback(); return ctx.reply('请先发送 /start'); }
      const user = users[0];
      const [pending] = await conn.execute("SELECT COUNT(*) count FROM withdrawal_requests WHERE user_id=? AND status IN ('pending','approved')", [user.id]);
      validatePendingCount(pending[0].count);
      const [daily] = await conn.execute("SELECT CAST(COALESCE(SUM(amount),0) AS CHAR) total FROM withdrawal_requests WHERE user_id=? AND created_at >= UTC_DATE() AND created_at < DATE_ADD(UTC_DATE(), INTERVAL 1 DAY) AND status IN ('pending','approved','paid')", [user.id]);
      validateDailyTotal(daily[0].total || '0', amount);
      result = await conn.execute("INSERT INTO withdrawal_requests (user_id,amount,currency,destination_address,status) VALUES (?,?, 'USDT',?,'pending')", [user.id, amount, destination]);
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      return ctx.reply(e.message || '提现申请失败，请稍后重试。');
    } finally { conn.release(); }
    await ctx.reply(`提现申请已提交，编号 #${result[0].insertId}\n金额：${amount} USDT\n收款地址：${destination}\n状态：待管理员审核\n\n批准后将从系统可用余额扣款，链上转账由管理员人工执行。`);
  });
  bot.command('referral', async ctx => {
    const rows = await query('SELECT id,referral_code FROM users WHERE telegram_id=?', [ctx.from.id]);
    if (!rows.length) return ctx.reply('请先发送 /start');
    const botName = (await bot.api.getMe()).username;
    const [stats] = await query('SELECT COUNT(*) c FROM users WHERE referred_by=?', [rows[0].id]);
    ctx.reply(`邀请人数：${stats.c}\n推广链接：https://t.me/${botName}?start=${rows[0].referral_code}\n返佣比例：${process.env.REFERRAL_COMMISSION_PERCENT || 3}%（按符合规则的充值计算）`);
  });
  bot.command('report', async ctx => {
    const users = await query('SELECT id FROM users WHERE telegram_id=?', [ctx.from.id]);
    if (!users.length) return ctx.reply('请先发送 /start');
    const [w] = await query('SELECT COUNT(*) c FROM wallets WHERE user_id=? AND is_active=1', [users[0].id]);
    const [t] = await query("SELECT COUNT(*) c, COALESCE(SUM(CASE WHEN token_contract='TRX_NATIVE' THEN amount ELSE 0 END),0) trx_total, COALESCE(SUM(CASE WHEN token_contract<>'TRX_NATIVE' THEN amount ELSE 0 END),0) usdt_total FROM transactions WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id=?) AND block_timestamp >= UNIX_TIMESTAMP(UTC_DATE())*1000 AND block_timestamp < UNIX_TIMESTAMP(UTC_DATE() + INTERVAL 1 DAY)*1000", [users[0].id]);
    ctx.reply(`今日简报\n监控钱包：${w.c}\n识别交易事件：${t.c}\nTRX 转账金额：${t.trx_total} TRX\nUSDT-TRC20 转账金额：${t.usdt_total} USDT\n注：金额按转账事件累计，收/转方向均计入；统计使用 UTC 日期。`);
  });
  const adminIds = new Set(String(process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(x => x.trim()).filter(Boolean));
  const requireAdmin = async ctx => {
    if (!adminIds.has(String(ctx.from.id))) { await ctx.reply('无权执行此管理员操作。'); return false; }
    return true;
  };
  bot.command('pendingrecharges', async ctx => {
    if (!await requireAdmin(ctx)) return;
    const rows = await query("SELECT id,user_id,amount,tx_hash,event_index,chain_verified_at,created_at FROM recharge_orders WHERE status='pending' ORDER BY id ASC LIMIT 30");
    await ctx.reply(rows.length ? '待审核充值（最多30笔）：\n' + rows.map(r => `#${r.id} 用户#${r.user_id} ${r.amount} USDT\nTx: ${r.tx_hash || '无链上交易'} / 事件 ${r.event_index}\n链上核验：${r.chain_verified_at || '未核验'}`).join('\n\n') : '当前没有待审核充值。');
  });
  bot.command('verifyrecharge', async ctx => {
    if (!await requireAdmin(ctx)) return;
    const id = Number(String(ctx.match || '').trim());
    if (!Number.isSafeInteger(id) || id <= 0) return ctx.reply('用法：/verifyrecharge 充值订单ID');
    const rows = await query("SELECT r.*,w.address FROM recharge_orders r JOIN wallets w ON w.id=r.wallet_id WHERE r.id=? AND r.status='pending' AND r.source='tron'", [id]);
    if (!rows.length) return ctx.reply('未找到对应的待审核链上充值订单。');
    const order = rows[0];
    try {
      const transfers = await getConfirmedTrc20Transfer(order.tx_hash);
      const verified = verifyDepositTransfer(transfers.map(t => ({ ...t, rawAmount: t.rawAmount, txHash: t.txHash, contract: t.contract, to: t.to, decimals: t.decimals, confirmed: t.confirmed })), {
        contract: process.env.TRON_USDT_CONTRACT, to: order.address, amount: String(order.amount), decimals: Number(process.env.TRON_USDT_DECIMALS || 6)
      });
      if (verified.tx_hash !== String(order.tx_hash).toLowerCase()) throw new Error('核验交易哈希不一致');
      await query('UPDATE recharge_orders SET chain_verified_at=NOW(),chain_verified_json=? WHERE id=? AND status=\'pending\'', [JSON.stringify(verified), id]);
      await ctx.reply(`充值 #${id} 链上核验通过。\n金额：${order.amount} USDT\n地址：${order.address}\n现在可执行 /approverecharge ${id} 完成入账。`);
    } catch (e) { await ctx.reply(`核验失败，未入账：${e.message}`); }
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
      if (user[0]) await sendTelegramMessage(user[0].telegram_id, `充值已审核通过\n订单：#${id}\n金额：${result.amount} USDT\n当前余额：${user[0].balance} USDT`);
    } catch (e) { await ctx.reply(`入账失败：${e.message}\n请勿重复手工加余额。`); }
  });
  bot.command('rejectrecharge', async ctx => {
    if (!await requireAdmin(ctx)) return;
    const parts = String(ctx.match || '').trim().split(/\\s+/);
    const id = Number(parts.shift());
    const reason = parts.join(' ').slice(0, 400);
    if (!Number.isSafeInteger(id) || id <= 0 || !reason) return ctx.reply('用法：/rejectrecharge 充值订单ID 拒绝原因');
    const [result] = await require('./db').pool.execute("UPDATE recharge_orders SET status='rejected',note=?,reviewed_by=?,reviewed_at=NOW() WHERE id=? AND status='pending'", [reason, `telegram:${ctx.from.id}`, id]);
    await ctx.reply(result.affectedRows ? `充值 #${id} 已拒绝。` : '订单不存在或已处理。');
  });

  bot.callbackQuery('home', async ctx => { await ctx.answerCallbackQuery(); await showHome(ctx); });
  bot.callbackQuery('cancel', async ctx => { pendingInput.delete(ctx.from.id); await ctx.answerCallbackQuery({ text: '已取消' }); await ctx.reply('已取消当前操作。', { reply_markup: menu }); });
  bot.callbackQuery('help', async ctx => { await ctx.answerCallbackQuery(); await ctx.reply('❓ 帮助中心\n\n👛 钱包管理：绑定公开地址进行只读监控\n📥 充值：获取系统分配的专属地址\n📤 提现：提交申请，等待管理员审核\n🧾 交易记录：查看已识别的链上事件\n📡 监听状态：查看最近事件接收情况\n\n🔐 永远不要向机器人发送助记词、私钥或验证码。', { reply_markup: homeKeyboard() }); });
  bot.callbackQuery('balance', async ctx => {
    const r = await query('SELECT balance FROM users WHERE telegram_id=?', [ctx.from.id]);
    await ctx.answerCallbackQuery();
    await ctx.reply(r.length ? `💰 <b>我的余额</b>\n\n可用余额：<b>${r[0].balance} USDT</b>\n\n提现需要提交申请并通过审核。` : '请先发送 /start', { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('📤 申请提现', 'withdraw').row().text('📥 充值', 'deposit').row().text('🏠 主菜单', 'home') });
  });
  bot.callbackQuery('wallets', async ctx => {
    await ctx.answerCallbackQuery();
    const uid = await userIdFor(ctx.from.id);
    if (!uid) return ctx.reply('请先发送 /start');

    try {
      const ws = await query(
        "SELECT id,address FROM wallets WHERE user_id=? AND wallet_type='monitor' AND is_active=1 ORDER BY id DESC LIMIT 20",
        [uid]
      );

      const kb = new InlineKeyboard();
      for (const w of ws) {
        kb.text('👁 ' + w.address.slice(0, 8) + '…' + w.address.slice(-5),
          'wallet:resource:' + w.id).row();
      }
      kb.text('➕ 添加监控地址', 'wallet:add').row()
        .text('📜 历史记录', 'wallet:history')
        .text('🗑 停用地址', 'wallet:remove').row()
        .text('🏠 返回主菜单', 'home');

      await ctx.reply(
        '👛 <b>钱包管理</b>\n\n' +
        (ws.length ? '选择一个监控地址查看余额、资源和交易记录。' : '目前没有启用的监控地址，请先添加。') +
        '\n监控为只读功能，不需要提供私钥。',
        { parse_mode: 'HTML', reply_markup: kb }
      );
    } catch (e) {
      console.error('[wallets]', e.message);
      await ctx.reply('读取监控地址失败，请稍后重试。', {
        reply_markup: walletKeyboard()
      });
    }
  });
  bot.callbackQuery('wallet:list', async ctx => {
    await ctx.answerCallbackQuery(); const uid = await userIdFor(ctx.from.id); if (!uid) return ctx.reply('请先发送 /start');
    const ws = await query("SELECT id,address,label,wallet_type,last_scanned_at FROM wallets WHERE user_id=? AND is_active=1 ORDER BY id DESC LIMIT 20", [uid]);
    await ctx.reply('📋 <b>我的地址</b>\n\n' + (ws.length ? ws.map(w => `${w.wallet_type === 'deposit' ? '📥 充值地址' : '👁 监控地址'} ${w.label || ''}\n<code>${w.address}</code>\n最近事件：${w.last_scanned_at || '等待事件源推送'}`).join('\n\n') : '暂无地址。'), { parse_mode: 'HTML', reply_markup: walletKeyboard() });
  });
  bot.callbackQuery('wallet:add', async ctx => { pendingInput.set(ctx.from.id, 'addwallet'); await ctx.answerCallbackQuery(); await ctx.reply('➕ <b>添加监控地址</b>\n\n请发送 TRON 主网公开地址（T 开头）。\n本功能只读监控，不会要求私钥。', { parse_mode: 'HTML', reply_markup: cancelKeyboard() }); });

  // 已停用监控地址：允许恢复，或进入永久删除确认流程。
  bot.callbackQuery('wallet:disabled', async ctx => {
    await ctx.answerCallbackQuery();
    const uid = await userIdFor(ctx.from.id);
    if (!uid) return ctx.reply('请先发送 /start');

    const ws = await query(
      "SELECT id,address FROM wallets WHERE user_id=? AND wallet_type='monitor' AND is_active=0 ORDER BY id DESC LIMIT 20",
      [uid]
    );
    const kb = new InlineKeyboard();
    for (const w of ws) {
      kb.text('♻️ ' + w.address.slice(0, 8) + '…' + w.address.slice(-5),
        'wallet:restore:' + w.id).row();
      kb.text('🗑 删除 ' + w.address.slice(0, 6) + '…' + w.address.slice(-4),
        'wallet:delete:' + w.id).row();
    }
    kb.text('↩️ 返回钱包管理', 'wallets').row().text('🏠 主菜单', 'home');
    return ctx.reply(
      ws.length ? '♻️ 已停用的监控地址\n请选择恢复或申请永久删除。' : '目前没有已停用的监控地址。',
      { reply_markup: kb }
    );
  });

  bot.callbackQuery(/^wallet:restore:(\d+)$/, async ctx => {
    await ctx.answerCallbackQuery();
    const uid = await userIdFor(ctx.from.id);
    if (!uid) return ctx.reply('请先发送 /start');
    const id = Number(ctx.match[1]);
    const [r] = await require('./db').pool.execute(
      "UPDATE wallets SET is_active=1 WHERE id=? AND user_id=? AND wallet_type='monitor' AND is_active=0",
      [id, uid]
    );
    return ctx.reply(
      r.affectedRows ? '✅ 监控地址已恢复启用。' : '地址不存在、已启用或不属于你的账户。',
      { reply_markup: walletKeyboard() }
    );
  });

  bot.callbackQuery(/^wallet:delete:(\d+)$/, async ctx => {
    await ctx.answerCallbackQuery();
    const uid = await userIdFor(ctx.from.id);
    if (!uid) return ctx.reply('请先发送 /start');
    const id = Number(ctx.match[1]);
    const rows = await query(
      "SELECT id,address FROM wallets WHERE id=? AND user_id=? AND wallet_type='monitor' AND is_active=0",
      [id, uid]
    );
    if (!rows.length) {
      return ctx.reply('只能删除属于你自己的已停用监控地址。', {
        reply_markup: walletKeyboard()
      });
    }
    const kb = new InlineKeyboard()
      .text('⚠️ 确认永久删除', 'wallet:delete:confirm:' + id).row()
      .text('✖️ 取消', 'wallet:disabled').row()
      .text('🏠 主菜单', 'home');
    return ctx.reply(
      '⚠️ 永久删除确认\n\n地址：\n<code>' + rows[0].address +
      '</code>\n\n只有没有交易、充值、补扫或告警记录的地址才允许删除。此操作不可撤销。',
      { parse_mode: 'HTML', reply_markup: kb }
    );
  });

  bot.callbackQuery(/^wallet:delete:confirm:(\d+)$/, async ctx => {
    await ctx.answerCallbackQuery();
    const uid = await userIdFor(ctx.from.id);
    if (!uid) return ctx.reply('请先发送 /start');
    const id = Number(ctx.match[1]);
    const pool = require('./db').pool;
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
        return ctx.reply('地址不存在、未停用或不属于你的账户，已取消删除。', {
          reply_markup: walletKeyboard()
        });
      }

      // 只检查当前数据库实际存在的关联表；检查失败时拒绝删除。
      const [tableRows] = await conn.execute(
        "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()"
      );
      const existingTables = new Set(tableRows.map(r => r.TABLE_NAME));
      const checks = [
        ['transactions', 'SELECT COUNT(*) AS n FROM transactions WHERE wallet_id=?'],
        ['recharge_orders', 'SELECT COUNT(*) AS n FROM recharge_orders WHERE wallet_id=?'],
        ['deposit_address_pool', 'SELECT COUNT(*) AS n FROM deposit_address_pool WHERE assigned_wallet_id=?'],
        ['chain_backfill_state', 'SELECT COUNT(*) AS n FROM chain_backfill_state WHERE wallet_id=?'],
        ['chain_alert_events', 'SELECT COUNT(*) AS n FROM chain_alert_events WHERE wallet_id=?']
      ];

      for (const [name, sql] of checks) {
        if (!existingTables.has(name)) continue;
        const [rows] = await conn.execute(sql, [id]);
        if (Number(rows[0].n) > 0) {
          await conn.rollback();
          return ctx.reply(
            '⛔ 为保护历史数据，不能永久删除此地址：存在 ' + name +
            ' 关联记录。你仍可以保留或重新启用该地址。',
            { reply_markup: walletKeyboard() }
          );
        }
      }

      // 未知表或未覆盖的业务关联不在此处自动清理；外键约束仍会阻止不安全删除。

      const [r] = await conn.execute(
        "DELETE FROM wallets WHERE id=? AND user_id=? AND wallet_type='monitor' AND is_active=0",
        [id, uid]
      );
      if (r.affectedRows !== 1) {
        await conn.rollback();
        return ctx.reply('地址状态已变化，未执行删除。', {
          reply_markup: walletKeyboard()
        });
      }
      await conn.commit();
      return ctx.reply('✅ 地址已永久删除。未删除任何交易记录。', {
        reply_markup: walletKeyboard()
      });
    } catch (e) {
      if (conn) {
        try { await conn.rollback(); } catch (_) {}
      }
      console.error('[wallet:delete]', e.message);
      return ctx.reply(
        '删除操作未完成。为保护数据，检查失败时系统会拒绝删除，请保留该地址并检查日志。',
        { reply_markup: walletKeyboard() }
      );
    } finally {
      if (conn) conn.release();
    }
  });

  bot.callbackQuery('wallet:remove', async ctx => {
    await ctx.answerCallbackQuery(); const uid = await userIdFor(ctx.from.id); if (!uid) return ctx.reply('请先发送 /start');
    const ws = await query("SELECT id,address FROM wallets WHERE user_id=? AND wallet_type='monitor' AND is_active=1 ORDER BY id DESC LIMIT 10", [uid]);
    if (!ws.length) return ctx.reply('没有可停用的监控地址。', { reply_markup: walletKeyboard() });
    const kb = new InlineKeyboard(); ws.forEach(w => kb.text(`🗑 ${w.address.slice(0,7)}…${w.address.slice(-5)}`, `wallet:rm:${w.id}`).row()); kb.text('↩️ 返回钱包管理', 'wallets');
    await ctx.reply('选择要停用的地址。停用后不再接收新通知，历史记录保留。', { reply_markup: kb });
  });
  bot.callbackQuery(/^wallet:rm:(\d+)$/, async ctx => {
    await ctx.answerCallbackQuery();
    const uid = await userIdFor(ctx.from.id);
    if (!uid) return ctx.reply('请先发送 /start');

    const id = Number(ctx.match[1]);
    const rows = await query(
      "SELECT id,address FROM wallets WHERE id=? AND user_id=? AND wallet_type='monitor' AND is_active=1 LIMIT 1",
      [id, uid]
    );
    if (!rows.length) {
      return ctx.reply('地址不存在、已停用或不属于你的账户。', {
        reply_markup: walletKeyboard()
      });
    }

    const kb = new InlineKeyboard()
      .text('⚠️ 确认停用', 'wallet:rm:yes:' + id).row()
      .text('✖️ 取消', 'wallets');

    return ctx.reply(
      '请确认是否停用这个监控地址：\n<code>' + rows[0].address +
      '</code>\n\n停用后将不再接收新通知，历史交易记录会保留。',
      { parse_mode: 'HTML', reply_markup: kb }
    );
  });

  bot.callbackQuery(/^wallet:rm:yes:(\d+)$/, async ctx => {
    await ctx.answerCallbackQuery();
    const uid = await userIdFor(ctx.from.id);
    if (!uid) return ctx.reply('请先发送 /start');

    const id = Number(ctx.match[1]);
    const [r] = await require('./db').pool.execute(
      "UPDATE wallets SET is_active=0 WHERE id=? AND user_id=? AND wallet_type='monitor' AND is_active=1",
      [id, uid]
    );
    return ctx.reply(
      r.affectedRows ? '✅ 地址已停用，历史交易仍保留。' : '地址不存在、已停用或不属于你的账户。',
      { reply_markup: walletKeyboard() }
    );
  });

  // 独立历史记录入口：仅列出当前用户启用的监控地址
  bot.callbackQuery('wallet:history', async ctx => {
    await ctx.answerCallbackQuery();
    const uid = await userIdFor(ctx.from.id);
    if (!uid) return ctx.reply('请先发送 /start');

    try {
      const ws = await query(
        "SELECT id,address FROM wallets WHERE user_id=? AND wallet_type='monitor' AND is_active=1 ORDER BY id DESC LIMIT 20",
        [uid]
      );

      if (!ws.length) {
        return ctx.reply('你还没有启用的监控地址，请先添加监控地址。', {
          reply_markup: walletKeyboard()
        });
      }

      const kb = new InlineKeyboard();
      for (const w of ws) {
        kb.text(
          '📜 ' + w.address.slice(0, 8) + '…' + w.address.slice(-5),
          'wallet:history:choose:' + w.id
        ).row();
      }
      kb.text('↩️ 返回钱包管理', 'wallets');

      return ctx.reply('📜 历史记录\n\n请选择要查询的监听地址：', {
        reply_markup: kb
      });
    } catch (e) {
      console.error('[wallet:history list]', e.message);
      return ctx.reply('读取监听地址失败，请稍后重试。', {
        reply_markup: walletKeyboard()
      });
    }
  });

  // 历史记录地址选择：验证钱包归属后显示收款/付款按钮
  bot.callbackQuery(/^wallet:history:choose:(\d+)$/, async ctx => {
    await ctx.answerCallbackQuery();
    const uid = await userIdFor(ctx.from.id);
    if (!uid) return ctx.reply('请先发送 /start');

    try {
      const rows = await query(
        "SELECT id,address FROM wallets WHERE id=? AND user_id=? AND wallet_type='monitor' AND is_active=1 LIMIT 1",
        [Number(ctx.match[1]), uid]
      );
      if (!rows.length) {
        return ctx.reply('地址不存在、已停用或不属于你的账户。', {
          reply_markup: walletKeyboard()
        });
      }

      const w = rows[0];
      const kb = new InlineKeyboard()
        .text('📥 收款记录', 'wallet:history:in:' + w.id).row()
        .text('📤 付款记录', 'wallet:history:out:' + w.id).row()
        .text('↩️ 选择其他地址', 'wallet:history').row()
        .text('🏠 返回主菜单', 'home');

      return ctx.reply(
        '📜 <b>历史记录</b>\n\n监听地址：\n<code>' +
        w.address +
        '</code>\n\n请选择记录类型：',
        { parse_mode: 'HTML', reply_markup: kb }
      );
    } catch (e) {
      console.error('[wallet:history choose]', e.message);
      return ctx.reply('读取历史记录失败，请稍后重试。', {
        reply_markup: walletKeyboard()
      });
    }
  });

  // 查询资源：仅列出当前 Telegram 用户自己的有效监控地址
  bot.callbackQuery('wallet:resources', async ctx => {
    await ctx.answerCallbackQuery();
    const uid = await userIdFor(ctx.from.id);
    if (!uid) return ctx.reply('请先发送 /start');

    try {
      const ws = await query(
        "SELECT id,address FROM wallets WHERE user_id=? AND wallet_type='monitor' AND is_active=1 ORDER BY id DESC LIMIT 20",
        [uid]
      );

      if (!ws.length) {
        return ctx.reply('你还没有启用的监控地址，请先点击“添加监控地址”。', {
          reply_markup: walletKeyboard()
        });
      }

      const kb = new InlineKeyboard();
      for (const w of ws) {
        kb.text('🔎 ' + w.address.slice(0, 8) + '…' + w.address.slice(-5),
          'wallet:resource:' + w.id).row();
      }
      kb.text('🏠 返回钱包管理', 'wallets');

      await ctx.reply(
        '🔎 请选择要查询的监听地址：\n\n查询内容包括 TRX 余额、账户资源，以及已记录的收款和付款交易。',
        { reply_markup: kb }
      );
    } catch (e) {
      console.error('[wallet:resources]', e.message);
      await ctx.reply('读取监控地址失败，请稍后重试。', { reply_markup: walletKeyboard() });
    }
  });

  // 资源详情：钱包 ID 必须属于当前用户
  bot.callbackQuery(/^wallet:resource:(\d+)$/, async ctx => {
    await ctx.answerCallbackQuery();
    const uid = await userIdFor(ctx.from.id);
    if (!uid) return ctx.reply('请先发送 /start');

    try {
      const rows = await query(
        "SELECT id,address FROM wallets WHERE id=? AND user_id=? AND wallet_type='monitor' AND is_active=1 LIMIT 1",
        [Number(ctx.match[1]), uid]
      );
      if (!rows.length) {
        return ctx.reply('地址不存在、已停用或不属于你的账户。', {
          reply_markup: walletKeyboard()
        });
      }

      const w = rows[0];
      const { getAccount, getTrc20Balance } = require('./tron');
      const [r, usdtBalance] = await Promise.all([
        getAccount(w.address),
        getTrc20Balance(w.address)
      ]);

      const pct = (used, limit) => {
        const u = Number(used) || 0;
        const l = Number(limit) || 0;
        return l > 0 ? Math.min(100, Math.round(u * 100 / l)) : 0;
      };
      const bar = n => {
        const filled = Math.round(n / 10);
        return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
      };
      const energyPct = pct(r.energyUsed, r.energyLimit);
      const netPct = pct(r.netUsed, r.netLimit);

      const kb = new InlineKeyboard()
        .text('📥 收款记录', 'wallet:history:in:' + w.id)
        .text('📤 付款记录', 'wallet:history:out:' + w.id).row()
        .text('🔄 刷新余额', 'wallet:resource:' + w.id)
        .text('🔎 其他地址', 'wallet:resources').row()
        .text('📜 全部历史记录', 'wallet:history').row()
        .text('🏠 返回主菜单', 'home');

      const fmtPct = (used, limit) => {
        const l = Number(limit);
        const u = Number(used);
        if (!Number.isFinite(l) || l <= 0 || !Number.isFinite(u) || u < 0) return '暂无数据';
        return Math.min(100, Math.round(u * 100 / l)) + '%';
      };
      const energyLabel = fmtPct(r.energyUsed, r.energyLimit);
      const netLabel = fmtPct(r.netUsed, r.netLimit);
      const energyBar = energyLabel === '暂无数据' ? '资源数据暂不可用' : bar(pct(r.energyUsed, r.energyLimit));
      const netBar = netLabel === '暂无数据' ? '资源数据暂不可用' : bar(pct(r.netUsed, r.netLimit));

      await ctx.reply(
        '🔎 <b>监听地址资源</b>\n' +
        '🟢 <b>查询状态：正常</b>\n' +
        '━━━━━━━━━━━━━━━━━━\n' +
        '📍 <b>监听地址</b>\n' +
        '<code>' + w.address + '</code>\n\n' +
        '💰 <b>资产余额</b>\n' +
        '🔴 TRX：<b>' + r.trx + ' TRX</b>\n' +
        '🟢 USDT (TRC20)：<b>' + usdtBalance + ' USDT</b>\n\n' +
        '📊 <b>账户资源</b>\n' +
        '⚡ Energy：' + resourceValue(r.energyUsed) + ' / ' + resourceValue(r.energyLimit) + '（' + energyLabel + '）\n' +
        energyBar + '\n' +
        '📶 Bandwidth：' + resourceValue(r.netUsed) + ' / ' + resourceValue(r.netLimit) + '（' + netLabel + '）\n' +
        netBar + '\n' +
        '🆓 免费 Bandwidth：' + resourceValue(r.freeNetUsed) + ' / ' + resourceValue(r.freeNetLimit) + '\n\n' +
        'ℹ️ 收款、付款记录仅包含本系统已记录的链上交易。事件源尚未推送的历史交易不会自动显示。',
        { parse_mode: 'HTML', reply_markup: kb }
      );
    } catch (e) {
      console.error('[wallet:resource detail]', e.message);
      await ctx.reply('查询失败，请检查 TRON API 配置或网络连接。', {
        reply_markup: walletKeyboard()
      });
    }
  });

  // 单地址交易记录：只读取当前用户自己的钱包记录
  bot.callbackQuery(/^wallet:history:(in|out):(\d+)$/, async ctx => {
    await ctx.answerCallbackQuery();
    const uid = await userIdFor(ctx.from.id);
    if (!uid) return ctx.reply('请先发送 /start');

    const direction = ctx.match[1];
    const walletId = Number(ctx.match[2]);

    try {
      const wallets = await query(
        "SELECT id,address FROM wallets WHERE id=? AND user_id=? AND wallet_type='monitor' AND is_active=1 LIMIT 1",
        [walletId, uid]
      );
      if (!wallets.length) {
        return ctx.reply('地址不存在、已停用或不属于你的账户。', {
          reply_markup: walletKeyboard()
        });
      }

      const address = wallets[0].address;
      const operator = direction === 'in' ? 'to_address' : 'from_address';
      const rows = await query(
        `SELECT tx_hash,token_contract,from_address,to_address,amount,block_timestamp,confirmed
         FROM transactions
         WHERE wallet_id=? AND ${operator}=?
         ORDER BY COALESCE(block_timestamp,0) DESC,id DESC LIMIT 10`,
        [walletId, address]
      );

      const body = rows.length
        ? rows.map((t, i) => {
            const token = t.token_contract === 'TRX_NATIVE'
              ? 'TRX'
              : (t.token_contract || '代币');
            const time = t.block_timestamp
              ? new Date(Number(t.block_timestamp)).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
              : '时间未知';
            const status = Number(t.confirmed) === 1 ? '已确认' : '待确认';
            return `${i + 1}. ${token} ${t.amount}\n` +
              `时间：${time}\n状态：${status}\n` +
              `${t.from_address.slice(0, 9)}… → ${t.to_address.slice(0, 9)}…\n` +
              `<code>${t.tx_hash}</code>`;
          }).join('\n\n')
        : '暂无此地址已记录的' + (direction === 'in' ? '收款' : '付款') +
          '交易。未被事件源推送或尚未写入数据库的历史交易不会出现在这里。';

      const kb = new InlineKeyboard()
        .text('📥 收款', 'wallet:history:in:' + walletId)
        .text('📤 付款', 'wallet:history:out:' + walletId).row()
        .text('🔙 地址详情', 'wallet:resource:' + walletId).row()
        .text('🏠 主菜单', 'home');

      await ctx.reply(
        (direction === 'in' ? '📥' : '📤') + ' <b>' +
        (direction === 'in' ? '收款记录' : '付款记录') +
        '（最近 10 笔）</b>\n\n地址：<code>' + address +
        '</code>\n\n' + body,
        { parse_mode: 'HTML', reply_markup: kb }
      );
    } catch (e) {
      console.error('[wallet:history]', e.message);
      await ctx.reply('读取交易记录失败，请稍后重试。', {
        reply_markup: walletKeyboard()
      });
    }
  });
  bot.callbackQuery('deposit', async ctx => {
    await ctx.answerCallbackQuery(); const uid = await userIdFor(ctx.from.id); if (!uid) return ctx.reply('请先发送 /start');
    let rows = await query("SELECT address FROM wallets WHERE user_id=? AND wallet_type='deposit' AND is_active=1 LIMIT 1", [uid]);
    if (!rows.length) { try { const assigned = await assignNextDepositAddress(uid); if (assigned.reason === 'pool_empty') return ctx.reply('当前暂无可分配充值地址，请联系管理员。请勿向其他地址转账。', { reply_markup: homeKeyboard() }); rows = [{ address: assigned.address }]; } catch (e) { return ctx.reply('暂时无法分配充值地址，请联系管理员。', { reply_markup: homeKeyboard() }); } }
    await ctx.reply(`📥 <b>你的专属充值地址</b>\n\n<code>${rows[0].address}</code>\n\n网络：TRON 主网\n币种：USDT-TRC20\n\n⚠️ 只发送指定合约的 USDT。到账后进入链上核验和审核流程。`, { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🧾 交易记录', 'transactions').row().text('🏠 主菜单', 'home') });
  });
  bot.callbackQuery('withdraw', async ctx => { pendingInput.set(ctx.from.id, 'withdraw'); await ctx.answerCallbackQuery(); await ctx.reply('📤 <b>提现申请</b>\n\n请按以下格式发送：金额 空格 收款TRON地址\n例如：<code>10 Txxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx</code>\n\n申请将进入管理员审核，不会立即链上转账。', { parse_mode: 'HTML', reply_markup: cancelKeyboard() }); });
  bot.callbackQuery('transactions', async ctx => {
    await ctx.answerCallbackQuery(); const uid = await userIdFor(ctx.from.id); if (!uid) return ctx.reply('请先发送 /start');
    const rows = await query(`SELECT t.tx_hash,t.event_index,t.token_contract,t.from_address,t.to_address,t.amount,t.block_timestamp,w.address FROM transactions t JOIN wallets w ON w.id=t.wallet_id WHERE w.user_id=? ORDER BY t.id DESC LIMIT 10`, [uid]);
    const body = rows.length ? rows.map((t,i) => `${i+1}. ${t.token_contract === 'TRX_NATIVE' ? 'TRX' : 'USDT-TRC20'} ${t.amount}\n${t.from_address.slice(0,9)}… → ${t.to_address.slice(0,9)}…\n<code>${t.tx_hash}</code>`).join('\n\n') : '暂无已识别交易。事件源未配置或未推送时，这里不会自动出现新交易。';
    await ctx.reply('🧾 <b>最近交易（最多10笔）</b>\n\n' + body, { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🔄 刷新', 'transactions').row().text('🏠 主菜单', 'home') });
  });
  bot.callbackQuery('status', async ctx => {
    await ctx.answerCallbackQuery(); const uid = await userIdFor(ctx.from.id); if (!uid) return ctx.reply('请先发送 /start');
    const [w] = await query('SELECT COUNT(*) count, MAX(last_scanned_at) last_scan FROM wallets WHERE user_id=? AND is_active=1', [uid]);
    const [tx] = await query('SELECT COUNT(*) count FROM transactions WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id=?) AND created_at >= NOW() - INTERVAL 24 HOUR', [uid]);
    await ctx.reply(`📡 <b>监听状态</b>\n\n启用地址：${w.count}\n最近扫描/事件时间：${w.last_scan || '暂无记录'}\n近24小时交易记录：${tx.count}\n\n实时发现依赖管理员配置的第三方 TRON 事件推送服务。`, { parse_mode: 'HTML', reply_markup: homeKeyboard() });
  });
  bot.callbackQuery('report', async ctx => { await ctx.answerCallbackQuery(); const uid = await userIdFor(ctx.from.id); if (!uid) return ctx.reply('请先发送 /start'); const [w] = await query('SELECT COUNT(*) c FROM wallets WHERE user_id=? AND is_active=1', [uid]); const [t] = await query("SELECT COUNT(*) c, COALESCE(SUM(CASE WHEN token_contract='TRX_NATIVE' THEN amount ELSE 0 END),0) trx_total, COALESCE(SUM(CASE WHEN token_contract<>'TRX_NATIVE' THEN amount ELSE 0 END),0) usdt_total FROM transactions WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id=?) AND block_timestamp >= UNIX_TIMESTAMP(UTC_DATE())*1000 AND block_timestamp < UNIX_TIMESTAMP(UTC_DATE() + INTERVAL 1 DAY)*1000", [uid]); await ctx.reply(`📊 <b>今日简报（UTC）</b>\n\n监控地址：${w.c}\n识别交易事件：${t.c}\nTRX 转账合计：${t.trx_total} TRX\nUSDT 转账合计：${t.usdt_total} USDT\n\n注：统计为收/转方向累计。`, { parse_mode: 'HTML', reply_markup: homeKeyboard() }); });
  bot.callbackQuery('referral', async ctx => { await ctx.answerCallbackQuery(); const rows = await query('SELECT id,referral_code FROM users WHERE telegram_id=?', [ctx.from.id]); if (!rows.length) return ctx.reply('请先发送 /start'); const botName = (await bot.api.getMe()).username; const [stats] = await query('SELECT COUNT(*) c FROM users WHERE referred_by=?', [rows[0].id]); await ctx.reply(`🎁 <b>邀请好友</b>\n\n已邀请：${stats.c} 人\n返佣比例：${process.env.REFERRAL_COMMISSION_PERCENT || 3}%（以系统规则为准）\n\n你的专属链接：\n<code>https://t.me/${botName}?start=${rows[0].referral_code}</code>`, { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🏠 主菜单', 'home') }); });
  bot.callbackQuery('energy', async ctx => { await ctx.answerCallbackQuery(); await ctx.reply('⚡ <b>能量服务</b>\n\n真实能量供应商尚未接入，因此目前不能报价、扣款或声称委托成功。供应商接入后此处将提供能量报价、时长选择、确认订单和订单状态。', { parse_mode: 'HTML', reply_markup: homeKeyboard() }); });

  // Text-based guided flows started by inline buttons.
  bot.on('message:text', async ctx => {
    const text = String(ctx.message.text || '').trim();
    if (text.startsWith('/')) return;
    const action = pendingInput.get(ctx.from.id); if (!action) return;

    // 输入无效时保留等待状态，允许用户直接重试。
    if (action === 'addwallet' && !validateAddress(text)) {
      return ctx.reply(
        '地址格式不正确，请重新发送 T 开头的有效 TRON 主网地址。\n也可以点击“取消操作”。',
        { reply_markup: cancelKeyboard() }
      );
    }

    pendingInput.delete(ctx.from.id);
    if (action === 'addwallet') {
      const uid = await userIdFor(ctx.from.id);
      if (!uid) return ctx.reply('请先发送 /start');
      try {
        await query(
          "INSERT INTO wallets (user_id,address,wallet_type,label) VALUES (?,?, 'monitor','用户监控')",
          [uid, text]
        );
        await ctx.reply('✅ 已添加到你的只读监控地址。', {
          reply_markup: walletKeyboard()
        });
      } catch (e) {
        await ctx.reply(
          e.code === 'ER_DUP_ENTRY' ? '该地址已存在，请勿重复添加。' : '添加失败，请稍后重试。',
          { reply_markup: walletKeyboard() }
        );
      }
    } else if (action === 'resources') {
      if (!validateAddress(text)) return ctx.reply('地址格式不正确，请使用 T 开头的 TRON 地址。', { reply_markup: walletKeyboard() });
      try {
        const r = await getAccount(text);
        await ctx.reply(
          `🔎 <b>账户资源</b>\n地址：<code>${r.address}</code>\n` +
          `TRX：${r.trx}\n` +
          `Energy：${resourceValue(r.energyUsed)}/${resourceValue(r.energyLimit)}\n` +
          `Bandwidth：${resourceValue(r.netUsed)}/${resourceValue(r.netLimit)}\n` +
          `免费 Bandwidth：${resourceValue(r.freeNetUsed)}/${resourceValue(r.freeNetLimit)}`,
          { parse_mode: 'HTML', reply_markup: walletKeyboard() }
        );
      }
      catch (e) { await ctx.reply('暂时无法查询资源，请稍后重试并检查 TRON API 配置。', { reply_markup: walletKeyboard() }); }
    } else if (action === 'withdraw') {
      const parts = text.split(/\s+/); if (parts.length !== 2) return ctx.reply('格式不正确，请重新点击“提现申请”并发送：金额 收款TRON地址', { reply_markup: menu });
      const [amount, destination] = parts;
      if (!validateAddress(destination)) return ctx.reply('收款地址无效，请重新发起提现申请。', { reply_markup: menu });
      const { validateWithdrawalAmount, validatePendingCount, validateDailyTotal } = require('./withdrawalPolicy');
      try { validateWithdrawalAmount(amount); } catch (e) { return ctx.reply(e.message, { reply_markup: menu }); }
      const { pool } = require('./db'); const conn = await pool.getConnection(); let result;
      try {
        await conn.beginTransaction(); const [users] = await conn.execute('SELECT id,balance FROM users WHERE telegram_id=? FOR UPDATE', [ctx.from.id]);
        if (!users.length) { await conn.rollback(); return ctx.reply('请先发送 /start'); }
        const uid = users[0].id; const [pending] = await conn.execute("SELECT COUNT(*) count FROM withdrawal_requests WHERE user_id=? AND status IN ('pending','approved')", [uid]); validatePendingCount(pending[0].count);
        const [daily] = await conn.execute("SELECT CAST(COALESCE(SUM(amount),0) AS CHAR) total FROM withdrawal_requests WHERE user_id=? AND created_at >= UTC_DATE() AND created_at < DATE_ADD(UTC_DATE(), INTERVAL 1 DAY) AND status IN ('pending','approved','paid')", [uid]); validateDailyTotal(daily[0].total || '0', amount);
        [result] = await conn.execute("INSERT INTO withdrawal_requests (user_id,amount,currency,destination_address,status) VALUES (?,?, 'USDT',?,'pending')", [uid, amount, destination]); await conn.commit();
      } catch (e) { await conn.rollback(); return ctx.reply(e.message || '提现申请失败，请稍后重试。', { reply_markup: menu }); } finally { conn.release(); }
      await ctx.reply(`✅ 提现申请已提交\n编号：#${result.insertId}\n金额：${amount} USDT\n收款地址：${destination}\n状态：待管理员审核。`, { reply_markup: homeKeyboard() });
    }
  });

  bot.catch(err => console.error('[bot] error:', err.message));
  return bot;
}

module.exports = { createBot };