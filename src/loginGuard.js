'use strict';

// Small in-process guard for a single-admin deployment. For multiple replicas,
// replace this with a shared Redis/database limiter before exposing the service.
function createLoginGuard({ maxAttempts = 5, windowMs = 15 * 60 * 1000, lockMs = 15 * 60 * 1000, now = () => Date.now() } = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be a positive integer');
  if (!Number.isFinite(windowMs) || windowMs < 1 || !Number.isFinite(lockMs) || lockMs < 1) throw new TypeError('windowMs and lockMs must be positive');
  const records = new Map();
  const keyFor = (ip, username) => `${String(ip || 'unknown').slice(0, 64)}\u0000${String(username || '').trim().toLowerCase().slice(0, 128)}`;
  function prune(record, t) {
    if (record.lockedUntil <= t) record.lockedUntil = 0;
    if (t - record.windowStartedAt >= windowMs) {
      record.attempts = 0;
      record.windowStartedAt = t;
    }
  }
  function check(ip, username) {
    const key = keyFor(ip, username), t = now();
    const record = records.get(key);
    if (!record) return { allowed: true, retryAfterMs: 0, attemptsRemaining: maxAttempts };
    prune(record, t);
    if (record.lockedUntil > t) return { allowed: false, retryAfterMs: record.lockedUntil - t, attemptsRemaining: 0 };
    return { allowed: true, retryAfterMs: 0, attemptsRemaining: Math.max(0, maxAttempts - record.attempts) };
  }
  function fail(ip, username) {
    const key = keyFor(ip, username), t = now();
    let record = records.get(key);
    if (!record) { record = { attempts: 0, windowStartedAt: t, lockedUntil: 0 }; records.set(key, record); }
    prune(record, t);
    record.attempts += 1;
    if (record.attempts >= maxAttempts) record.lockedUntil = t + lockMs;
    // Bound memory under random username/IP floods.
    if (records.size > 10000) {
      for (const [k, v] of records) if (t - v.windowStartedAt > windowMs && v.lockedUntil <= t) records.delete(k);
      while (records.size > 10000) records.delete(records.keys().next().value);
    }
    return check(ip, username);
  }
  function succeed(ip, username) { records.delete(keyFor(ip, username)); }
  function clear() { records.clear(); }
  return { check, fail, succeed, clear };
}

module.exports = { createLoginGuard };
