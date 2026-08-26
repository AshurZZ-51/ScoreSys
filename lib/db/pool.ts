import { Pool, types } from 'pg';
import { DatabaseUnavailableError, TransactionScopeError } from './errors';
import { currentTransaction } from './transactionContext';

declare global {
  var __scoringsysPool: Pool | undefined;
}

function parseNumeric(value: string): number | string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  if (Number.isInteger(parsed) && !Number.isSafeInteger(parsed)) return value;
  return parsed;
}

types.setTypeParser(1700, parseNumeric);
types.setTypeParser(1082, (value) => value);

function positiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new DatabaseUnavailableError(`${name} must be a positive integer`);
  }
  return parsed;
}

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new DatabaseUnavailableError('DATABASE_URL is not configured');
  }

  const created = new Pool({
    connectionString,
    max: positiveInteger('DB_POOL_MAX', 10),
    min: 0,
    idleTimeoutMillis: positiveInteger('DB_IDLE_TIMEOUT_MS', 30_000),
    connectionTimeoutMillis: positiveInteger('DB_CONNECT_TIMEOUT_MS', 5_000),
    statement_timeout: positiveInteger('DB_STATEMENT_TIMEOUT_MS', 15_000),
    query_timeout: positiveInteger('DB_QUERY_TIMEOUT_MS', 15_000),
    application_name: 'scoringsys',
    ssl: process.env.DB_SSL === 'require' ? { rejectUnauthorized: true } : undefined,
  });

  created.on('error', (error) => {
    console.error('[db] idle client error', error);
  });
  return created;
}

export function getPool(): Pool {
  if (currentTransaction()) {
    throw new TransactionScopeError('the shared pool is unavailable inside tx');
  }
  if (!globalThis.__scoringsysPool) globalThis.__scoringsysPool = createPool();
  return globalThis.__scoringsysPool;
}

export const pool: Pick<Pool, 'connect' | 'query'> = {
  connect: () => getPool().connect(),
  query: (async (...args: unknown[]) => {
    const query = getPool().query.bind(getPool()) as (...queryArgs: unknown[]) => unknown;
    return query(...args);
  }) as Pool['query'],
};

export async function closePool(): Promise<void> {
  const current = globalThis.__scoringsysPool;
  if (!current) return;
  globalThis.__scoringsysPool = undefined;
  await current.end();
}
