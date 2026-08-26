const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const hostedClientName = ['sup', 'abase'].join('');
require('./testTypeScript.cjs');

const {
  deleteScores,
  hasReviewerDimension,
  submitScoreWorkflow,
} = require('./repositories/scoreWorkflow.ts');

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

function scoreRow(dimName = 'r1::gameplay::quality') {
  return {
    meetingId: 'meeting-1',
    projectId: 'assignment-1',
    reviewerCode: 'W',
    dimName,
    score: 10,
    comment: 'approved',
    updatedAt: '2026-08-26T08:00:00.000Z',
  };
}

test('project-pool verdict rolls back score, assignment and pool writes when history fails', async () => {
  const savedScore = {
    id: 'score-1', meeting_id: 'meeting-1', project_id: 'assignment-1', reviewer_code: 'W',
    dim_name: 'r1::__verdict__', score: 0, comment: 'approved', updated_at: new Date('2026-08-26T08:00:00.000Z'),
  };
  const harness = transactionHarness(async (text) => {
    const sql = normalizedSql(text);
    if (sql.startsWith('INSERT INTO scores')) return { rows: [savedScore], rowCount: 1 };
    if (sql.startsWith('INSERT INTO project_status_history')) throw new Error('injected verdict history failure');
    return { rows: [], rowCount: 1 };
  });

  await assert.rejects(
    submitScoreWorkflow({
      score: scoreRow('r1::__verdict__'),
      followUp: {
        type: 'project_pool_verdict',
        assignmentId: 'assignment-1',
        poolProjectId: 'pool-1',
        status: 'ready_r2',
        currentRound: 2,
        currentAttempt: 1,
        verdict: 'approved',
        meetingId: 'meeting-1',
        operatorCode: 'W',
        note: 'approved',
      },
    }, harness.connector),
    /injected verdict history failure/,
  );

  const statements = harness.calls.map((call) => normalizedSql(call.text));
  assert.equal(statements.filter((sql) => sql === 'BEGIN').length, 1);
  assert.equal(statements.filter((sql) => sql === 'ROLLBACK').length, 1);
  assert.equal(statements.includes('COMMIT'), false);
  assert.deepEqual(harness.committedTables, []);
  assert.ok(statements.some((sql) => sql.startsWith('INSERT INTO scores')));
  assert.ok(statements.some((sql) => sql.startsWith('UPDATE projects')));
  assert.ok(statements.some((sql) => sql.startsWith('UPDATE project_pool')));
});

test('legacy verdict tracking uses the same transaction and parameterized conflict target', async () => {
  const maliciousDim = "__review_status__'); DROP TABLE scores; --";
  const savedScore = { id: 'score-1', dim_name: 'r1::__verdict__' };
  const harness = transactionHarness(async (text) => {
    if (normalizedSql(text).startsWith('INSERT INTO scores')) return { rows: [savedScore], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });

  const result = await submitScoreWorkflow({
    score: scoreRow('r1::__verdict__'),
    followUp: {
      type: 'legacy_verdict',
      trackingScores: [{ ...scoreRow(maliciousDim), score: 0, comment: 'draft' }],
    },
  }, harness.connector);

  assert.deepEqual(result, savedScore);
  const scoreCalls = harness.calls.filter((call) => /^INSERT INTO scores/i.test(normalizedSql(call.text)));
  assert.equal(scoreCalls.length, 2);
  for (const call of scoreCalls) {
    assert.match(normalizedSql(call.text), /ON CONFLICT \(meeting_id, project_id, reviewer_code, dim_name\) DO UPDATE/);
    assert.equal(call.text.includes(maliciousDim), false);
  }
  assert.ok(scoreCalls[1].params.some((value) => String(value).includes(maliciousDim)));
  assert.equal(harness.calls.filter((call) => call.text === 'BEGIN').length, 1);
  assert.equal(harness.calls.filter((call) => call.text === 'COMMIT').length, 1);
});

test('reviewer dimensions and score deletion keep dynamic values out of SQL', async () => {
  const calls = [];
  const executor = {
    async query(text, params = []) {
      calls.push({ text, params });
      return { rows: text.includes('reviewer_dims') ? [{ found: true }] : [], rowCount: 1 };
    },
  };
  const dimension = "risk'); DELETE FROM reviewers; --";

  assert.equal(await hasReviewerDimension('R1', [dimension, '风险性'], executor), true);
  await deleteScores({ meetingId: 'm1', reviewerCode: 'R1', projectId: 'p1' }, executor);

  assert.deepEqual(calls[0].params, ['R1', [dimension, '风险性']]);
  assert.equal(calls[0].text.includes(dimension), false);
  assert.match(normalizedSql(calls[0].text), /dim_name = ANY\(\$2::text\[\]\)/);
  assert.deepEqual(calls[1].params, ['m1', 'R1', 'p1']);
  assert.match(normalizedSql(calls[1].text), /meeting_id = \$1 AND reviewer_code = \$2 AND project_id = \$3/);
});

test('scores route has no hosted client access', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'api', 'scores', 'route.ts'), 'utf8');
  assert.equal(source.toLowerCase().includes(hostedClientName), false);
  assert.match(source, /@\/lib\/db\/repositories\/scoreWorkflow/);
});
