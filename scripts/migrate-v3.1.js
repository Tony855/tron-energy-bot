const { pool } = require('../src/db');

async function main() {
  const columns = [
    ['scan_from_timestamp', 'BIGINT NULL AFTER last_scanned_at'],
    ['trc20_cursor', 'VARCHAR(512) NULL AFTER scan_from_timestamp'],
    ['trx_cursor', 'VARCHAR(512) NULL AFTER trc20_cursor']
  ];
  try {
    for (const [name, definition] of columns) {
      const [rows] = await pool.execute(
        `SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='wallets' AND COLUMN_NAME=?`,
        [name]
      );
      if (Number(rows[0].n) === 0) {
        await pool.query(`ALTER TABLE wallets ADD COLUMN ${name} ${definition}`);
        console.log(`[migration] added wallets.${name}`);
      } else console.log(`[migration] wallets.${name} already exists`);
    }
  } finally { await pool.end(); }
}
main().catch(e => { console.error('[migration] failed:', e.message); process.exit(1); });
