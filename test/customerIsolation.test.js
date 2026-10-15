const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'sql/schema.sql'), 'utf8');
const bot = fs.readFileSync(path.join(root, 'src/bot.js'), 'utf8');
const eventBridge = fs.readFileSync(path.join(root, 'src/eventBridge.js'), 'utf8');

test('wallet address uniqueness is scoped to a customer, not global', () => {
  assert.match(schema, /UNIQUE KEY uq_wallet_user_address \(user_id, address\)/);
  assert.doesNotMatch(schema, /UNIQUE KEY uq_wallet_address \(address\)/);
});

test('recharge order cannot point at another customer wallet', () => {
  assert.match(schema, /FOREIGN KEY \(wallet_id, user_id\) REFERENCES wallets\(id, user_id\)/);
});

test('customer wallet and transaction commands scope by authenticated Telegram identity', () => {
  assert.match(bot, /SELECT id FROM users WHERE telegram_id=\?'/);
  assert.match(bot, /UPDATE wallets SET is_active=0 WHERE user_id=\? AND address=\?/);
  assert.match(bot, /JOIN wallets w ON w\.id=t\.wallet_id WHERE w\.user_id=\?/);
});

test('chain events are attached only to wallets matching the observed public addresses', () => {
  assert.match(eventBridge, /FROM wallets WHERE is_active=1 AND \(LOWER\(address\)=\? OR LOWER\(address\)=\?\)/);
  assert.match(eventBridge, /saveTransfer\(wallet, record, 'trc20'\)/);
});
