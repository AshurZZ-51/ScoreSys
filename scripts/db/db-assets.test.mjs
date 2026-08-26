import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { MIGRATION_FILES } from './migrate.mjs';
import {
  TABLE_ORDER,
  assertSnapshotShape,
  buildImportSql,
  normalizeSnapshot,
} from './import-snapshot.mjs';

const EXPECTED_MIGRATIONS = [
  'db/migrations/0000_baseline_schema.sql',
  'MIGRATION.sql',
  'MIGRATION_PROJECT_POOL_V2.sql',
  'MIGRATION_ADMIN_LIFECYCLE_V3.sql',
  'MIGRATION_WORKFLOW_FIX_V4.sql',
  'MIGRATION_INITIATION_V4.sql',
  'MIGRATION_REVIEWER_BLIND_RATING_V1.sql',
  'db/migrations/0007_grants.sql',
];

const minimalTables = Object.fromEntries(TABLE_ORDER.map((table) => [table, []]));

function manifestFor(tables, overrides = {}) {
  const counts = Object.fromEntries(
    Object.entries(tables).map(([name, rows]) => [name, { count: rows.length }]),
  );
  return {
    table_count: TABLE_ORDER.length,
    row_count: Object.values(tables).reduce((sum, rows) => sum + rows.length, 0),
    tables: counts,
    errors: [],
    ...overrides,
  };
}

test('migration order is explicit and puts grants last', () => {
  assert.deepEqual(MIGRATION_FILES, EXPECTED_MIGRATIONS);
});

test('snapshot shape rejects missing tables and manifest export errors', () => {
  assert.throws(
    () => assertSnapshotShape({ tables: { ...minimalTables, scores: undefined } }, manifestFor(minimalTables)),
    /snapshot table missing: scores/,
  );
  assert.throws(
    () => assertSnapshotShape({ tables: minimalTables }, manifestFor(minimalTables, { errors: ['boom'] })),
    /manifest contains export errors/,
  );
  assert.throws(
    () => assertSnapshotShape({ tables: { ...minimalTables, unexpected: [] } }, manifestFor(minimalTables)),
    /snapshot must contain exactly the expected tables/,
  );
});

test('project arrays normalize without changing timestamps, nulls, or empty strings', () => {
  const snapshot = {
    tables: {
      ...minimalTables,
      projects: [{
        id: 'project-1',
        name: '',
        problems: {},
        actions: ['keep'],
        created_at: '2026-08-25T11:36:30.154082+08:00',
        assignment_status: null,
      }],
      meetings: [{ meeting_date: '2026-07-01', deadline: null, notes: '' }],
    },
  };

  const normalized = normalizeSnapshot(snapshot);
  assert.deepEqual(normalized.tables.projects[0].problems, []);
  assert.deepEqual(normalized.tables.projects[0].actions, ['keep']);
  assert.equal(normalized.tables.projects[0].created_at, '2026-08-25T11:36:30.154082+08:00');
  assert.equal(normalized.tables.projects[0].assignment_status, null);
  assert.equal(normalized.tables.projects[0].name, '');
  assert.deepEqual(normalized.tables.meetings[0], snapshot.tables.meetings[0]);
  assert.notEqual(normalized, snapshot);
});

test('non-force import protects non-empty tables and force is explicit', () => {
  const snapshot = { tables: minimalTables };
  const manifest = manifestFor(minimalTables);
  const protectedSql = buildImportSql(snapshot, manifest, { force: false, dryRun: false });
  const forcedSql = buildImportSql(snapshot, manifest, { force: true, dryRun: false });

  assert.match(protectedSql, /refusing to import into non-empty database; pass --force/);
  assert.doesNotMatch(protectedSql, /TRUNCATE TABLE/);
  assert.match(forcedSql, /TRUNCATE TABLE[\s\S]+RESTART IDENTITY CASCADE/);
});

test('manifest counts are checked inside the same transaction as bulk inserts', () => {
  const tables = { ...minimalTables, reviewers: [{ code: 'W' }] };
  const manifest = manifestFor(tables);
  manifest.tables.reviewers.count = 2;
  manifest.row_count = 2;
  const sql = buildImportSql({ tables }, manifest, { force: true, dryRun: false });

  assert.ok(sql.indexOf('BEGIN;') < sql.indexOf('json_populate_recordset'));
  assert.ok(sql.indexOf('json_populate_recordset') < sql.indexOf('snapshot manifest mismatch'));
  assert.match(sql, /reviewers[\s\S]+expected 2/);
  assert.match(sql, /total expected 2/);
  assert.match(sql, /COMMIT;/);
  assert.equal((sql.match(/json_populate_recordset/g) ?? []).length, TABLE_ORDER.length);
});

test('dry-run executes the full transaction but rolls it back', () => {
  const snapshot = { tables: minimalTables };
  const sql = buildImportSql(snapshot, manifestFor(minimalTables), { force: true, dryRun: true });
  assert.match(sql, /BEGIN;/);
  assert.match(sql, /json_populate_recordset/);
  assert.match(sql, /ROLLBACK;\s*$/);
  assert.doesNotMatch(sql, /COMMIT;/);
});

test('gate SQL names G1-G10 and covers FK and duplicate invariants', async () => {
  const sql = await readFile(new URL('./verify-gates.sql', import.meta.url), 'utf8');
  for (let gate = 1; gate <= 10; gate += 1) {
    assert.match(sql, new RegExp(`G${gate}`));
  }
  assert.match(sql, /snapshot_counts/);
  assert.match(sql, /LEFT JOIN[\s\S]+reviewers/);
  assert.match(sql, /GROUP BY meeting_id, project_id, reviewer_code, dim_name/);
  assert.match(sql, /project_reviewer_ratings[\s\S]+GROUP BY meeting_id, project_id, reviewer_code, round_no, attempt_no/);
  assert.match(sql, /reviewer_dims[\s\S]+GROUP BY reviewer_code, dim_name/);
});

test('app grants contain no secrets, ownership, superuser, or DDL grants', async () => {
  const sql = await readFile(new URL('../../db/migrations/0007_grants.sql', import.meta.url), 'utf8');
  assert.match(sql, /scoringsys_app/);
  assert.match(sql, /SELECT, INSERT, UPDATE, DELETE/);
  assert.match(sql, /EXECUTE ON ALL FUNCTIONS/);
  assert.doesNotMatch(sql, /PASSWORD|SECRET|OWNER TO|SUPERUSER|GRANT CREATE|GRANT ALL/i);
});

test('role bootstrap uses psql variables and least-privilege role attributes', async () => {
  const sql = await readFile(new URL('./bootstrap.sql', import.meta.url), 'utf8');
  assert.match(sql, /\\set ON_ERROR_STOP on/);
  assert.match(sql, /:'migrator_pw'/);
  assert.match(sql, /:'app_pw'/);
  assert.match(sql, /scoringsys_migrator[\s\S]+NOSUPERUSER NOCREATEDB NOCREATEROLE/);
  assert.match(sql, /scoringsys_app[\s\S]+NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT/);
  assert.doesNotMatch(sql, /postgresql:\/\//);
});
