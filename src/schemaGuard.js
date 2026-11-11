'use strict';

const REQUIRED_TABLES = Object.freeze(['background_jobs', 'event_inbox', 'event_outbox', 'energy_orders']);

async function assertV4Schema(pool) {
  const [rows] = await pool.execute(
    'SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN (?,?,?,?)',
    REQUIRED_TABLES
  );
  const present = new Set(rows.map(row => String(row.table_name)));
  const missing = REQUIRED_TABLES.filter(name => !present.has(name));
  if (missing.length) {
    const error = new Error('V4_SCHEMA_MIGRATION_REQUIRED');
    error.code = 'V4_SCHEMA_MIGRATION_REQUIRED';
    error.missingTables = missing;
    throw error;
  }
  const [columns] = await pool.execute(
    "SELECT column_type FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='energy_orders' AND column_name='status' LIMIT 1"
  );
  const type = String(columns[0]?.column_type || '');
  if (!type.includes('submission_unknown') || !type.includes('cancelled')) {
    const error = new Error('V4_SCHEMA_MIGRATION_REQUIRED');
    error.code = 'V4_SCHEMA_MIGRATION_REQUIRED';
    error.missingColumns = ['energy_orders.status'];
    throw error;
  }
  return true;
}

module.exports = { REQUIRED_TABLES, assertV4Schema };
