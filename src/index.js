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
    const { t, SUPPORTED } = require('./i18n');
    const CMD_LIST = ['start','balance','wallets','addwallet','deposit','withdraw','transactions','status','report','referral','help','language'];
    // Telegram 只接受 ISO 639-1 小写代码（zh、en）；内部标识 zh-CN 需映射
    const TG_LANG = { 'zh-CN': 'zh', 'en': 'en' };
    const buildCommands = (lang) => CMD_LIST.map(c => ({ command: c, description: t(lang, 'cmd.' + c) }));
    for (const lang of SUPPORTED) {
      const tg = TG_LANG[lang];
      if (!tg) { console.warn(`[bot] no Telegram language code for ${lang}, skip`); continue; }
      try {
        await bot.api.setMyCommands(buildCommands(lang), { language_code: tg });
        console.log(`[bot] setMyCommands(${tg}) ok`);
      } catch (e) {
        console.error(`[bot] setMyCommands(${tg}) failed:`, e.message);
      }
    }
    console.log('[bot] starting polling...');
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