'use strict';

const SUPPORTED = Object.freeze(['zh-CN', 'en']);
const DEFAULT_LANG = 'zh-CN';

const LOCALES = {
  'zh-CN': require('./locales/zh-CN'),
  'en':    require('./locales/en'),
};

// 把 Telegram 的 language_code（如 'zh-hans'、'zh'、'en-US'）映射到受支持语言
function normalizeLang(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s === 'zh-cn' || s === 'zh-hans' || s === 'zh-hant' || s === 'zh') return 'zh-CN';
  if (s.startsWith('zh-')) return 'zh-CN';
  if (s === 'en' || s.startsWith('en-')) return 'en';
  return null;
}

function resolveLang({ dbLang, telegramLang } = {}) {
  return normalizeLang(dbLang)
      || normalizeLang(telegramLang)
      || DEFAULT_LANG;
}

function t(lang, key, params) {
  const table = LOCALES[lang] || LOCALES[DEFAULT_LANG];
  let text = table[key];
  if (text == null) {
    // 未翻译时回退到中文；再没有就返回 key，便于暴露漏翻
    text = LOCALES[DEFAULT_LANG][key] ?? key;
  }
  if (params && typeof text === 'string') {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll('{' + k + '}', String(v));
    }
  }
  return text;
}

// 从 ctx 里解析当前语言
async function langOf(ctx, query) {
  const tg = ctx?.from?.language_code || null;
  let dbLang = null;
  if (ctx?.from?.id && query) {
    try {
      const rows = await query('SELECT language FROM users WHERE telegram_id=? LIMIT 1', [ctx.from.id]);
      dbLang = rows[0]?.language || null;
    } catch {}
  }
  return resolveLang({ dbLang, telegramLang: tg });
}

module.exports = { SUPPORTED, DEFAULT_LANG, LOCALES, normalizeLang, resolveLang, t, langOf };
