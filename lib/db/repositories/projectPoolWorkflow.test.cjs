const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
require('../testTypeScript.cjs');

const { assignMeetingProjects, updateProjectStatus } = require('./projectPoolWorkflow.ts');

function connectorWith({ failOn } = {}) {
  const calls = [];
  const client = {
    async query(text, params = []) {
      calls.push({ text, params });
      if (failOn && failOn.test(text)) throw new Error('injected write failure');
      if (/SELECT .*FROM project_pool/.test(text)) return { rows: [{ id: 'pool-1', status: 'ready_r1', latest_verdict: null }], rowCount: 1 };
      if (/UPDATE project_pool/.test(text)) return { rows: [{ id: 'pool-1', status: 'rejected', latest_verdict: 'rejected' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release() { calls.push({ text: 'RELEASE', params: [] }); },
  };
  return { calls, async connect() { calls.push({ text: 'CONNECT', params: [] }); return client; } };
}

test('status mutation rolls back pool and history writes as one transaction', async () => {
  const connector = connectorWith({ failOn: /INSERT INTO project_status_history/ });
  await assert.rejects(
    updateProjectStatus('pool-1', 'rejected', 'manual', 'walker', connector),
    /injected write failure/,
  );
  assert.equal(connector.calls[0].text, 'CONNECT');
  assert.equal(connector.calls[1].text, 'BEGIN');
  assert.match(connector.calls[2].text, /SELECT id, status, latest_verdict FROM project_pool/);
  assert.match(connector.calls[3].text, /UPDATE project_pool SET status/);
  assert.match(connector.calls[4].text, /INSERT INTO project_status_history/);
  assert.equal(connector.calls[5].text, 'ROLLBACK');
  assert.equal(connector.calls[6].text, 'RELEASE');
});

test('multiple assignments roll back the whole request when a later RPC fails', async () => {
  const calls = [];
  let assignmentCalls = 0;
  const client = {
    async query(text, params = []) {
      calls.push({ text, params });
      if (/assign_pool_project_to_meeting/.test(text)) {
        assignmentCalls += 1;
        if (assignmentCalls === 2) throw new Error('second assignment failed');
        return { rows: [{ id: 'meeting-project-1', pool_project_id: params[0] }], rowCount: 1 };
      }
      if (/FROM meetings/.test(text)) return { rows: [{ id: 'meeting-1', status: 'active', deleted_at: null }], rowCount: 1 };
      if (/FROM project_pool/.test(text)) return { rows: [
        { id: 'pool-1', status: 'ready_r1', archived_at: null },
        { id: 'pool-2', status: 'ready_r1', archived_at: null },
      ], rowCount: 2 };
      return { rows: [], rowCount: 0 };
    },
    release() { calls.push({ text: 'RELEASE', params: [] }); },
  };
  const connector = { async connect() { calls.push({ text: 'CONNECT', params: [] }); return client; } };

  await assert.rejects(
    assignMeetingProjects('meeting-1', ['pool-1', 'pool-2'], 'walker', connector),
    /second assignment failed/,
  );
  assert.equal(calls.some((call) => call.text === 'COMMIT'), false);
  assert.equal(calls.filter((call) => call.text === 'ROLLBACK').length, 1);
  assert.equal(calls.at(-1).text, 'RELEASE');
});

for (const routePath of [
  'app/api/meeting-assignments/route.ts',
  'app/api/project-pool/archive/route.ts',
  'app/api/project-pool/[id]/status/route.ts',
  'app/api/project-pool/[id]/announcement/route.ts',
  'app/api/project-pool/route.ts',
  'app/api/project-pool/[id]/materials/route.ts',
]) {
  test(`${routePath} has no Supabase write dependency`, () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', routePath), 'utf8');
    assert.doesNotMatch(source, /supabase/i);
    assert.doesNotMatch(source, /\.from\s*\(['"](project_pool|projects|meetings|reviewers|meeting_reviewers|project_materials|project_status_history|project_deletion_requests)/);
  });
}
