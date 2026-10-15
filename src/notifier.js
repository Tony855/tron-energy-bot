async function sendTelegramMessage(telegramId, text) {
  const token = process.env.BOT_TOKEN;
  if (!token || !telegramId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: telegramId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('[notify] Telegram API failed:', res.status, body.slice(0, 300));
      return false;
    }
    return true;
  } catch (e) {
    console.error('[notify] Telegram request failed:', e.message);
    return false;
  }
}

module.exports = { sendTelegramMessage };
