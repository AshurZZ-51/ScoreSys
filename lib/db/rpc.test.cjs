const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
require('./testTypeScript.cjs');

const {
  applyProjectPoolMutations,
  applyProjectRating,
  assignPoolProjectToMeeting,
  findReviewerByCode,
  purgeDueProjectDeletions,
} = require('./repositories/rpc.ts');
const { BusinessRuleError } = require('./errors.ts');

function executorWith(rows = []) {
  const calls = [];
  return {
    calls,
    async query(text, params = []) {
      calls.push({ text, params });
      return { rows, rowCount: rows.length };
    },
  };
}

function connectorWith(rows = []) {
  const calls = [];
  const client = {
    async query(text, params = []) {
      calls.push({ text, params });
      return { rows, rowCount: rows.length };
    },
    release() {},
  };
  return {
    calls,
    async connect() {
      calls.push({ text: 'CONNECT', params: [] });
      return client;
    },
  };
}

test('applyProjectPoolMutations preserves the migration argument order', async () => {
  const executor = executorWith([{ project_id: 'p1' }]);

  await applyProjectPoolMutations(
    ['p1'],
    'status',
    'ready_r1',
    'walker',
    'manual update',
    executor,
  );

  assert.deepEqual(executor.calls, [{
    text: 'SELECT * FROM apply_project_pool_mutations($1::uuid[], $2::text, $3::text, $4::text, $5::text)',
    params: [['p1'], 'status', 'ready_r1', 'walker', 'manual update'],
  }]);
});

test('purgeDueProjectDeletions uses a transaction-local 120 second timeout', async () => {
  const connector = connectorWith([{ project_id: 'p1' }]);

  const rows = await purgeDueProjectDeletions(connector);

  assert.deepEqual(rows, [{ project_id: 'p1' }]);
  assert.deepEqual(connector.calls.map((call) => call.text), [
    'CONNECT',
    'BEGIN',
    "SET LOCAL statement_timeout = '120s'",
    'SELECT * FROM purge_due_project_deletions()',
    'COMMIT',
  ]);
  assert.deepEqual(connector.calls[2].params, []);
});

test('applyProjectRating preserves the migration argument order and returns one row', async () => {
  const project = { id: 'p1', final_rating: 'A' };
  const executor = executorWith([project]);

  const result = await applyProjectRating('p1', 'final', 'S', 'walker', executor);

  assert.deepEqual(result, project);
  assert.deepEqual(executor.calls, [{
    text: 'SELECT * FROM apply_project_rating($1::uuid, $2::text, $3::text, $4::text)',
    params: ['p1', 'final', 'S', 'walker'],
  }]);
});

test('assignPoolProjectToMeeting preserves the migration argument order and returns one row', async () => {
  const project = { id: 'meeting-project-1' };
  const executor = executorWith([project]);

  const result = await assignPoolProjectToMeeting('pool-1', 'meeting-1', 2, 'walker', executor);

  assert.deepEqual(result, project);
  assert.deepEqual(executor.calls, [{
    text: 'SELECT * FROM assign_pool_project_to_meeting($1::uuid, $2::uuid, $3::smallint, $4::text)',
    params: ['pool-1', 'meeting-1', 2, 'walker'],
  }]);
});

test('P0001 keeps the database message as a BusinessRuleError', async () => {
  const executor = {
    async query() {
      throw { code: 'P0001', message: 'Invalid project status' };
    },
  };

  await assert.rejects(
    applyProjectPoolMutations(['p1'], 'status', 'not-a-status', 'walker', '', executor),
    (error) => error instanceof BusinessRuleError && error.message === 'Invalid project status',
  );
});

test('findReviewerByCode uses a parameterized typed query', async () => {
  const executor = executorWith([{ code: 'walker', is_admin: true }]);

  const result = await findReviewerByCode('Walker', executor);

  assert.deepEqual(result, { code: 'walker', is_admin: true });
  assert.deepEqual(executor.calls, [{
    text: 'SELECT code, is_admin FROM reviewers WHERE lower(code) = lower($1::text) LIMIT 1',
    params: ['Walker'],
  }]);
});

for (const routePath of [
  'app/api/project-pool/batch/route.ts',
  'app/api/project-pool/purge/route.ts',
  'app/api/project-pool/[id]/rating/route.ts',
]) {
  test(`${routePath} has no Supabase or rpc calls`, () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', routePath), 'utf8');
    assert.doesNotMatch(source, /supabase/i);
    assert.doesNotMatch(source, /\.rpc\s*\(/);
  });
}
