const crypto = require('node:crypto');
function adminChats(value = process.env.ADMIN_TELEGRAM_IDS || '') {
  return [...new Set(String(value).split(',').map(x => x.trim()).filter(x => /^-?\d+$/.test(x)))];
}
function fingerprint(kind, row) {
  return crypto.createHash('sha256').update([kind, row.tx_hash || '', row.event_index ?? '', row.wallet_id ?? '', row.recharge_order_id ?? ''].join(':')).digest('hex');
}
module.exports = { adminChats, fingerprint };
