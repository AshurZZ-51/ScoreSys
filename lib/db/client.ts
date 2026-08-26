import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { ConflictError, mapPgError, NotFoundError, TransactionScopeError } from './errors';
import { pool } from './pool';
import { currentTransaction, runInTransaction } from './transactionContext';

export interface Executor {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<Row>>;
}

export interface Connector {
  connect(): Promise<PoolClient>;
}

function executorFor(explicit?: Executor): Executor {
  const transaction = currentTransaction<Executor>();
  if (transaction && explicit !== transaction) {
    throw new TransactionScopeError('queries inside tx must use its transaction executor');
  }
  return explicit ?? pool;
}

export async function query<Row extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
  executor?: Executor,
): Promise<Row[]> {
  try {
    return (await executorFor(executor).query<Row>(text, params)).rows;
  } catch (error) {
    throw mapPgError(error);
  }
}

export async function one<Row extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
  executor?: Executor,
): Promise<Row> {
  const rows = await query<Row>(text, params, executor);
  if (rows.length === 0) throw new NotFoundError('expected exactly one row, got 0');
  if (rows.length > 1) throw new ConflictError(`expected exactly one row, got ${rows.length}`);
  return rows[0];
}

export async function maybeOne<Row extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
  executor?: Executor,
): Promise<Row | null> {
  const rows = await query<Row>(text, params, executor);
  if (rows.length > 1) throw new ConflictError(`expected at most one row, got ${rows.length}`);
  return rows[0] ?? null;
}

export async function execute(
  text: string,
  params: unknown[] = [],
  executor?: Executor,
): Promise<number> {
  try {
    return (await executorFor(executor).query(text, params)).rowCount ?? 0;
  } catch (error) {
    throw mapPgError(error);
  }
}

export async function tx<Result>(
  callback: (transaction: Executor) => Promise<Result>,
  connector: Connector = pool,
): Promise<Result> {
  if (currentTransaction()) {
    throw new TransactionScopeError('nested transactions are not supported');
  }

  let client: PoolClient;
  try {
    client = await connector.connect();
  } catch (error) {
    throw mapPgError(error);
  }

  let began = false;
  try {
    await client.query('BEGIN');
    began = true;
    const result = await runInTransaction(client, () => callback(client));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (began) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the operation error; the client is released below.
      }
    }
    throw mapPgError(error);
  } finally {
    client.release();
  }
}
