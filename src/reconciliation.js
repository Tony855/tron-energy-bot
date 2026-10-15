function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  // Prevent spreadsheet formula injection while keeping a valid CSV.
  const safe = /^[\s]*[=+\-@]/.test(s) ? "'" + s : s;
  return '"' + safe.replace(/"/g, '""') + '"';
}

function toCsv(rows, columns) {
  const header = columns.map(c => csvCell(c.label)).join(',');
  const body = rows.map(row => columns.map(c => csvCell(row[c.key])).join(','));
  return [header, ...body].join('\r\n') + '\r\n';
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function validDateRange(from, to, maxDays = 93) {
  if (!isIsoDate(from) || !isIsoDate(to)) return false;
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const span = (end - start) / 86400000;
  return span >= 0 && span <= maxDays;
}

module.exports = { csvCell, toCsv, isIsoDate, validDateRange };
