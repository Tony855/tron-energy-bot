'use strict';
const crypto = require('node:crypto');

function keyFor(ip, username) {
  return crypto.createHash('sha256').update(`${String(ip).slice(0,128)}\0${String(username).trim().toLowerCase().slice(0,128)}`).digest('hex');
}
function createSharedLoginGuard(pool, { maxAttempts = 5, windowMs = 900000, lockMs = 900000 } = {}) {
  const max = Math.max(1, Math.min(100, Number(maxAttempts) || 5));
  const window = Math.max(1000, Number(windowMs) || 900000);
  const lock = Math.max(1000, Number(lockMs) || 900000);
  return {
    async check(ip, username) {
      const key = keyFor(ip, username);
      const [rows] = await pool.execute('SELECT fail_count, window_started_at, locked_until FROM admin_login_limits WHERE key_hash=? LIMIT 1', [key]);
      if (!rows.length) return { allowed: true, retryAfterMs: 0 };
      const row = rows[0], now = Date.now();
      const lockedUntil = row.locked_until ? new Date(row.locked_until).getTime() : 0;
      if (lockedUntil > now) return { allowed: false, retryAfterMs: lockedUntil - now };
      const started = row.window_started_at ? new Date(row.window_started_at).getTime() : 0;
      if (now - started >= window) return { allowed: true, retryAfterMs: 0 };
      return { allowed: Number(row.fail_count) < max, retryAfterMs: 0 };
    },
    async fail(ip, username) {
      const key = keyFor(ip, username);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [rows] = await conn.execute('SELECT fail_count, window_started_at FROM admin_login_limits WHERE key_hash=? FOR UPDATE', [key]);
        const now = Date.now();
        let count = 1;
        if (rows.length && now - new Date(rows[0].window_started_at).getTime() < window) count = Number(rows[0].fail_count) + 1;
        const startedAt = rows.length && now - new Date(rows[0].window_started_at).getTime() < window ? rows[0].window_started_at : new Date();
        const lockedUntil = count >= max ? new Date(now + lock) : null;
        await conn.execute(
          `INSERT INTO admin_login_limits (key_hash,fail_count,window_started_at,locked_until,updated_at) VALUES (?,?,?,?,UTC_TIMESTAMP())
           ON DUPLICATE KEY UPDATE fail_count=VALUES(fail_count),window_started_at=VALUES(window_started_at),locked_until=VALUES(locked_until),updated_at=UTC_TIMESTAMP()`,
          [key, count, startedAt, lockedUntil]
        );
        await conn.commit();
        return { failCount: count, locked: count >= max, retryAfterMs: count >= max ? lock : 0 };
      } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
    },
    async succeed(ip, username) {
      await pool.execute('DELETE FROM admin_login_limits WHERE key_hash=?', [keyFor(ip, username)]);
    }
  };
}
module.exports = { createSharedLoginGuard, keyFor };
