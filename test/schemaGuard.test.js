'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertV4Schema } = require('../src/schemaGuard');

test('schema guard requires all durable event tables', async () => {
  const pool = { execute: async () => [[{ table_name: 'event_inbox' }], []] };
  await assert.rejects(() => assertV4Schema(pool), error =>
    error.code === 'V4_SCHEMA_MIGRATION_REQUIRED' &&
    error.missingTables.includes('background_jobs') &&
    error.missingTables.includes('event_outbox')
  );
});

test('schema guard requires new energy order states', async () => {
  let call = 0;
  const pool = { execute: async () => {
    call++;
    if (call === 1) return [[
      { table_name: 'background_jobs' }, { table_name: 'event_inbox' },
      { table_name: 'event_outbox' }, { table_name: 'energy_orders' }
    ], []];
    return [[{ column_type: "enum('pending_provider','processing','completed','failed','refunded')" }], []];
  }};
  await assert.rejects(() => assertV4Schema(pool), { code: 'V4_SCHEMA_MIGRATION_REQUIRED' });
});

test('schema guard accepts fully migrated V4 schema', async () => {
  let call = 0;
  const pool = { execute: async () => {
    call++;
    if (call === 1) return [[
      { table_name: 'background_jobs' }, { table_name: 'event_inbox' },
      { table_name: 'event_outbox' }, { table_name: 'energy_orders' }
    ], []];
    return [[{ column_type: "enum('pending_provider','submitting','submission_unknown','processing','completed','failed','refunded','cancelled')" }], []];
  }};
  assert.equal(await assertV4Schema(pool), true);
});
