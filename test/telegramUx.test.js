const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bot = fs.readFileSync(path.join(__dirname, '../src/bot.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
const normalize = s => String(s).replace(/\s+/g, ' ');

test('Telegram home menu exposes key customer actions as inline buttons', () => {
  for (const key of ['wallets', 'energy', 'balance', 'deposit', 'withdraw', 'transactions', 'status', 'report', 'referral', 'help']) {
    assert.ok(bot.includes(`'${key}'`), `missing callback ${key}`);
  }
  assert.match(bot, /const walletMenu\s*=\s*\(\)/);
  assert.match(bot, /const cancelMenu\s*=\s*\(\)/);
  assert.match(bot, /const homeMenu\s*=\s*\(\)/);
});

test('guided address and withdrawal inputs are scoped to Telegram user', () => {
  const b = normalize(bot);
  assert.match(b, /pendingInput\.set\(ctx\.from\.id, 'addwallet'\)/);
  assert.match(b, /pendingInput\.set\(ctx\.from\.id, 'withdraw'\)/);
  assert.match(b, /WHERE user_id=\? AND address=\?/);
  assert.match(b, /WHERE id=\? AND user_id=\? AND wallet_type='monitor'/);
});

test('menu callbacks do not fake invoking slash commands as bot messages', () => {
  assert.doesNotMatch(bot, /sendMessage\(ctx\.chat\.id, '\/(deposit|report|referral)'\)/);
});

test('Telegram command menu is registered at startup', () => {
  assert.match(index, /setMyCommands/);
  assert.match(index, /description: '打开主菜单'/);
});
