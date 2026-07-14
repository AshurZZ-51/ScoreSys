const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('lifecycle migration defines locked sequential transactional purge and atomic audited mutations', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'MIGRATION_ADMIN_LIFECYCLE_V3.sql'), 'utf8');

  assert.match(migration, /CREATE OR REPLACE FUNCTION purge_due_project_deletions\s*\(/);
  assert.match(migration, /FOR UPDATE OF deletion_request, pool_row SKIP LOCKED/);
  assert.match(migration, /DELETE FROM scores/);
  assert.match(migration, /DELETE FROM projects/);
  assert.match(migration, /DELETE FROM report_snapshots/);
  assert.match(migration, /DELETE FROM project_pool/);
  assert.doesNotMatch(migration, /WITH due AS MATERIALIZED[\s\S]*DELETE FROM scores[\s\S]*DELETE FROM projects[\s\S]*DELETE FROM report_snapshots[\s\S]*DELETE FROM project_pool/);
  assert.match(migration, /FOR due_record IN[\s\S]*FOR UPDATE OF deletion_request, pool_row SKIP LOCKED[\s\S]*IF due_record\.restored_at IS NULL AND due_record\.purge_after <= now\(\) THEN[\s\S]*DELETE FROM scores[\s\S]*DELETE FROM projects[\s\S]*DELETE FROM report_snapshots[\s\S]*DELETE FROM project_pool/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION apply_project_pool_mutations\s*\(/);
  assert.match(migration, /INSERT INTO project_status_history/);
});
