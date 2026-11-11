'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function read(path) {
  return fs.readFileSync(new URL('../' + path, `file://${__filename}`).pathname, 'utf8');
}

test('application systemd unit drops unnecessary kernel/device access and restricts address families', () => {
  const unit = read('deploy/tron-energy.service');
  for (const directive of [
    'NoNewPrivileges=true',
    'PrivateTmp=true',
    'PrivateDevices=true',
    'ProtectSystem=full',
    'ProtectHome=true',
    'ProtectKernelTunables=true',
    'ProtectKernelModules=true',
    'ProtectControlGroups=true',
    'RestrictSUIDSGID=true',
    'LockPersonality=true',
    'SystemCallArchitectures=native',
    'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
    'UMask=0077'
  ]) assert.ok(unit.includes(directive), 'missing service hardening directive: ' + directive);
});

test('operational monitor runs in a strict systemd sandbox with a private state directory', () => {
  const unit = read('deploy/systemd/tron-energy-ops-monitor.service');
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^StateDirectory=tron-energy-bot$/m);
  assert.match(unit, /^StateDirectoryMode=0700$/m);
  assert.match(unit, /^NoNewPrivileges=true$/m);
  assert.match(unit, /^PrivateDevices=true$/m);
  assert.match(unit, /^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6$/m);
});

test('production backup can fail closed when offsite replication is required', () => {
  const script = read('scripts/backup.sh');
  assert.match(script, /REQUIRE_OFFSITE_BACKUP=\$\{REQUIRE_OFFSITE_BACKUP:-false\}/);
  assert.match(script, /REQUIRE_OFFSITE_BACKUP.*true.*RCLONE_REMOTE/s);
  assert.match(script, /RCLONE_PATH.*\^\[A-Za-z0-9\._\/-\]\+\$/);
  assert.match(script, /rclone copy/);
  assert.match(script, /rclone check/);
});

test('operations monitor detects missing or checksum-corrupted encrypted backups', () => {
  const script = read('scripts/ops-monitor.sh');
  for (const artifact of [
    'MANIFEST.txt',
    'SHA256SUMS',
    'database.sql.gz.age',
    'app-config.tar.gz.age',
    'environment.env.age'
  ]) assert.ok(script.includes(artifact), 'monitor must check ' + artifact);
  assert.match(script, /sha256sum -c SHA256SUMS/);
  assert.match(script, /最新备份加密文件校验失败/);
});

test('operations monitor validates numeric thresholds before arithmetic', () => {
  const script = read('scripts/ops-monitor.sh');
  assert.match(script, /BACKUP_MAX_AGE_HOURS must be 1\.\.9999/);
  assert.match(script, /DISK_WARN_PERCENT must be 1\.\.100/);
});
