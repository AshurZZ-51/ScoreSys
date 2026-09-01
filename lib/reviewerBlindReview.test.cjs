const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildBlindChoiceStats,
  buildDimensionAverages,
  roundBadge,
  attemptBadge,
  canSubmitPersonalVerdict,
  shouldAdvanceProjectWorkflow,
  recommendBlindVerdict
} = require('./reviewerBlindReview');

test('buildBlindChoiceStats excludes blank choices and reports percentages', () => {
  const result = buildBlindChoiceStats(['approved', 'approved', 'rejected', ''], 4);
  assert.deepEqual(result, {
    submittedCount: 3,
    expectedCount: 4,
    counts: { approved: 2, recheck: 0, rejected: 1 },
    percentages: { approved: 67, recheck: 0, rejected: 33 }
  });
});

test('recommends verdicts from submitted votes and ignores absent reviewers', () => {
  assert.equal(recommendBlindVerdict(['approved', 'approved', 'recheck', '']).verdict, 'approved');
  assert.equal(recommendBlindVerdict(['approved', 'recheck']).verdict, 'recheck');
  assert.equal(recommendBlindVerdict(['approved', 'rejected']).verdict, 'rejected');
  assert.equal(recommendBlindVerdict(['recheck', 'rejected', '']).verdict, 'recheck');
  assert.equal(recommendBlindVerdict([]).verdict, null);
});

test('recommendation percentages use only submitted verdicts', () => {
  assert.deepEqual(recommendBlindVerdict(['approved', 'rejected', '']).percentages, {
    approved: 50, recheck: 0, rejected: 50
  });
});

test('buildDimensionAverages returns weighted dimension averages and completion counts', () => {
  const rules = [{
    name: 'Gameplay',
    maxScore: 20,
    type: 'items',
    multiplier: 2,
    items: [{ key: 'core' }, { key: 'depth' }]
  }];
  const scores = [
    { reviewer_code: 'N', dim_name: 'r1::Gameplay::core', score: 8 },
    { reviewer_code: 'N', dim_name: 'r1::Gameplay::depth', score: 6 },
    { reviewer_code: 'J', dim_name: 'r1::Gameplay::core', score: 6 },
    { reviewer_code: 'J', dim_name: 'r1::Gameplay::depth', score: 10 },
    { reviewer_code: 'W', dim_name: 'r1::Gameplay::core', score: 10 }
  ];
  assert.deepEqual(buildDimensionAverages({ rules, scores, reviewerCodes: ['N', 'J'] }), [{
    name: 'Gameplay',
    averageScore: 15,
    maxScore: 20,
    percentage: 75,
    submittedCount: 4,
    expectedCount: 4
  }]);
});

test('round and attempt badges expose confirmed labels and colors', () => {
  assert.deepEqual(roundBadge('r1'), { label: '创意阶段', color: '#2563eb', bg: '#dbeafe' });
  assert.deepEqual(roundBadge('r2'), { label: '立项阶段', color: '#15803d', bg: '#dcfce7' });
  assert.deepEqual(attemptBadge(1), { label: '第一次', color: '#a16207', bg: '#fef3c7' });
  assert.deepEqual(attemptBadge(2), { label: '第二次', color: '#b91c1c', bg: '#fee2e2' });
});

test('every non-admin reviewer can submit a personal verdict without advancing workflow', () => {
  assert.equal(canSubmitPersonalVerdict({ isAdmin: false, reviewerCode: 'W' }), true);
  assert.equal(canSubmitPersonalVerdict({ isAdmin: true, reviewerCode: 'admin51' }), false);
  assert.equal(shouldAdvanceProjectWorkflow('W'), false);
  assert.equal(shouldAdvanceProjectWorkflow('J'), false);
});
