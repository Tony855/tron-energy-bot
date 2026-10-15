'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { keyFor } = require('../src/sharedLoginGuard');

test('login limiter key is stable for the same IP and case-insensitive username', () => {
  assert.equal(keyFor('127.0.0.1', 'Admin'), keyFor('127.0.0.1', 'admin'));
});
test('login limiter key changes with IP or username and does not expose raw identity', () => {
  const a = keyFor('127.0.0.1', 'admin');
  assert.notEqual(a, keyFor('127.0.0.2', 'admin'));
  assert.notEqual(a, keyFor('127.0.0.1', 'other'));
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.equal(a.includes('127.0.0.1'), false);
  assert.equal(a.includes('admin'), false);
});
