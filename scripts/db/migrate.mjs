#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../..');

export const MIGRATION_FILES = Object.freeze([
  'db/migrations/0000_baseline_schema.sql',
  'MIGRATION.sql',
  'MIGRATION_PROJECT_POOL_V2.sql',
  'MIGRATION_ADMIN_LIFECYCLE_V3.sql',
  'MIGRATION_WORKFLOW_FIX_V4.sql',
  'MIGRATION_INITIATION_V4.sql',
  'MIGRATION_BLIND_RECOMMENDATION_V2.sql',
  'MIGRATION_PROJECT_POOL_BACKFILL_V1.sql',
  'MIGRATION_REVIEWER_BLIND_RATING_V1.sql',
  'db/migrations/0007_grants.sql',
]);

function runPsql(psqlBin, databaseUrl, relativePath) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(psqlBin, [
      '-X',
      '--set=ON_ERROR_STOP=1',
      '--single-transaction',
      `--dbname=${databaseUrl}`,
      `--file=${resolve(repositoryRoot, relativePath)}`,
    ], { stdio: 'inherit' });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`migration failed: ${relativePath} (${signal ?? `exit ${code}`})`));
    });
  });
}

export async function migrate({
  databaseUrl = process.env.MIGRATOR_DATABASE_URL,
  psqlBin = process.env.PSQL_BIN || 'psql',
} = {}) {
  if (!databaseUrl) {
    throw new Error('MIGRATOR_DATABASE_URL is required');
  }

  for (const relativePath of MIGRATION_FILES) {
    process.stdout.write(`migrate: ${relativePath}\n`);
    await runPsql(psqlBin, databaseUrl, relativePath);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const supported = new Set(['--fail-fast']);
  const unknown = process.argv.slice(2).filter((argument) => !supported.has(argument));
  if (unknown.length > 0) {
    console.error(`unknown argument: ${unknown[0]}`);
    process.exitCode = 2;
  } else {
    migrate().catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
