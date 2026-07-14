const test = require('node:test');
const assert = require('node:assert/strict');
const workflow = require('./projectPoolWorkflow');

test('project pool constants expose required materials and capacity', () => {
  assert.equal(workflow.PROJECT_POOL_FEATURE_FLAG, 'PROJECT_POOL_V2_ENABLED');
  assert.equal(workflow.MAX_MEETING_ASSIGNMENTS, 12);
  assert.equal(workflow.MATERIAL_ITEMS.filter((item) => item.required).length, 5);
});

test('materials become complete only when every required item is approved', () => {
  const approved = workflow.MATERIAL_ITEMS.map((item) => ({ ...item, status: item.required ? 'approved' : 'missing' }));
  const incomplete = approved.map((item) => item.item_key === 'initial_plan' ? { ...item, status: 'submitted' } : item);

  assert.equal(workflow.getMaterialStatus(approved).value, 'complete');
  assert.equal(workflow.getMaterialStatus(incomplete).value, 'incomplete');
});

test('validates allowed assignment, capacity and materials', () => {
  const ready = { status: 'ready_r1', material_status: 'complete' };
  assert.deepEqual(workflow.validateAssignment(ready, [], 1), { ok: true, attemptNo: 1 });
  assert.match(workflow.validateAssignment({ ...ready, material_status: 'incomplete' }, [], 1).error, /必填资料/);
  assert.match(workflow.validateAssignment(ready, Array(12).fill({}), 1).error, /已满/);
});

test('verdict transition allows one recheck and derives final buckets', () => {
  assert.deepEqual(workflow.transitionForVerdict(1, 1, 'recheck'), {
    ok: true, status: 'r1_recheck_ready', currentRound: 1, currentAttempt: 2, verdict: 'recheck'
  });
  assert.equal(workflow.transitionForVerdict(2, 2, 'recheck').ok, false);
  assert.equal(workflow.resultBucket({ latest_verdict: 'approved', status: 'ready_r2' }), 'approved');
  assert.equal(workflow.resultBucket({ latest_verdict: 'recheck' }), 'recheck');
  assert.equal(workflow.resultBucket({ latest_verdict: 'rejected' }), 'rejected');
});

test('normalizes match keys without fuzzy merges', () => {
  assert.equal(workflow.makeMatchKey(' Ａ 计划 ', ' Walker '), 'a 计划::walker');
  assert.notEqual(workflow.makeMatchKey('A计划', 'Walker'), workflow.makeMatchKey('B计划', 'Walker'));
});
