const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const migration = readFileSync(join(__dirname, '..', '..', 'MIGRATION_PROJECT_POOL_BACKFILL_V1.sql'), 'utf8');

test('legacy project backfill is idempotent and preserves historical records', () => {
  assert.match(migration, /project_migration_batches/);
  assert.match(migration, /project_migration_map/);
  assert.match(migration, /ON CONFLICT \(legacy_project_id\) DO NOTHING/);
  assert.match(migration, /UPDATE projects[\s\S]+pool_project_id/);
  assert.doesNotMatch(migration, /TRUNCATE\s+TABLE/i);
  assert.doesNotMatch(migration, /DELETE\s+FROM\s+(?:projects|scores)/i);
});

test('legacy project backfill creates both round material rows without overwriting checked status', () => {
  assert.match(migration, /round_no/);
  assert.match(migration, /ON CONFLICT \(project_id, round_no, item_key\) DO NOTHING/);
  assert.match(migration, /INSERT INTO project_materials[\s\S]+'missing'/i);
  assert.match(migration, /basic_info/);
  assert.match(migration, /risk_statement/);
});
