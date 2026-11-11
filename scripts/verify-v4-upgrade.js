'use strict';

const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

async function main() {
  const database = 'tron_energy_upgrade_test';
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
    const legacyEnum = "ENUM('pending_provider','processing','completed','failed','refunded')";
    const v4Enum = "ENUM('pending_provider','submitting','submission_unknown','processing','completed','failed','refunded','cancelled')";
    const schema = fs.readFileSync(schemaPath, 'utf8')
      .replace(/^CREATE DATABASE IF NOT EXISTS tron_energy\\b/m, 'CREATE DATABASE IF NOT EXISTS ' + database)
      .replace(/^USE tron_energy;/m, 'USE ' + database + ';')
      .replace(v4Enum, legacyEnum);
    if (schema.includes(v4Enum)) throw new Error('LEGACY_SCHEMA_ENUM_REPLACEMENT_FAILED');
    await connection.query(schema);
    await connection.query('USE `' + database + '`');
    await connection.execute('INSERT INTO users (telegram_id, referral_code) VALUES (?,?)', [990000001, 'upgrade-v4-fixture']);
    await connection.execute("INSERT INTO energy_orders (user_id,receiver_address,energy_amount,quoted_price,status) VALUES (1,?,?,?,'processing')", ['TUpgradeFixtureAddress', 65000, '1.250000']);
    const migration = fs.readFileSync(migrationPath, 'utf8');
    await connection.query(migration);
    await connection.query(migration);
    const [orders] = await connection.execute('SELECT id,status FROM energy_orders WHERE id=1');
    if (orders.length !== 1 || orders[0].status !== 'processing') throw new Error('EXISTING_ENERGY_ORDER_NOT_PRESERVED');
    const [tables] = await connection.execute('SELECT table_name FROM information_schema.tables WHERE table_schema=? AND table_name IN (?,?,?)', [database, 'background_jobs', 'event_inbox', 'event_outbox']);
    const names = new Set(tables.map(row => String(row.TABLE_NAME || row.table_name)));
    for (const name of ['background_jobs', 'event_inbox', 'event_outbox']) if (!names.has(name)) throw new Error('MISSING_UPGRADE_TABLE:' + name);
    const [columns] = await connection.execute('SELECT column_type FROM information_schema.columns WHERE table_schema=? AND table_name=? AND column_name=?', [database, 'energy_orders', 'status']);
    const statusType = String(columns[0]?.COLUMN_TYPE || columns[0]?.column_type || '');
    if (!statusType.includes('submission_unknown') || !statusType.includes('cancelled')) throw new Error('UPGRADE_ENUM_STATES_MISSING');
    process.stdout.write('[v4-upgrade] legacy schema migrated twice; existing order preserved\\n');
  } finally {
    await connection.query('DROP DATABASE IF EXISTS `' + database + '`').catch(() => {});
    await connection.end();
  }
}
main().catch(error => { process.stderr.write('[v4-upgrade] failed: ' + error.message + '\\n'); process.exitCode = 1; });
