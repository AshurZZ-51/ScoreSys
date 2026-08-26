const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
require('./testTypeScript.cjs');

const {
  createMeetingWorkflow,
  listMeetings,
  updateMeetingWorkflow,
} = require('./repositories/meetingWorkflow.ts');

function normalizedSql(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function transactionHarness(queryResult) {
  const calls = [];
  const committedTables = [];
  let stagedTables = [];
  const client = {
    async query(text, params = []) {
      calls.push({ text, params });
      if (text === 'BEGIN') {
        stagedTables = [];
        return { rows: [], rowCount: 0 };
      }
      if (text === 'COMMIT') {
        committedTables.push(...stagedTables);
        stagedTables = [];
        return { rows: [], rowCount: 0 };
      }
      if (text === 'ROLLBACK') {
        stagedTables = [];
        return { rows: [], rowCount: 0 };
      }

      const write = normalizedSql(text).match(/^(?:INSERT INTO|UPDATE|DELETE FROM) ([a-z_]+)/i);
      if (write) stagedTables.push(write[1]);
      return queryResult(text, params);
    },
    release() {},
  };
  return {
    calls,
    committedTables,
    connector: {
      async connect() {
        calls.push({ text: 'CONNECT', params: [] });
        return client;
      },
    },
  };
}

function quickProject() {
  return {
    name: 'Quick project',
    submitter: 'Owner',
    description: 'Description',
    normalizedName: 'quick project',
    normalizedSubmitter: 'owner',
    matchKey: 'quick project::owner',
    roundNo: 1,
    materials: [{ itemKey: 'basic_info', required: true, status: 'missing' }],
  };
}

test('meeting creation rolls back every table when history insertion fails midway', async () => {
  const harness = transactionHarness(async (text) => {
    const sql = normalizedSql(text);
    if (sql.startsWith('INSERT INTO meetings')) {
      return { rows: [{ id: 'meeting-1', name: 'Review', workflow_version: 'project_pool_v4' }], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO project_pool')) {
      return {
        rows: [{ id: 'pool-quick', name: 'Quick project', submitter: 'Owner', description: 'Description', status: 'ready_r1', archived_at: null }],
        rowCount: 1,
      };
    }
    if (sql.startsWith('INSERT INTO projects')) {
      return { rows: [{ id: 'assignment-1' }], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO project_status_history') && sql.includes('meeting_project_id')) {
      throw new Error('injected history failure');
    }
    return { rows: [], rowCount: 1 };
  });

  await assert.rejects(
    createMeetingWorkflow({
      name: 'Review',
      meetingDate: '2026-08-26',
      deadline: null,
      notes: '',
      projectPoolV2: true,
      poolProjectIds: [],
      quickProjects: [quickProject()],
      templateProjects: [],
      operatorCode: 'ADMIN',
    }, harness.connector),
    /injected history failure/,
  );

  const statements = harness.calls.map((call) => normalizedSql(call.text));
  assert.equal(statements.filter((sql) => sql === 'BEGIN').length, 1);
  assert.equal(statements.filter((sql) => sql === 'ROLLBACK').length, 1);
  assert.equal(statements.includes('COMMIT'), false);
  assert.deepEqual(harness.committedTables, []);
  assert.ok(statements.some((sql) => sql.startsWith('INSERT INTO meetings')));
  assert.ok(statements.some((sql) => sql.startsWith('INSERT INTO meeting_reviewers')));
  assert.ok(statements.some((sql) => sql.startsWith('INSERT INTO project_pool')));
  assert.ok(statements.some((sql) => sql.startsWith('INSERT INTO project_materials')));
  assert.ok(statements.some((sql) => sql.startsWith('INSERT INTO projects')));
  assert.ok(statements.some((sql) => sql.startsWith('UPDATE project_pool')));
});

test('legacy template failure rolls back the meeting and every template row', async () => {
  const harness = transactionHarness(async (text) => {
    const sql = normalizedSql(text);
    if (sql.startsWith('INSERT INTO meetings')) {
      return { rows: [{ id: 'meeting-legacy', name: 'Legacy review', workflow_version: 'legacy_v1' }], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO projects')) throw new Error('injected template failure');
    return { rows: [], rowCount: 0 };
  });

  await assert.rejects(
    createMeetingWorkflow({
      name: 'Legacy review',
      meetingDate: '2026-08-26',
      deadline: null,
      notes: '',
      projectPoolV2: false,
      poolProjectIds: [],
      quickProjects: [],
      templateProjects: [{
        seq_no: 1,
        name: '',
        submitter: '',
        description: '',
        is_template: true,
        problems: [],
        actions: [],
      }],
      operatorCode: 'ADMIN',
    }, harness.connector),
    /injected template failure/,
  );

  assert.deepEqual(harness.committedTables, []);
  assert.deepEqual(
    harness.calls.map((call) => normalizedSql(call.text)).filter((sql) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)),
    ['BEGIN', 'ROLLBACK'],
  );
});

test('setting the current meeting locks and updates it in one parameterized transaction', async () => {
  const updated = { id: 'meeting-2', name: "Name ' kept", is_current: true };
  const harness = transactionHarness(async (text) => {
    const sql = normalizedSql(text);
    if (sql.startsWith('UPDATE meetings') && sql.includes('RETURNING')) {
      return { rows: [updated], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });

  const result = await updateMeetingWorkflow({
    id: 'meeting-2',
    isCurrent: true,
    name: "Name ' kept",
  }, harness.connector);

  assert.deepEqual(result, updated);
  const calls = harness.calls.map((call) => ({ ...call, text: normalizedSql(call.text) }));
  assert.deepEqual(calls.map((call) => call.text === 'CONNECT' ? 'CONNECT' : call.text.split(' ')[0]), [
    'CONNECT', 'BEGIN', 'LOCK', 'UPDATE', 'UPDATE', 'COMMIT',
  ]);
  assert.match(calls[2].text, /^LOCK TABLE meetings /);
  assert.match(calls[3].text, /SET is_current = false/);
  assert.equal(calls[4].text.includes("Name ' kept"), false);
  assert.ok(calls[4].params.includes("Name ' kept"));
  assert.deepEqual(harness.committedTables, ['meetings', 'meetings']);
});

test('meeting listing keeps filters parameterized and meeting-date ordering stable', async () => {
  const calls = [];
  const executor = {
    async query(text, params = []) {
      calls.push({ text, params });
      return { rows: [], rowCount: 0 };
    },
  };

  await listMeetings({ meetingId: "meeting'1", includeDeleted: true }, executor);

  assert.deepEqual(calls[0].params, ["meeting'1"]);
  assert.equal(calls[0].text.includes("meeting'1"), false);
  assert.match(normalizedSql(calls[0].text), /WHERE id = \$1 ORDER BY meeting_date DESC/);
});

test('meetings route has no Supabase access or manual compensation deletes', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'api', 'meetings', 'route.ts'), 'utf8');
  assert.doesNotMatch(source, /supabase/i);
  assert.doesNotMatch(source, /\.delete\s*\(/);
  assert.match(source, /@\/lib\/db\/repositories\/meetingWorkflow/);
});
