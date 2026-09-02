const assert = require('node:assert/strict');
const test = require('node:test');
require('../testTypeScript.cjs');

const { listProjectPool } = require('./projectPool.ts');
const { listProjectMaterials } = require('./projectMaterials.ts');
const { getProjectHistory } = require('./projectHistory.ts');
const { createReportSnapshot, getProjectReportData, listReportSnapshots } = require('./reports.ts');

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
  assert.match(materialsExecutor.calls[0].text, /ORDER BY round_no ASC, item_key ASC/);
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

test('project report data aggregates pool project, assignments, and timeline in one query', async () => {
  const executor = executorWith([{
    project: { id: 'pool-1', name: 'Project' },
    assignments: [{ meeting_id: 'meeting-1' }],
    timeline: [{ event_type: 'project_created' }],
  }]);

  const result = await getProjectReportData('pool-1', executor);

  assert.deepEqual(result, {
    project: { id: 'pool-1', name: 'Project' },
    assignments: [{ meeting_id: 'meeting-1' }],
    timeline: [{ event_type: 'project_created' }],
  });
  assert.equal(executor.calls.length, 1);
  assert.deepEqual(executor.calls[0].params, ['pool-1']);
  assert.match(executor.calls[0].text, /jsonb_agg/);
  assert.match(executor.calls[0].text, /project_status_history/);
});

test('report snapshot allocation locks, increments, and inserts in one transaction', async () => {
  const calls = [];
  const snapshot = {
    id: 'snapshot-1', scope_type: 'meeting', scope_id: 'meeting-1', report_type: 'round_1',
    version: 5, payload: { projects: [] }, generated_by: 'admin51', generated_at: new Date(),
  };
  const client = {
    async query(text, params = []) {
      calls.push({ text, params });
      if (/MAX\(version\)/.test(text)) return { rows: [{ version: 5 }], rowCount: 1 };
      if (/INSERT INTO report_snapshots/.test(text)) return { rows: [snapshot], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() { calls.push({ text: 'RELEASE', params: [] }); },
  };
  const connector = { async connect() { calls.push({ text: 'CONNECT', params: [] }); return client; } };

  const result = await createReportSnapshot({
    scopeType: 'meeting', scopeId: 'meeting-1', reportType: 'round_1',
    payload: { projects: [] }, generatedBy: 'admin51',
  }, connector);

  assert.equal(result.version, 5);
  assert.deepEqual(calls.map((call) => call.text), [
    'CONNECT', 'BEGIN',
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    calls[3].text,
    calls[4].text,
    'COMMIT', 'RELEASE',
  ]);
  assert.deepEqual(calls[2].params, ['meeting:meeting-1:round_1']);
  assert.deepEqual(calls[3].params, ['meeting', 'meeting-1', 'round_1']);
  assert.equal(calls[5].text, 'COMMIT');
  assert.deepEqual(calls[5].params, []);
});
