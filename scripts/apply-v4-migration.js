'use strict';

const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

async function main() {
  const database = process.env.DB_NAME || 'tron_energy';
  if (!/^[A-Za-z0-9_]+$/.test(database)) throw new Error('INVALID_DB_NAME');
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database,
    multipleStatements: true,
    connectTimeout: 10000
  });
  try {
    const migration = fs.readFileSync(path.join(__dirname, '..', 'sql', 'migrate_v4_durable_queue.sql'), 'utf8');
    await connection.query(migration);
    const [tables] = await connection.query(
      'SELECT table_name FROM information_schema.tables WHERE table_schema=? AND table_name IN (?,?,?,?)',
      [database, 'background_jobs', 'event_inbox', 'event_outbox', 'energy_orders']
    );
    const names = new Set(tables.map(row => String(row.TABLE_NAME || row.table_name)));
    const missing = ['background_jobs', 'event_inbox', 'event_outbox', 'energy_orders'].filter(name => !names.has(name));
    if (missing.length) throw new Error('V4_TABLES_MISSING:' + missing.join(','));
    const [columns] = await connection.query(
      'SELECT column_type FROM information_schema.columns WHERE table_schema=? AND table_name=? AND column_name=?',
      [database, 'energy_orders', 'status']
    );
    const statusType = String(columns[0]?.COLUMN_TYPE || columns[0]?.column_type || '');
    if (!statusType.includes('submission_unknown') || !statusType.includes('cancelled')) throw new Error('V4_ENERGY_ORDER_STATES_MISSING');
    process.stdout.write('[v4-migration] applied and schema-verified for ' + database + '\n');
  } finally {
    await connection.end();
  }
}
main().catch(error => { process.stderr.write('[v4-migration] failed: ' + error.message + '\n'); process.exitCode = 1; });
