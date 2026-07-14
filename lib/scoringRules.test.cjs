const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('./scoringRules.js');

test('computes item-based dimension score from 0-10 subitems and multiplier', () => {
  const scores = [
    { reviewer_code: 'N', dim_name: 'r1::游戏性::core_gameplay', score: 8 },
    { reviewer_code: 'S', dim_name: 'r1::游戏性::core_gameplay', score: 10 },
    { reviewer_code: 'N', dim_name: 'r1::游戏性::feel_fit', score: 7 },
    { reviewer_code: 'S', dim_name: 'r1::游戏性::feel_fit', score: 9 },
    { reviewer_code: 'N', dim_name: 'r1::游戏性::durability', score: 6 },
    { reviewer_code: 'S', dim_name: 'r1::游戏性::durability', score: 8 },
    { reviewer_code: 'N', dim_name: 'r1::游戏性::depth', score: 9 },
    { reviewer_code: 'S', dim_name: 'r1::游戏性::depth', score: 9 }
  ];

  const result = rules.computeDimensionResult('游戏性', scores);

  assert.equal(result.score, 49.5);
  assert.equal(result.maxScore, 60);
  assert.equal(result.count, 8);
  assert.equal(result.percentage, 83);
});

test('computes innovation as median of selected levels scaled to 40 points', () => {
  const scores = [
    { reviewer_code: 'N', dim_name: 'r1::创新性::level', score: 10 },
    { reviewer_code: 'S', dim_name: 'r1::创新性::level', score: 40 },
    { reviewer_code: 'J', dim_name: 'r1::创新性::level', score: 24 },
    { reviewer_code: 'G', dim_name: 'r1::创新性::level', score: 30 },
    { reviewer_code: 'W', dim_name: 'r1::创新性::level', score: 16 }
  ];

  const result = rules.computeDimensionResult('创新性', scores);

  assert.equal(result.score, 24);
  assert.equal(result.maxScore, 40);
  assert.equal(result.count, 5);
  assert.equal(result.percentage, 60);
});

test('accepts only the current innovation levels', () => {
  const key = 'r1::创新性::level';
  assert.equal(rules.isValidScoreValue(key, 10), true);
  assert.equal(rules.isValidScoreValue(key, 16), true);
  assert.equal(rules.isValidScoreValue(key, 24), true);
  assert.equal(rules.isValidScoreValue(key, 30), true);
  assert.equal(rules.isValidScoreValue(key, 40), true);
  assert.equal(rules.isValidScoreValue(key, 8), false);
  assert.equal(rules.isValidScoreValue(key, 28), false);
});

test('maps previous innovation levels when reading existing scores', () => {
  const scores = [8, 12, 20, 28, 40].map((score, index) => ({
    reviewer_code: `R${index}`,
    dim_name: 'r1::创新性::level',
    score
  }));

  const result = rules.computeDimensionResult('创新性', scores);

  assert.equal(result.score, 24);
  assert.equal(result.count, 5);
});

test('computes round one total from game and innovation with cap at 100', () => {
  const scores = [];
  for (const rule of rules.SCORING_DIMENSIONS.filter((rule) => rule.roundId === 'r1')) {
    if (rule.type === 'items') {
      for (const item of rule.items) {
        scores.push({ reviewer_code: 'N', dim_name: rules.roundScoreKey('r1', rule.name, item.key), score: 10 });
      }
    } else {
      scores.push({ reviewer_code: 'N', dim_name: rules.roundScoreKey('r1', rule.name, 'level'), score: 40 });
    }
  }

  const result = rules.computeRoundProjectScore('r1', scores);

  assert.equal(result.baseScore, 100);
  assert.equal(result.totalScore, 100);
  assert.equal(result.totalMaxScore, 100);
});

test('computes round two total independently from planning, art and risk', () => {
  const scores = [];
  for (const rule of rules.SCORING_DIMENSIONS.filter((rule) => rule.roundId === 'r2')) {
    for (const item of rule.items) {
      scores.push({ reviewer_code: 'N', dim_name: rules.roundScoreKey('r2', rule.name, item.key), score: 10 });
    }
  }

  const result = rules.computeRoundProjectScore('r2', scores);

  assert.equal(result.baseScore, 100);
  assert.equal(result.totalScore, 100);
  assert.equal(result.totalMaxScore, 100);
});

test('computes local round base score from a reviewer score map without bonus', () => {
  const scoreMap = {};
  for (const rule of rules.SCORING_DIMENSIONS.filter((rule) => rule.roundId === 'r1')) {
    if (rule.type === 'items') {
      for (const item of rule.items) {
        scoreMap[rules.roundScoreKey('r1', rule.name, item.key)] = 10;
      }
    } else {
      scoreMap[rules.roundScoreKey('r1', rule.name, 'level')] = 40;
    }
  }
  scoreMap['r1::__bonus__'] = 5;

  const rawInputTotal = Object.values(scoreMap).reduce((sum, value) => sum + value, 0);

  assert.equal(rawInputTotal, 85);
  assert.equal(rules.computeRoundBaseScoreFromScoreMap('r1', scoreMap), 100);
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
  assert.equal(result.score, 30);
  assert.equal(result.count, 4);
});

test('round score keys stay isolated by round', () => {
  assert.equal(rules.parseScoreKey('r1::游戏性::core_gameplay').roundId, 'r1');
  assert.equal(rules.parseScoreKey('r2::项目规划::milestone').roundId, 'r2');
  assert.equal(rules.parseScoreKey('r2::项目规划::milestone').dimensionName, '项目规划');
});
