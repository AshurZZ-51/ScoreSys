const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('./scoringRules.js');

test('computes item-based dimension score from 0-10 subitems and multiplier', () => {
  const scores = [
    { reviewer_code: 'N', dim_name: '可玩性::core_gameplay', score: 8 },
    { reviewer_code: 'S', dim_name: '可玩性::core_gameplay', score: 10 },
    { reviewer_code: 'N', dim_name: '可玩性::feel_fit', score: 7 },
    { reviewer_code: 'S', dim_name: '可玩性::feel_fit', score: 9 },
    { reviewer_code: 'N', dim_name: '可玩性::durability', score: 6 },
    { reviewer_code: 'S', dim_name: '可玩性::durability', score: 8 },
    { reviewer_code: 'N', dim_name: '可玩性::depth', score: 9 },
    { reviewer_code: 'S', dim_name: '可玩性::depth', score: 9 }
  ];

  const result = rules.computeDimensionResult('可玩性', scores);

  assert.equal(result.score, 24.75);
  assert.equal(result.maxScore, 30);
  assert.equal(result.count, 8);
  assert.equal(result.percentage, 83);
});

test('computes innovation as median of selected levels 4/6/10/14/20', () => {
  const scores = [
    { reviewer_code: 'N', dim_name: '创新性::level', score: 4 },
    { reviewer_code: 'S', dim_name: '创新性::level', score: 20 },
    { reviewer_code: 'J', dim_name: '创新性::level', score: 10 },
    { reviewer_code: 'G', dim_name: '创新性::level', score: 14 },
    { reviewer_code: 'W', dim_name: '创新性::level', score: 6 }
  ];

  const result = rules.computeDimensionResult('创新性', scores);

  assert.equal(result.score, 10);
  assert.equal(result.maxScore, 20);
  assert.equal(result.count, 5);
  assert.equal(result.percentage, 50);
});

test('computes project total from five weighted dimensions with cap at 100', () => {
  const scores = [];
  for (const rule of rules.SCORING_DIMENSIONS) {
    if (rule.type === 'items') {
      for (const item of rule.items) {
        scores.push({ reviewer_code: 'N', dim_name: `${rule.name}::${item.key}`, score: 10 });
      }
    } else {
      scores.push({ reviewer_code: 'N', dim_name: `${rule.name}::level`, score: 20 });
    }
  }

  const result = rules.computeProjectScore(scores);

  assert.equal(result.baseScore, 100);
  assert.equal(result.totalScore, 100);
  assert.equal(result.totalMaxScore, 100);
});

test('computes local weighted base score from a reviewer score map without bonus', () => {
  const scoreMap = {};
  for (const rule of rules.SCORING_DIMENSIONS) {
    if (rule.type === 'items') {
      for (const item of rule.items) {
        scoreMap[`${rule.name}::${item.key}`] = 10;
      }
    } else {
      scoreMap[`${rule.name}::level`] = 20;
    }
  }
  scoreMap.__bonus__ = 5;

  const rawInputTotal = Object.values(scoreMap).reduce((sum, value) => sum + value, 0);

  assert.equal(rawInputTotal, 175);
  assert.equal(rules.computeWeightedBaseScoreFromScoreMap(scoreMap), 100);
});

test('accepts legacy risk dimension keys as risk assessment scores', () => {
  const riskRule = rules.SCORING_DIMENSIONS[4];
  const scores = riskRule.items.map((item, index) => ({
    reviewer_code: ['W', 'J', 'G', 'W'][index],
    dim_name: `风险性::${item.key}`,
    score: 10
  }));

  assert.equal(rules.normalizeDimensionName('风险性'), riskRule.name);
  assert.equal(rules.parseScoreKey(`风险性::${riskRule.items[0].key}`).dimensionName, riskRule.name);
  const result = rules.computeDimensionResult(riskRule.name, scores);
  assert.equal(result.score, 15);
  assert.equal(result.count, 4);
});
