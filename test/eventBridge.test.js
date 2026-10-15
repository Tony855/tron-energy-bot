const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { signatureValid } = require('../src/eventSignature');
test('signed webhook HMAC checks raw bytes and rejects tampering', () => {
  const secret = 'secret';
  const raw = Buffer.from('{"network":"mainnet","txHash":"test"}');
  const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  assert.equal(signatureValid(raw, signature, secret), true);
  assert.equal(signatureValid(Buffer.from('tampered'), signature, secret), false);
  assert.equal(signatureValid(raw, 'sha256=xyz', secret), false);
  assert.equal(signatureValid(raw, signature, ''), false);
});
