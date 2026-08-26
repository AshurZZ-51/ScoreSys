#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TABLE_ORDER = Object.freeze([
  'reviewers',
  'meetings',
  'project_migration_batches',
  'reviewer_dims',
  'project_pool',
  'projects',
  'meeting_reviewers',
  'project_migration_map',
  'project_materials',
  'project_status_history',
  'project_deletion_requests',
  'report_snapshots',
  'account_audit_logs',
  'project_rating_history',
  'scores',
  'project_reviewer_ratings',
]);

const verifyGatesSql = readFileSync(new URL('./verify-gates.sql', import.meta.url), 'utf8')
  .replace(/^\\set ON_ERROR_STOP on\s*/u, '');

export function assertSnapshotShape(snapshot, manifest) {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.tables || typeof snapshot.tables !== 'object') {
    throw new Error('snapshot.tables object is required');
  }
  if (!manifest || typeof manifest !== 'object' || !manifest.tables || typeof manifest.tables !== 'object') {
    throw new Error('manifest.tables object is required');
  }
  if (!Array.isArray(manifest.errors) || manifest.errors.length > 0) {
    throw new Error('manifest contains export errors');
  }
  if (manifest.table_count !== TABLE_ORDER.length) {
    throw new Error(`manifest table_count must be ${TABLE_ORDER.length}`);
  }
  if (!Number.isSafeInteger(manifest.row_count) || manifest.row_count < 0) {
    throw new Error('manifest row_count is required');
  }
  const expectedTables = [...TABLE_ORDER].sort();
  if (JSON.stringify(Object.keys(snapshot.tables).sort()) !== JSON.stringify(expectedTables)) {
    throw new Error('snapshot must contain exactly the expected tables');
  }
  if (JSON.stringify(Object.keys(manifest.tables).sort()) !== JSON.stringify(expectedTables)) {
    throw new Error('manifest must contain exactly the expected tables');
  }

  for (const table of TABLE_ORDER) {
    if (!Array.isArray(snapshot.tables[table])) {
      throw new Error(`snapshot table missing: ${table}`);
    }
    if (!manifest.tables[table] || !Number.isSafeInteger(manifest.tables[table].count) || manifest.tables[table].count < 0) {
      throw new Error(`manifest count missing: ${table}`);
    }
  }
}

export function normalizeSnapshot(snapshot) {
  const tables = Object.fromEntries(
    Object.entries(snapshot.tables).map(([table, rows]) => [
      table,
      rows.map((row) => ({ ...row })),
    ]),
  );

  tables.projects = tables.projects.map((project) => ({
    ...project,
    problems: Array.isArray(project.problems) ? project.problems : [],
    actions: Array.isArray(project.actions) ? project.actions : [],
  }));

  return { ...snapshot, tables };
}

function dollarQuote(value, seed) {
  let suffix = 0;
  let tag;
  do {
    tag = `$${seed}${suffix || ''}$`;
    suffix += 1;
  } while (value.includes(tag));
  return `${tag}${value}${tag}`;
}

function emptyDatabaseGuard() {
  const checks = TABLE_ORDER.map((table) => `EXISTS (SELECT 1 FROM public.${table} LIMIT 1)`).join('\n      OR ');
  return `DO $empty_guard$\nBEGIN\n  IF ${checks} THEN\n    RAISE EXCEPTION 'refusing to import into non-empty database; pass --force';\n  END IF;\nEND\n$empty_guard$;`;
}

function manifestAssertions(manifest) {
  const checks = TABLE_ORDER.map((table) => {
    const expected = manifest.tables[table].count;
    return `  SELECT count(*) INTO actual_count FROM public.${table};\n  IF actual_count <> ${expected} THEN\n    RAISE EXCEPTION 'snapshot manifest mismatch: ${table} expected ${expected}, got %', actual_count;\n  END IF;`;
  }).join('\n');

  return `DO $manifest_gate$\nDECLARE\n  actual_count BIGINT;\nBEGIN\n${checks}\n  SELECT ${TABLE_ORDER.map((table) => `(SELECT count(*) FROM public.${table})`).join(' +\n         ')} INTO actual_count;\n  IF actual_count <> ${manifest.row_count} THEN\n    RAISE EXCEPTION 'snapshot manifest mismatch: total expected ${manifest.row_count}, got %', actual_count;\n  END IF;\nEND\n$manifest_gate$;`;
}

