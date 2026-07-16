const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const workflow = require('./projectPoolWorkflow');

test('project pool constants expose required materials and capacity', () => {
  assert.equal(workflow.PROJECT_POOL_FEATURE_FLAG, 'PROJECT_POOL_V2_ENABLED');
  assert.equal(workflow.MAX_MEETING_ASSIGNMENTS, 12);
  assert.equal(workflow.MATERIAL_ITEMS.filter((item) => item.required).length, 5);
});

test('labels the required initial-plan material as budget and schedule planning', () => {
  assert.equal(workflow.MATERIAL_ITEMS.find((item) => item.item_key === 'initial_plan').label, '项目预算与排期计划');
});

test('materials become complete when every required item is submitted or exempt', () => {
  const complete = workflow.MATERIAL_ITEMS.map((item) => ({ ...item, status: item.required ? 'submitted' : 'missing' }));
  const incomplete = complete.map((item) => item.item_key === 'initial_plan' ? { ...item, status: 'needs_completion' } : item);

  assert.equal(workflow.getMaterialStatus(complete).value, 'complete');
  assert.equal(workflow.getMaterialStatus(incomplete).value, 'incomplete');
});

test('optional materials do not affect material completeness', () => {
  const materials = workflow.MATERIAL_ITEMS.map((item) => ({
    ...item,
    status: item.required ? 'exempt' : 'needs_completion'
  }));

  assert.deepEqual(workflow.getMaterialStatus(materials), { value: 'complete', missing: [] });
});

test('material progress exposes the required approval count for list displays', () => {
  const materials = workflow.MATERIAL_ITEMS.map((item) => ({ ...item, status: item.item_key === 'basic_info' ? 'submitted' : 'missing' }));
  assert.deepEqual(workflow.getMaterialProgress(materials), { approved: 1, total: 5, complete: false });
});

test('project workflow statuses have Chinese display labels', () => {
  assert.equal(workflow.projectStatusLabel('ready_r2'), '第二轮待安排');
  assert.equal(workflow.projectStatusLabel('unknown_status'), 'unknown_status');
});

test('validates allowed assignment and capacity without material completeness rejection', () => {
  const ready = { status: 'ready_r1', material_status: 'incomplete' };
  assert.deepEqual(workflow.validateAssignment(ready, [], 1), { ok: true, attemptNo: 1 });
  assert.deepEqual(workflow.validateAssignment({ status: 'materials_pending', material_status: 'incomplete' }, [], 1), { ok: true, attemptNo: 1 });
  assert.match(workflow.validateAssignment(ready, Array(12).fill({}), 1).error, /已满/);
});

test('derives each scheduled project round from its own workflow status', () => {
  assert.equal(workflow.assignmentRoundForStatus('ready_r1'), 1);
  assert.equal(workflow.assignmentRoundForStatus('r1_recheck_ready'), 1);
  assert.equal(workflow.assignmentRoundForStatus('ready_r2'), 2);
  assert.equal(workflow.assignmentRoundForStatus('r2_recheck_ready'), 2);
});

test('selects project text fields required when creating meeting assignments', () => {
  assert.match(workflow.MEETING_ASSIGNMENT_PROJECT_FIELDS, /\bname\b/);
  assert.match(workflow.MEETING_ASSIGNMENT_PROJECT_FIELDS, /\bsubmitter\b/);
  assert.match(workflow.MEETING_ASSIGNMENT_PROJECT_FIELDS, /\bdescription\b/);
});

test('keeps every named project assigned to the current meeting visible despite a Walker verdict', () => {
  const projects = [
    { id: 'r2-approved', name: '第二轮项目', submitter: '提报人', reviewStatus: 'initiation' },
    { id: 'r2-rejected', name: '驳回项目', submitter: '提报人', reviewStatus: 'rejected' },
    { id: 'empty-slot', name: '', submitter: '', reviewStatus: 'r1_scoring' }
  ];

  assert.deepEqual(workflow.getReviewableMeetingProjects(projects).map((project) => project.id), ['r2-approved', 'r2-rejected']);
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

test('creates database material rows without UI-only labels', () => {
  const rows = workflow.createMaterialRows('project-1');
  assert.equal(rows.length, 8);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['item_key', 'project_id', 'required', 'status']);
  assert.equal(rows[0].project_id, 'project-1');
  assert.equal(rows[0].status, 'missing');
});

test('accepts only V3 material statuses', () => {
  for (const status of ['missing', 'needs_completion', 'submitted', 'exempt']) {
    assert.equal(workflow.isMaterialStatus(status), true);
  }
  for (const status of ['approved', 'needs_revision', '', null]) {
    assert.equal(workflow.isMaterialStatus(status), false);
  }
});

test('serializes meeting capacity checks with a target meeting row lock', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'MIGRATION_ADMIN_LIFECYCLE_V3.sql'), 'utf8');
  const lock = 'FROM meetings WHERE id = p_meeting_id FOR UPDATE';
  const count = 'SELECT count(*) INTO assignment_count FROM projects WHERE meeting_id = p_meeting_id';

  assert.ok(migration.includes(lock));
  assert.ok(migration.indexOf(lock) < migration.indexOf(count));
});
