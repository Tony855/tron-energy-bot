const crypto = require('node:crypto');
function signatureValid(raw, header, secret) {
  if (!secret || !Buffer.isBuffer(raw) || !/^sha256=[a-f0-9]{64}$/i.test(String(header || ''))) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(String(header).slice(7), 'hex'));
}
module.exports = { signatureValid };
