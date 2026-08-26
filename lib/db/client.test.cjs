const assert = require('node:assert/strict');
const test = require('node:test');
require('./testTypeScript.cjs');

const {
  execute,
  maybeOne,
  one,
  query,
  tx,
} = require('./client.ts');
const {
  ConflictError,
  DbError,
  NotFoundError,
  TransactionScopeError,
} = require('./errors.ts');
const { pool } = require('./pool.ts');

function executorWith(rows, rowCount = rows.length) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      return { rows, rowCount };
    },
  };
}

test('query passes parameter values separately from SQL text', async () => {
  const executor = executorWith([{ id: 'project-1' }]);
  const params = ["Robert'); DROP TABLE projects;--"];

  const rows = await query('SELECT id FROM projects WHERE name = $1', params, executor);

  assert.deepEqual(rows, [{ id: 'project-1' }]);
  assert.deepEqual(executor.calls, [{
    text: 'SELECT id FROM projects WHERE name = $1',
    params,
  }]);
  assert.equal(executor.calls[0].text.includes(params[0]), false);
});

test('one requires exactly one row', async () => {
  await assert.rejects(
    one('SELECT 1', [], executorWith([])),
    NotFoundError,
  );
  await assert.rejects(
    one('SELECT 1', [], executorWith([{ id: 1 }, { id: 2 }])),
    ConflictError,
  );
  assert.deepEqual(
    await one('SELECT 1', [], executorWith([{ id: 1 }])),
    { id: 1 },
  );
});

test('maybeOne accepts zero or one row and rejects more', async () => {
  assert.equal(await maybeOne('SELECT 1', [], executorWith([])), null);
  assert.deepEqual(
    await maybeOne('SELECT 1', [], executorWith([{ id: 1 }])),
    { id: 1 },
  );
  await assert.rejects(
    maybeOne('SELECT 1', [], executorWith([{ id: 1 }, { id: 2 }])),
    ConflictError,
  );
});

test('execute returns the affected row count', async () => {
  const executor = executorWith([], 3);
  assert.equal(await execute('UPDATE projects SET name = $1 WHERE id = ANY($2)', ['x', ['1']], executor), 3);
});

function transactionHarness({ failRollback = false } = {}) {
  const calls = [];
  let released = false;
  const client = {
    async query(text, params = []) {
      calls.push({ text, params });
      if (text === 'ROLLBACK' && failRollback) throw new Error('rollback failed');
      return { rows: text === 'SELECT $1::int AS value' ? [{ value: params[0] }] : [], rowCount: 0 };
    },
    release() {
      released = true;
    },
  };
  const connector = {
    async connect() {
      calls.push({ text: 'CONNECT', params: [] });
      return client;
    },
  };
  return { calls, connector, get released() { return released; } };
}

test('tx commits work executed through its transaction executor', async () => {
  const harness = transactionHarness();

  const result = await tx(async (transaction) => {
    return one('SELECT $1::int AS value', [7], transaction);
  }, harness.connector);

  assert.deepEqual(result, { value: 7 });
  assert.deepEqual(harness.calls.map((call) => call.text), [
    'CONNECT',
    'BEGIN',
    'SELECT $1::int AS value',
    'COMMIT',
  ]);
  assert.equal(harness.released, true);
});

test('tx rolls back on callback failure and always releases the client', async () => {
  const harness = transactionHarness();

  await assert.rejects(
    tx(async () => {
      throw new Error('write failed');
    }, harness.connector),
    (error) => error instanceof DbError && error.message === 'write failed',
  );

  assert.deepEqual(harness.calls.map((call) => call.text), [
    'CONNECT',
    'BEGIN',
    'ROLLBACK',
  ]);
  assert.equal(harness.released, true);
});

test('tx preserves the original error when rollback also fails', async () => {
  const harness = transactionHarness({ failRollback: true });

  await assert.rejects(
    tx(async () => {
      throw new Error('original failure');
    }, harness.connector),
    (error) => error.message === 'original failure',
  );
  assert.equal(harness.released, true);
});

test('queries inside tx must explicitly use its transaction executor', async () => {
  const harness = transactionHarness();

  await assert.rejects(
    tx(async () => query('SELECT 1'), harness.connector),
    TransactionScopeError,
  );
  assert.deepEqual(harness.calls.map((call) => call.text), [
    'CONNECT',
    'BEGIN',
    'ROLLBACK',
  ]);
});

test('tx blocks direct access to the shared pool from its callback', async () => {
  const harness = transactionHarness();

  await assert.rejects(
    tx(async () => pool.query('SELECT 1'), harness.connector),
    TransactionScopeError,
  );
  assert.deepEqual(harness.calls.map((call) => call.text), [
    'CONNECT',
    'BEGIN',
    'ROLLBACK',
  ]);
});
