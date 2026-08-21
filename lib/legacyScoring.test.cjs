const test = require('node:test');
const assert = require('node:assert/strict');
const { computeLegacyProjectScore, extractLegacyFeedback } = require('./legacyScoring');

test('legacy scores retain the old five-dimension 100-point calculation', () => {
  const scores = [
    { reviewer_code: 'W', dim_name: '可玩性::core', score: 10 },
    { reviewer_code: 'W', dim_name: '创新性', score: 20 },
    { reviewer_code: 'W', dim_name: '项目规划::plan', score: 10 },
    { reviewer_code: 'W', dim_name: '技术&美术::tech', score: 10 },
    { reviewer_code: 'W', dim_name: '风险性::risk', score: 10 }
  ];
  const result = computeLegacyProjectScore(scores);
  assert.equal(result.totalScore, 100);
  assert.equal(result.dimensionScores['创新性'], 20);
});

test('legacy feedback extracts saved issues and actions without losing reviewers', () => {
  const feedback = extractLegacyFeedback([
    { reviewer_code: 'Jarvis', dim_name: '__problems__', comment: '缺少关键风险说明' },
    { reviewer_code: 'Gouki', dim_name: '__actions__', comment: '补充版本计划' }
  ]);
  assert.deepEqual(feedback.problems, ['Jarvis：缺少关键风险说明']);
  assert.deepEqual(feedback.actions, ['Gouki：补充版本计划']);
});
