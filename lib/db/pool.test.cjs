const assert = require('node:assert/strict');
const test = require('node:test');
require('./testTypeScript.cjs');

const { types } = require('pg');
const {
  closePool,
  getPool,
  pool,
} = require('./pool.ts');
const { DatabaseUnavailableError } = require('./errors.ts');

function resetPoolEnvironment() {
  delete globalThis.__scoringsysPool;
  delete process.env.DATABASE_URL;
  delete process.env.DB_POOL_MAX;
  delete process.env.DB_CONNECT_TIMEOUT_MS;
  delete process.env.DB_IDLE_TIMEOUT_MS;
  delete process.env.DB_QUERY_TIMEOUT_MS;
  delete process.env.DB_STATEMENT_TIMEOUT_MS;
  delete process.env.DB_SSL;
}

test.afterEach(async () => {
  await closePool();
  resetPoolEnvironment();
});

test('importing the pool does not construct a global Pool', () => {
  assert.equal(globalThis.__scoringsysPool, undefined);
});

test('the first query fails closed when DATABASE_URL is absent', async () => {
  resetPoolEnvironment();
  await assert.rejects(pool.query('SELECT 1'), DatabaseUnavailableError);
  assert.equal(globalThis.__scoringsysPool, undefined);
});

test('getPool lazily creates one global Pool with configured limits', async () => {
  resetPoolEnvironment();
  process.env.DATABASE_URL = 'postgresql://app:test@127.0.0.1:5432/scoringsys';
  process.env.DB_POOL_MAX = '7';
  process.env.DB_CONNECT_TIMEOUT_MS = '1200';
  process.env.DB_IDLE_TIMEOUT_MS = '34000';
  process.env.DB_QUERY_TIMEOUT_MS = '14000';
  process.env.DB_STATEMENT_TIMEOUT_MS = '13000';
  process.env.DB_SSL = 'require';

  const first = getPool();
  const second = getPool();

  assert.equal(first, second);
  assert.equal(globalThis.__scoringsysPool, first);
  assert.equal(first.options.max, 7);
  assert.equal(first.options.connectionTimeoutMillis, 1200);
  assert.equal(first.options.idleTimeoutMillis, 34000);
  assert.equal(first.options.query_timeout, 14000);
  assert.equal(first.options.statement_timeout, 13000);
  assert.deepEqual(first.options.ssl, { rejectUnauthorized: true });
  assert.equal(first.options.application_name, 'scoringsys');
});

test('numeric and date parsers preserve JSON-compatible values without unsafe integer loss', () => {
  const parseNumeric = types.getTypeParser(1700, 'text');
  const parseDate = types.getTypeParser(1082, 'text');

  assert.equal(parseNumeric('13'), 13);
  assert.equal(parseNumeric('13.5'), 13.5);
  assert.equal(parseNumeric('9007199254740991'), 9007199254740991);
  assert.equal(parseNumeric('9007199254740992'), '9007199254740992');
  assert.equal(parseNumeric('-9007199254740992'), '-9007199254740992');
  assert.equal(parseDate('2026-07-01'), '2026-07-01');
});
