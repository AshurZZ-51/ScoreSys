const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('PostgreSQL material repositories preserve round-specific rows', () => {
  const workflow = read('lib/db/repositories/projectPoolWorkflow.ts');
  const materials = read('lib/db/repositories/projectMaterials.ts');
  const meetings = read('lib/db/repositories/meetingWorkflow.ts');
  assert.match(workflow, /project_materials \(project_id, item_key, round_no/);
  assert.match(workflow, /ON CONFLICT \(project_id, item_key, round_no\)/);
  assert.match(workflow, /getMaterialStatus\(.*roundNo/);
  assert.match(materials, /SELECT project_id, item_key, round_no/);
    assert.match(meetings, /item_key, round_no/);
  assert.match(meetings, /two_round_v5/);
});

test('PostgreSQL scoring routes support v5 assignments and independent recommendation votes', () => {
  const scores = read('app/api/scores/route.ts');
  const projectPool = read('app/api/project-pool/route.ts');
  const summary = read('app/api/summary/route.ts');
  assert.match(scores, /two_round_v5/);
  assert.match(scores, /__special_vote__/);
  assert.match(projectPool, /recommendBlindVerdict/);
  assert.match(projectPool, /material_progress_by_round/);
  assert.match(summary, /__special_vote__/);
  assert.match(summary, /recommendBlindVerdict/);
});

test('PostgreSQL scoring page keeps the special vote separate from personal verdicts', () => {
  const source = read('app/scoring/page.tsx');
  assert.match(source, /specialVotes/);
  assert.match(source, /__special_vote__/);
  assert.match(source, /getMaterialItemsForRound/);
  assert.match(source, /two_round_v5/);
  assert.match(source, /可与本轮个人评审结论同时选择/);
});
