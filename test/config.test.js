'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, positiveInteger } = require('../src/config');

const validEnv = {
  JWT_SECRET: 'x'.repeat(32),
  DB_USER: 'bot',
  DB_PASSWORD: 'secret'
};

test('loadConfig applies safe defaults and freezes the result', () => {
  const config = loadConfig(validEnv);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3080);\n  assert.equal(config.dbPort, 3306);
  assert.equal(config.shutdownTimeoutMs, 15000);
  assert.equal(Object.isFrozen(config), true);
});

test('loadConfig rejects missing security and database configuration', () => {
  assert.throws(() => loadConfig({ ...validEnv, JWT_SECRET: 'short' }), /JWT_SECRET/);
  assert.throws(() => loadConfig({ ...validEnv, DB_USER: '' }), /DB_USER/);
  assert.throws(() => loadConfig({ ...validEnv, DB_PASSWORD: '' }), /DB_USER/);
});

test('loadConfig rejects invalid network and shutdown values', () => {
  assert.throws(() => loadConfig({ ...validEnv, PORT: '0' }), /PORT/);
  assert.throws(() => loadConfig({ ...validEnv, PORT: '65536' }), /PORT/);\n  assert.throws(() => loadConfig({ ...validEnv, DB_PORT: '70000' }), /DB_PORT/);
  assert.throws(() => loadConfig({ ...validEnv, SHUTDOWN_TIMEOUT_MS: '-1' }), /SHUTDOWN_TIMEOUT_MS/);
  assert.equal(positiveInteger('42', 1, 'VALUE', 100), 42);
});
