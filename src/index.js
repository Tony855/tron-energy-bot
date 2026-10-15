require('dotenv').config();
const app = require('./web');
const { createBot } = require('./bot');
const { initSocket } = require('./eventBridge');

async function main() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET 必须设置为至少 32 个字符的随机值');
  }
  if (!process.env.DB_USER || !process.env.DB_PASSWORD) {
    throw new Error('请配置 DB_USER 和 DB_PASSWORD');
  }
  const port = Number(process.env.PORT || 3080);
  const server = app.listen(port, process.env.HOST || '127.0.0.1', () => {
    console.log(`[web] listening on ${process.env.HOST || '127.0.0.1'}:${port}`);
  });
  initSocket(server);
  const bot = createBot();
  if (bot) {
    await bot.api.setMyCommands([
      { command: 'start', description: '打开主菜单' },
      { command: 'balance', description: '查看可用余额' },
      { command: 'wallets', description: '管理监控地址' },
      { command: 'addwallet', description: '添加只读监控地址' },
      { command: 'deposit', description: '获取专属充值地址' },
      { command: 'withdraw', description: '提交提现申请' },
      { command: 'transactions', description: '查看最近交易' },
      { command: 'status', description: '查看监听状态' },
      { command: 'report', description: '查看今日简报' },
      { command: 'referral', description: '邀请好友' },
      { command: 'help', description: '查看使用帮助' }
    ]);
    await bot.start();
    console.log('[bot] Telegram bot started');
  }
  // No periodic chain scanner in event-only mode. Provider webhook is required.
  console.log('[events] waiting for authenticated provider webhooks; no TronGrid polling');
  // Chain alerts remain available as an on-demand admin action, not a timer.
}
main().catch(err => { console.error(err); process.exit(1); });

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));