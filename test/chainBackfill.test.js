const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDateRange } = require('../src/dateRange');

test('accepts a valid bounded UTC date range', () => {
  const r = parseDateRange('2026-10-01', '2026-10-07');
  assert.equal(r.fromMs, Date.parse('2026-10-01T00:00:00Z'));
  assert.equal(r.toMs, Date.parse('2026-10-07T23:59:59.999Z'));
});
test('rejects impossible calendar dates', () => {
  assert.throws(() => parseDateRange('2026-02-30', '2026-03-01'), /有效/);
});
test('rejects reversed ranges', () => {
  assert.throws(() => parseDateRange('2026-10-08', '2026-10-07'), /不能早于/);
});
test('limits a backfill request to 31 days', () => {
  assert.throws(() => parseDateRange('2026-08-01', '2026-09-10'), /最多 31 天/);
});
