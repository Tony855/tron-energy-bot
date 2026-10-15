const test = require('node:test');
const assert = require('node:assert/strict');
const { createLoginGuard } = require('../src/loginGuard');

test('login guard permits attempts until configured threshold', () => {
  let now = 1000;
  const g = createLoginGuard({ maxAttempts: 3, windowMs: 10000, lockMs: 5000, now: () => now });
  assert.equal(g.check('ip', 'admin').allowed, true);
  g.fail('ip', 'admin'); g.fail('ip', 'admin');
  assert.equal(g.check('ip', 'admin').allowed, true);
  const result = g.fail('ip', 'admin');
  assert.equal(result.allowed, false);
  assert.equal(result.retryAfterMs, 5000);
});

test('login guard lock expires and rolling attempt window resets', () => {
  let now = 1000;
  const g = createLoginGuard({ maxAttempts: 2, windowMs: 4000, lockMs: 3000, now: () => now });
  g.fail('ip', 'admin'); g.fail('ip', 'admin');
  assert.equal(g.check('ip', 'admin').allowed, false);
  now += 3001;
  assert.equal(g.check('ip', 'admin').allowed, true);
  now += 5000;
  assert.equal(g.check('ip', 'admin').attemptsRemaining, 2);
});

test('successful login clears only matching IP and username bucket', () => {
  const g = createLoginGuard({ maxAttempts: 2 });
  g.fail('ip1', 'admin'); g.fail('ip2', 'admin');
  g.succeed('ip1', 'admin');
  assert.equal(g.check('ip1', 'admin').attemptsRemaining, 2);
  assert.equal(g.check('ip2', 'admin').attemptsRemaining, 1);
});

test('login guard validates its configuration', () => {
  assert.throws(() => createLoginGuard({ maxAttempts: 0 }), /maxAttempts/);
  assert.throws(() => createLoginGuard({ lockMs: 0 }), /windowMs/);
});
