'use strict';

const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

async function main() {
  const database = 'tron_energy_install_test';
  const connection = await mysql.createConnection({
    host: process.env.INSTALL_TEST_DB_HOST || '127.0.0.1',
    port: Number(process.env.INSTALL_TEST_DB_PORT || 3306),
    user: process.env.INSTALL_TEST_DB_USER || 'root',
    password: process.env.INSTALL_TEST_DB_PASSWORD || 'root',
    multipleStatements: true,
    connectTimeout: 10000
  });

  try {
    await connection.query('DROP DATABASE IF EXISTS `' + database + '`');
    await connection.query('CREATE DATABASE `' + database + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    const schemaPath = path.join(__dirname, '..', 'sql', 'schema.sql');
    const migrationPath = path.join(__dirname, '..', 'sql', 'migrate_v4_durable_queue.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8')
      .replace(/^CREATE DATABASE IF NOT EXISTS tron_energy\\b/m, 'CREATE DATABASE IF NOT EXISTS ' + database)
      .replace(/^USE tron_energy;/m, 'USE ' + database + ';');
    const migration = fs.readFileSync(migrationPath, 'utf8');
    await connection.query(schema);
    await connection.query('USE `' + database + '`');
    await connection.query(migration);
    await connection.query(migration); // idempotency check

    const [tables] = await connection.query(
      'SELECT table_name FROM information_schema.tables WHERE table_schema=? AND table_name IN (?,?,?,?)',
      [database, 'background_jobs', 'event_inbox', 'event_outbox', 'energy_orders']
    );
    const names = new Set(tables.map(row => row.TABLE_NAME || row.table_name));
    for (const required of ['background_jobs', 'event_inbox', 'event_outbox', 'energy_orders']) {
      if (!names.has(required)) throw new Error('MISSING_V4_TABLE:' + required);
    }
    const [columns] = await connection.query(
      'SELECT column_type FROM information_schema.columns WHERE table_schema=? AND table_name=? AND column_name=?',
      [database, 'energy_orders', 'status']
    );
    const type = String(columns[0]?.COLUMN_TYPE || columns[0]?.column_type || '');
    if (!type.includes('submission_unknown') || !type.includes('cancelled')) throw new Error('MISSING_V4_ENERGY_ORDER_STATES');
    process.stdout.write('[fresh-install-schema] base schema + V4 migration (twice) passed\\n');
  } finally {
    await connection.query('DROP DATABASE IF EXISTS `' + database + '`').catch(() => {});
    await connection.end();
  }
}

main().catch(error => {
  process.stderr.write('[fresh-install-schema] failed: ' + error.message + '\\n');
  process.exitCode = 1;
});