export function parseBundleText(bundleText) {
  let bundle;
  try {
    bundle = JSON.parse(bundleText);
  } catch {
    throw new Error('stdin bundle must be valid JSON');
  }
  if (!bundle || typeof bundle !== 'object' || !bundle.snapshot || !bundle.manifest) {
    throw new Error('stdin bundle must contain snapshot and manifest');
  }
  return { snapshot: bundle.snapshot, manifest: bundle.manifest };
}

export function buildImportSql(snapshot, manifest, { force = false, dryRun = false } = {}) {
  assertSnapshotShape(snapshot, manifest);
  const normalized = normalizeSnapshot(snapshot);
  const statements = ['\\set ON_ERROR_STOP on', 'BEGIN;'];

  if (force) {
    statements.push(`TRUNCATE TABLE\n  ${TABLE_ORDER.map((table) => `public.${table}`).join(',\n  ')}\nRESTART IDENTITY CASCADE;`);
  } else {
    statements.push(emptyDatabaseGuard());
  }

  for (const table of TABLE_ORDER) {
    const json = JSON.stringify(normalized.tables[table]);
    statements.push(
      `INSERT INTO public.${table}\nSELECT * FROM json_populate_recordset(NULL::public.${table}, ${dollarQuote(json, `snapshot_${table}`)}::json);`,
    );
  }

  // Snapshots exported before pgcrypto was introduced may contain plaintext
  // reviewer passwords. Rehash them while the import transaction is open.
  statements.push(`UPDATE public.reviewers
SET password_hash = crypt(password_hash, gen_salt('bf'))
WHERE password_hash !~ '^\\$2';`);

  statements.push(manifestAssertions(manifest));
  statements.push(verifyGatesSql.trim());
  statements.push(dryRun ? 'ROLLBACK;' : 'COMMIT;');
  return `${statements.join('\n\n')}\n`;
}

function runPsql(sql, { databaseUrl, psqlBin }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(psqlBin, [
      '-X',
      '--set=ON_ERROR_STOP=1',
      `--dbname=${databaseUrl}`,
    ], { stdio: ['pipe', 'inherit', 'inherit'] });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`snapshot import failed (${signal ?? `exit ${code}`})`));
    });
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') reject(error);
    });
    child.stdin.end(sql);
  });
}

export function parseArguments(argumentsList) {
  const options = { force: false, dryRun: false, file: null, manifest: null };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--force') options.force = true;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--file') options.file = argumentsList[++index];
    else if (argument === '--manifest') options.manifest = argumentsList[++index];
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!options.file) throw new Error('--file is required');
  if (options.file !== '-' && !options.manifest) throw new Error('--manifest is required when --file is not -');
  if (options.file === '-' && options.manifest) throw new Error('--manifest cannot be used with stdin bundle');
  return options;
}

export async function importSnapshot(options) {
  const databaseUrl = process.env.MIGRATOR_DATABASE_URL;
  if (!databaseUrl) throw new Error('MIGRATOR_DATABASE_URL is required');

  let snapshot;
  let manifest;
  if (options.file === '-') {
    const bundle = parseBundleText(readFileSync(0, 'utf8'));
    snapshot = bundle.snapshot;
    manifest = bundle.manifest;
  } else {
    const snapshotText = await readFile(resolve(options.file), 'utf8');
    const manifestText = await readFile(resolve(options.manifest), 'utf8');
    snapshot = JSON.parse(snapshotText);
    manifest = JSON.parse(manifestText);
  }
  const sql = buildImportSql(snapshot, manifest, options);

  await runPsql(sql, {
    databaseUrl,
    psqlBin: process.env.PSQL_BIN || 'psql',
  });
  process.stdout.write(`snapshot ${options.dryRun ? 'dry-run verified and rolled back' : 'import committed'}\n`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const options = parseArguments(process.argv.slice(2));
    await importSnapshot(options);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
