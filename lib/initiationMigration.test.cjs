const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('V4 migration is idempotent and contains the confirmed data additions', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'MIGRATION_INITIATION_V4.sql'), 'utf8');
  for (const token of [
    'project_rating_history',
    'preliminary_rating',
    'final_rating',
    "('operations_metrics', true)",
    "('virtual_team', true)",
    "SELECT 'o', 'Ollie'",
    "SELECT 'si', 'Simon'",
    "'two_round_v4'",
    'apply_project_rating'
  ]) assert.ok(migration.includes(token), `missing migration token: ${token}`);
  assert.match(migration, /WHERE NOT EXISTS \(\s*SELECT 1\s+FROM project_materials/s);
  assert.match(migration, /WHERE NOT EXISTS \(\s*SELECT 1\s+FROM reviewers/s);
  assert.match(migration, /(?:WHERE|AND) NOT EXISTS \(\s*SELECT 1\s+FROM reviewer_dims/s);
  assert.doesNotMatch(migration, /ON CONFLICT \(project_id, item_key\)/);
  assert.doesNotMatch(migration, /ON CONFLICT \(reviewer_code, dim_name\)/);
  assert.match(migration, /CASE WHEN p_round_no = 2 THEN 'two_round_v4'/);
});
