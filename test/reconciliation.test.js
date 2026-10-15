const test = require('node:test');
const assert = require('node:assert/strict');
const { csvCell, toCsv, isIsoDate, validDateRange } = require('../src/reconciliation');

test('CSV escapes commas, quotes and newlines', () => {
  assert.equal(csvCell('a,"b"\nc'), '"a,""b""\nc"');
});

test('CSV guards spreadsheet formula injection', () => {
  assert.equal(csvCell('=1+1'), '"\'=1+1"');
  assert.equal(csvCell('  @SUM(A1:A2)'), '"\'  @SUM(A1:A2)"');
});

test('ISO date validation rejects impossible dates', () => {
  assert.equal(isIsoDate('2026-10-15'), true);
  assert.equal(isIsoDate('2026-02-30'), false);
  assert.equal(isIsoDate('15-10-2026'), false);
});

test('date range is bounded and ordered', () => {
  assert.equal(validDateRange('2026-10-01', '2026-10-15'), true);
  assert.equal(validDateRange('2026-10-15', '2026-10-01'), false);
  assert.equal(validDateRange('2026-01-01', '2026-06-01'), false);
});
