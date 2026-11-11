'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const worker = fs.readFileSync(path.join(root, 'src/worker.js'), 'utf8');
const web = fs.readFileSync(path.join(root, 'src/web.js'), 'utf8');
const auditStart = web.indexOf("app.get('/api/chain-audit'");
const auditEnd = web.indexOf("\n});", auditStart);
const chainAudit = web.slice(auditStart, auditEnd);

test('TRON Base58 wallet lookup is binary under case-insensitive MariaDB collations', () => {
  assert.match(worker, /BINARY address IN \(BINARY \?,BINARY \?\)/);
  assert.doesNotMatch(worker, /LOWER\(address\)/);
});

test('chain audit compares Base58 addresses with binary SQL semantics', () => {
  assert.match(chainAudit, /BINARY t\.to_address=BINARY w\.address/);
  assert.doesNotMatch(chainAudit, /LOWER\(t\.to_address\)/);
  assert.doesNotMatch(chainAudit, /LOWER\(w\.address\)/);
});

test('chain audit exposes incomplete result sets instead of silently truncating at 500', () => {
  assert.equal((chainAudit.match(/LIMIT 501/g) || []).length, 3);
  assert.match(chainAudit, /missing\.length > 500/);
  assert.match(chainAudit, /mismatch\.length > 500/);
  assert.match(chainAudit, /orphaned\.length > 500/);
  assert.match(chainAudit, /complete: !Object\.values\(truncated\)\.some\(Boolean\)/);
  assert.match(chainAudit, /slice\(0, 500\)/);
});
