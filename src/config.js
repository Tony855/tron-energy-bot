'use strict';

function positiveInteger(value, fallback, name, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`Invalid ${name}: expected an integer between 1 and ${max}`);
  }
  return parsed;
}

function loadConfig(env = process.env) {
  const jwtSecret = String(env.JWT_SECRET || '');
  if (jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be set to at least 32 characters');
  }
  if (!String(env.DB_USER || '').trim() || !String(env.DB_PASSWORD || '')) {
    throw new Error('DB_USER and DB_PASSWORD must be configured');
  }
  const host = String(env.HOST || '127.0.0.1').trim();
  if (!host) throw new Error('HOST must not be empty');
  return Object.freeze({
    host,
    port: positiveInteger(env.PORT, 3080, 'PORT', 65535),
    shutdownTimeoutMs: positiveInteger(env.SHUTDOWN_TIMEOUT_MS, 15000, 'SHUTDOWN_TIMEOUT_MS', 120000)
  });
}

module.exports = { loadConfig, positiveInteger };
