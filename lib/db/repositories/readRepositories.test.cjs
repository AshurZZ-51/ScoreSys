const assert = require('node:assert/strict');
const test = require('node:test');
require('../testTypeScript.cjs');

const reviewers = require('./reviewers.ts');
const meetings = require('./meetings.ts');
const projects = require('./projects.ts');
const scores = require('./scores.ts');

function executorWith(rows = []) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      return { rows, rowCount: rows.length };
    },
  };
}

function normalizedSql(text) {
  return text.replace(/\s+/g, ' ').trim();
}

test('reviewer login lookup escapes ILIKE metacharacters and keeps the code out of SQL', async () => {
  const executor = executorWith([{ code: 'A%_\\B', name: 'Reviewer', role: null, is_admin: false, password_hash: 'pw' }]);

  await reviewers.findReviewerByCode('A%_\\B', executor);

  assert.deepEqual(executor.calls[0].params, ['A\\%\\_\\\\B']);
  assert.match(normalizedSql(executor.calls[0].text), /code ILIKE \$1 ESCAPE/);
  assert.equal(executor.calls[0].text.includes('A%_\\B'), false);
});

test('reviewer dimensions preserve descending max score order', async () => {
  const executor = executorWith([]);
  await reviewers.listReviewerDimensions('W', executor);
  assert.deepEqual(executor.calls[0].params, ['W']);
  assert.match(normalizedSql(executor.calls[0].text), /WHERE reviewer_code = \$1 ORDER BY max_score DESC/);
});

test('meeting summary lookup is parameterized', async () => {
  const executor = executorWith([{ id: 'meeting-1' }]);
  await meetings.getMeetingSummary('meeting-1', executor);
  assert.deepEqual(executor.calls[0].params, ['meeting-1']);
  assert.equal(executor.calls[0].text.includes('meeting-1'), false);
});

test('projects meeting and reviewer filters are parameterized and ordered by sequence', async () => {
  const executor = executorWith([]);
  await projects.listMeetingProjects({ meetingId: "m' OR true --", reviewerOnly: true }, executor);
  const call = executor.calls[0];
  assert.deepEqual(call.params, ["m' OR true --"]);
  assert.match(normalizedSql(call.text), /meeting_id = \$1/);
  assert.match(normalizedSql(call.text), /name <> '' AND submitter <> ''/);
  assert.match(normalizedSql(call.text), /ORDER BY seq_no/);
  assert.equal(call.text.includes("m' OR true --"), false);
});

test('scores use stable placeholders for optional reviewer and project filters', async () => {
  const executor = executorWith([]);
  await scores.listScores({ meetingId: 'm1', reviewerCode: 'r1', projectId: 'p1' }, executor);
  const call = executor.calls[0];
  assert.deepEqual(call.params, ['m1', 'r1', 'p1']);
  assert.match(normalizedSql(call.text), /meeting_id = \$1 AND reviewer_code = \$2 AND project_id = \$3/);
});

test('result projects aggregate materials in one query and preserve updated ordering', async () => {
  const executor = executorWith([]);
  await projects.listResultProjects({ bucket: 'approved' }, executor);
  const call = executor.calls[0];
  assert.deepEqual(call.params, ['approved']);
  assert.match(normalizedSql(call.text), /LEFT JOIN project_materials/);
  assert.match(normalizedSql(call.text), /jsonb_agg/);
  assert.match(normalizedSql(call.text), /latest_verdict = \$1/);
  assert.match(normalizedSql(call.text), /ORDER BY .*updated_at DESC/);
  assert.equal(executor.calls.length, 1);
});

test('personal ratings parameterize meeting, reviewer, and optional project filters', async () => {
  const executor = executorWith([]);
  await scores.listProjectRatings({ meetingId: 'm1', reviewerCode: 'R', projectId: 'p1' }, executor);
  const call = executor.calls[0];
  assert.deepEqual(call.params, ['m1', 'R', 'p1']);
  assert.match(normalizedSql(call.text), /meeting_id = \$1 AND reviewer_code = \$2 AND project_id = \$3/);
});

test('project rating writes use the assignment snapshot conflict key', async () => {
  const executor = executorWith([{
    id: 'rating-1', meeting_id: 'm1', project_id: 'p1', reviewer_code: 'R',
    round_no: 2, attempt_no: 1, rating: 'A', created_at: new Date(), updated_at: new Date(),
  }]);

  await scores.getProjectRatingAssignment('m1', 'p1', executor);
  await scores.findMeetingReviewerSnapshot('m1', 'R', executor);
  await scores.upsertProjectRating({
    meetingId: 'm1', projectId: 'p1', reviewerCode: 'R', roundNo: 2, attemptNo: 1,
    rating: 'A', updatedAt: '2026-08-27T00:00:00.000Z',
  }, executor);

  assert.deepEqual(executor.calls[0].params, ['p1', 'm1']);
  assert.deepEqual(executor.calls[1].params, ['m1', 'R']);
  assert.deepEqual(executor.calls[2].params, ['m1', 'p1', 'R', 2, 1, 'A', '2026-08-27T00:00:00.000Z']);
  assert.match(normalizedSql(executor.calls[2].text), /ON CONFLICT \(meeting_id, project_id, reviewer_code, round_no, attempt_no\) DO UPDATE/);
});
