const assert = require('node:assert/strict');
const test = require('node:test');
require('../testTypeScript.cjs');

const { listProjectPool } = require('./projectPool.ts');
const { listProjectMaterials } = require('./projectMaterials.ts');
const { getProjectHistory } = require('./projectHistory.ts');
const { listReportSnapshots } = require('./reports.ts');

function executorWith(rows) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      return { rows, rowCount: rows.length };
    },
  };
}

test('project pool list keeps nested arrays and sends month values as parameters', async () => {
  const executor = executorWith([{ project: { id: 'pool-1', project_materials: [], project_deletion_requests: [], projects: [] } }]);

  const rows = await listProjectPool({
    scope: 'active',
    monthStart: '2026-02-01T00:00:00.000Z',
    monthEnd: '2026-03-01T00:00:00.000Z',
  }, executor);

  assert.equal(rows[0].id, 'pool-1');
  assert.deepEqual(rows[0].project_materials, []);
  assert.deepEqual(rows[0].project_deletion_requests, []);
  assert.deepEqual(rows[0].projects, []);
  assert.equal(executor.calls.length, 1);
  assert.deepEqual(executor.calls[0].params, ['2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z']);
  assert.match(executor.calls[0].text, /ORDER BY p\.updated_at DESC/);
  assert.doesNotMatch(executor.calls[0].text, /2026-02/);
});

test('project pool rejects unallowlisted scopes before building SQL', async () => {
  const executor = executorWith([]);
  await assert.rejects(
    listProjectPool({ scope: "active' OR 1=1 --" }, executor),
    (error) => error.status === 400,
  );
  assert.equal(executor.calls.length, 0);
});

test('materials and reports use one ordered parameterized query each', async () => {
  const materialsExecutor = executorWith([]);
  const reportsExecutor = executorWith([]);

  assert.deepEqual(await listProjectMaterials('pool-1', materialsExecutor), []);
  assert.deepEqual(await listReportSnapshots({ scopeType: 'meeting', scopeId: 'meeting-1', reportType: 'round_1' }, reportsExecutor), []);

  assert.equal(materialsExecutor.calls.length, 1);
  assert.deepEqual(materialsExecutor.calls[0].params, ['pool-1']);
  assert.match(materialsExecutor.calls[0].text, /ORDER BY item_key ASC/);
  assert.equal(reportsExecutor.calls.length, 1);
  assert.deepEqual(reportsExecutor.calls[0].params, ['meeting', 'meeting-1', 'round_1']);
  assert.match(reportsExecutor.calls[0].text, /ORDER BY version DESC/);
});

test('history detail is a single query with empty nested arrays', async () => {
  const executor = executorWith([{
    project: { id: 'pool-1', project_materials: [], rating_history: [] },
    history: [],
    assignments: [],
    rating_history: [],
  }]);

  const result = await getProjectHistory('pool-1', executor);

  assert.deepEqual(result.project.project_materials, []);
  assert.deepEqual(result.history, []);
  assert.deepEqual(result.assignments, []);
  assert.deepEqual(result.rating_history, []);
  assert.equal(executor.calls.length, 1);
  assert.deepEqual(executor.calls[0].params, ['pool-1']);
  assert.match(executor.calls[0].text, /jsonb_agg/);
  assert.match(executor.calls[0].text, /ORDER BY .*created_at DESC/);
  assert.match(executor.calls[0].text, /ORDER BY .*created_at ASC/);
});

test('history detail reports a missing project as a 404 database error', async () => {
  await assert.rejects(
    getProjectHistory('missing', executorWith([])),
    (error) => error.status === 404,
  );
});
