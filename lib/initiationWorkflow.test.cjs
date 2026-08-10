const test = require('node:test');
const assert = require('node:assert/strict');
const workflow = require('./initiationWorkflow');

test('accepts only S/A/B/C project ratings', () => {
  for (const rating of workflow.PROJECT_RATING_OPTIONS) assert.equal(workflow.isValidProjectRating(rating), true);
  assert.equal(workflow.isValidProjectRating('D'), false);
  assert.equal(workflow.isValidProjectRating(''), false);
});

test('builds a copyable initiation announcement from project facts', () => {
  const text = workflow.buildInitiationAnnouncement({
    projectCode: 'P-001',
    projectName: '星火计划',
    rating: 'A',
    approvedAt: '2026-08-10',
    team: '项目组 A',
    resources: '预算 100 万',
    kpi: '首月留存 30%',
    tenderStart: '2026-08-15',
    milestones: '9 月完成原型'
  });

  assert.match(text, /P-001/);
  assert.match(text, /星火计划/);
  assert.match(text, /评级：A/);
  assert.match(text, /首月留存 30%/);
  assert.match(text, /招标启动：2026-08-15/);
});
