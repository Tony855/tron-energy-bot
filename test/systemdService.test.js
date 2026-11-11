'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('systemd service restarts the application and applies baseline process hardening', () => {
  const unit = fs.readFileSync(new URL('../deploy/tron-energy.service', `file://${__filename}`).pathname, 'utf8');
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^RestartSec=5$/m);
  assert.match(unit, /^NoNewPrivileges=true$/m);
  assert.match(unit, /^PrivateTmp=true$/m);
  assert.match(unit, /^ProtectSystem=full$/m);
  assert.match(unit, /^ProtectHome=true$/m);
  assert.match(unit, /^ReadWritePaths=\/opt\/tron-energy-bot$/m);
});
