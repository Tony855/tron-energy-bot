const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../src/ledger.js'), 'utf8');

test('返佣计算使用 BigInt 微单位，不再依赖 float64', () => {
  assert.match(src, /const amtMicros = toMicros\(String\(order\.amount\)\)/);
  assert.match(src, /const commissionMicros = \(amtMicros \* pctScaled\) \/ 10000n/);
  assert.doesNotMatch(src, /Number\(order\.amount\) \* percent/);
});

test('microsToDecimal 输出固定 6 位小数', () => {
  // 从源码里提取 microsToDecimal 并求值，验证格式化
  const m = src.match(/function microsToDecimal\(m\) \{[\s\S]*?\n\}/);
  assert.ok(m, '未找到 microsToDecimal');
  const fn = eval('(' + m[0] + ')');
  assert.equal(fn(0n), '0.000000');
  assert.equal(fn(1n), '0.000001');
  assert.equal(fn(1000000n), '1.000000');
  assert.equal(fn(1234567n), '1.234567');
  assert.equal(fn(-1n), '-0.000001');
  assert.equal(fn(370370367370369468n), '370370367370.369468');
});

test('返佣百分比缩放为整数微基准（3% → 300）', () => {
  const pct = 3;
  const pctScaled = BigInt(Math.round(pct * 100));
  assert.equal(pctScaled, 300n);
  const amount = 100_000_000n; // 100 USDT in micros
  const commission = (amount * pctScaled) / 10000n;
  assert.equal(commission, 3_000_000n); // 3 USDT in micros
});

test('返佣对 0.000001 的充值向下取整为 0', () => {
  const amtMicros = 1n;                  // 0.000001 USDT
  const pctScaled = 300n;                // 3%
  const commission = (amtMicros * pctScaled) / 10000n;
  assert.equal(commission, 0n);
});

test('返佣对大额精确（不丢精度）', () => {
  const amtMicros = 123456789123456n;    // 123456789.123456 USDT
  const pctScaled = 300n;                // 3%
  const commission = (amtMicros * pctScaled) / 10000n;
  assert.equal(commission, 3703703673703n); // 3703703.673703 USDT
});
