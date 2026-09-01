const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('blind recommendation migration supports round-specific materials and current scoring version', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'MIGRATION_BLIND_RECOMMENDATION_V2.sql'), 'utf8');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS round_no SMALLINT NOT NULL DEFAULT 1/);
  assert.match(migration, /project_materials_project_round_item_key/);
  assert.match(migration, /CASE WHEN p_round_no = 2 THEN 'two_round_v5'/);
  assert.match(migration, /IF p_round_no = 1 AND pool_row\.status IN/);
  assert.doesNotMatch(migration, /project_materials\.id/);
  assert.doesNotMatch(migration, /资料未齐全|资料不完整|material_status/);
});
