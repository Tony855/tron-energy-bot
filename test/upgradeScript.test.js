'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const script = fs.readFileSync(new URL('../upgrade-v3.4.sh', `file://${__filename}`).pathname, 'utf8');

test('upgrade applies and verifies V4 migration before stopping or swapping the live release', () => {
  const migration = script.indexOf('node scripts/apply-v4-migration.js');
  const stop = script.indexOf('systemctl stop "$SERVICE_NAME"');
  const swap = script.indexOf('mv "$APP_DIR" "$PREVIOUS"');
  assert.ok(migration >= 0, 'V4 migration must be present');
  assert.ok(stop > migration, 'service stop must occur after V4 migration');
  assert.ok(swap > stop, 'release swap must occur after service stop');
});

test('upgrade requires an encrypted backup and integrity verification before migration', () => {
  const backup = script.indexOf('./scripts/backup.sh');
  const verify = script.indexOf('./scripts/verify-backup.sh "$LATEST"');
  const migration = script.indexOf('node scripts/apply-v4-migration.js');
  assert.ok(backup >= 0 && verify > backup && migration > verify);
});

test('upgrade retains previous release and never attempts destructive database rollback', () => {
  assert.match(script, /Previous release retained/);
  assert.doesNotMatch(script, /DROP DATABASE|DROP TABLE|MODIFY COLUMN status ENUM\('pending_provider','processing'/);
});
