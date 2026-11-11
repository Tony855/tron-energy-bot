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


test('backfill lock is released exactly once after a successful acquisition', async () => {
  const calls = [];
  let releases = 0;
  const pool = { async getConnection() { return {
    async execute(sql, params) { calls.push({ sql, params }); return [[{ acquired: 1 }]]; },
    release() { releases += 1; }
  }; } };
  const { acquireBackfillLock } = require('../src/chainBackfill');
  const release = await acquireBackfillLock(17, 1000, 2000, pool);
  assert.equal(typeof release, 'function');
  assert.match(calls[0].sql, /GET_LOCK/);
  assert.ok(calls[0].params[0].length <= 64);
  await release();
  await release();
  assert.equal(releases, 1);
  assert.match(calls[1].sql, /RELEASE_LOCK/);
  assert.equal(calls[0].params[0], calls[1].params[0]);
});

test('backfill lock contention releases the connection and returns no lock', async () => {
  let releases = 0;
  const pool = { async getConnection() { return {
    async execute() { return [[{ acquired: 0 }]]; },
    release() { releases += 1; }
  }; } };
  const { acquireBackfillLock } = require('../src/chainBackfill');
  assert.equal(await acquireBackfillLock(17, 1000, 2000, pool), null);
  assert.equal(releases, 1);
});

test('backfill lock scopes are stable per wallet and date range', async () => {
  const names = [];
  const pool = { async getConnection() { return {
    async execute(_sql, params) { names.push(params[0]); return [[{ acquired: 0 }]]; },
    release() {}
  }; } };
  const { acquireBackfillLock } = require('../src/chainBackfill');
  await acquireBackfillLock(17, 1000, 2000, pool);
  await acquireBackfillLock(17, 1000, 2000, pool);
  await acquireBackfillLock(18, 1000, 2000, pool);
  assert.equal(names[0], names[1]);
  assert.notEqual(names[0], names[2]);
});
