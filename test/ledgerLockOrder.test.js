const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../src/ledger.js'), 'utf8');

// 这些 SQL 在 ledger.js 里都是唯一的，直接在整文件上找位置即可。
// 顺序断言：lock(user) < lock(idempotency) < update(user) < insert(ledger)
const pos = {
  lockUser:     src.indexOf('SELECT id,balance FROM users WHERE id=? FOR UPDATE'),
  lockIdem:     src.indexOf('FROM ledger_entries WHERE idempotency_key=? FOR UPDATE'),
  updateUser:   src.search(/UPDATE users SET balance=/),
  insertLedger: src.indexOf('INSERT INTO ledger_entries'),
};

test('四个关键 SQL 都能在 ledger.js 中找到', () => {
  for (const [name, i] of Object.entries(pos)) {
    assert.ok(i > -1, `缺少 ${name}`);
  }
});

test('锁用户行必须在余额变更与账本插入之前', () => {
  assert.ok(pos.lockUser < pos.updateUser, '锁用户行必须在 UPDATE users SET balance 之前');
  assert.ok(pos.lockUser < pos.insertLedger, '锁用户行必须在 INSERT INTO ledger_entries 之前');
});

test('幂等键锁定必须在余额变更之前', () => {
  assert.ok(pos.lockIdem < pos.updateUser, '幂等键锁定必须在 UPDATE users SET balance 之前');
});

test('幂等键锁定必须在账本插入之前', () => {
  assert.ok(pos.lockIdem < pos.insertLedger, '幂等键锁定必须在 INSERT INTO ledger_entries 之前');
});

test('幂等键锁定必须在锁用户行之后（避免死锁）', () => {
  assert.ok(pos.lockUser < pos.lockIdem, '按固定顺序加锁：先 users，后 ledger_entries');
});

test('entryType / referenceType 白名单存在', () => {
  assert.match(src, /const VALID_ENTRY_TYPES = new Set\(/);
  assert.match(src, /const VALID_REFERENCE_TYPES = new Set\(/);
  assert.match(src, /if \(!VALID_ENTRY_TYPES\.has\(entryType\)\)/);
  assert.match(src, /if \(!VALID_REFERENCE_TYPES\.has\(referenceType\)\)/);
});
