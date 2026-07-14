const SCORING_DIMENSIONS = [
  {
    name: '游戏性',
    maxScore: 60,
    type: 'items',
    roundId: 'r1',
    multiplier: 6,
    items: [
      { key: 'core_gameplay', label: '核心玩法' },
      { key: 'feel_fit', label: '体感适配性' },
      { key: 'durability', label: '可复玩性' },
      { key: 'depth', label: '年龄适配度' }
    ]
  },
  {
    name: '创新性',
    maxScore: 40,
    type: 'level',
    roundId: 'r1',
    levels: [8, 12, 20, 28, 40],
    levelLabels: {
      8: 'L1 平台已有（完全复制）',
      12: 'L2 已有体感标杆',
      20: 'L3 类似标杆',
      28: 'L4 部分原创',
      40: 'L5 完全原创（全自研独创）'
    }
  },
  {
    name: '项目规划',
    maxScore: 40,
    type: 'items',
    roundId: 'r2',
    multiplier: 4,
    items: [
      { key: 'milestone', label: '项目里程碑' },
      { key: 'docs', label: '文档完善程度' },
      { key: 'risk_analysis', label: '风险难点分析' },
      { key: 'budget', label: '项目预算合理性' },
      { key: 'outsourcing', label: '外包方案合理度' }
    ]
  },
  {
    name: '技术&美术',
    maxScore: 30,
    type: 'items',
    roundId: 'r2',
    multiplier: 3,
    items: [
      { key: 'technical_plan', label: '技术方案评审' },
      { key: 'art_plan', label: '美术方案评审' }
    ]
  },
  {
    name: '风险预估',
    maxScore: 30,
    type: 'items',
    roundId: 'r2',
    multiplier: 3,
    items: [
      { key: 'schedule', label: '延期风险' },
      { key: 'direction', label: '方向风险' },
      { key: 'resources', label: '资源风险' },
      { key: 'policy_copyright', label: '政策版权风险' }
    ]
  }
];

const SPECIAL_DIMENSIONS = new Set([
  '__bonus__',
  '__problems__',
  '__actions__',
  '__verdict__',
  '__current_round__',
  '__review_status__',
  '__material_status__',
  '__material_note__',
  '__material_checked_at__',
  '__material_checker__',
  '__r1_retry_count__',
  '__r2_retry_count__',
  '__status_note__',
  '__initiation_created__',
  '__admin_problems__',
  '__admin_actions__'
]);
const DIMENSION_BY_NAME = Object.fromEntries(SCORING_DIMENSIONS.map((rule) => [rule.name, rule]));
const REVIEW_ROUNDS = [
  { id: 'r1', label: '第一轮', title: '游戏性/创新性', dimensions: ['游戏性', '创新性'] },
  { id: 'r2', label: '第二轮', title: '项目规划/技术&美术/风险预估', dimensions: ['项目规划', '技术&美术', '风险预估'] }
];
const ROUND_BY_ID = Object.fromEntries(REVIEW_ROUNDS.map((round) => [round.id, round]));
const DIMENSION_ALIASES = {
  '可玩性': '游戏性',
  '风险性': '风险预估',
  '风险评估': '风险预估'
};

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function scoreKey(dimensionName, itemKey) {
  return `${normalizeDimensionName(dimensionName)}::${itemKey}`;
}

function roundScoreKey(roundId, dimensionName, itemKey) {
  return `${roundId}::${scoreKey(dimensionName, itemKey)}`;
}

function specialScoreKey(roundId, dimName) {
  return roundId ? `${roundId}::${dimName}` : dimName;
}

function normalizeDimensionName(dimensionName) {
  return DIMENSION_ALIASES[dimensionName] || dimensionName;
}

function parseScoreKey(dimName) {
  if (!dimName) return null;
  const parts = String(dimName).split('::');
  const roundId = ROUND_BY_ID[parts[0]] ? parts.shift() : null;
  const rawDimName = parts.join('::');
  if (SPECIAL_DIMENSIONS.has(rawDimName)) return null;
  const [dimensionName, itemKey] = parts;
  const normalizedDimensionName = normalizeDimensionName(dimensionName);
  const rule = DIMENSION_BY_NAME[normalizedDimensionName];
  if (!rule) return null;

  if (!itemKey) {
    return { dimensionName: normalizedDimensionName, itemKey: null, rule, legacy: true };
  }

  if (rule.type === 'level') {
    return itemKey === 'level' ? { roundId, dimensionName: normalizedDimensionName, itemKey, rule, legacy: false } : null;
  }

  const exists = rule.items.some((item) => item.key === itemKey);
  return exists ? { roundId, dimensionName: normalizedDimensionName, itemKey, rule, legacy: false } : null;
}

function getScoreMax(dimName) {
  const baseDimName = String(dimName || '').replace(/^r[12]::/, '');
  if (baseDimName === '__bonus__') return 5;
  if (SPECIAL_DIMENSIONS.has(baseDimName)) return 0;
  const parsed = parseScoreKey(dimName);
  if (!parsed) return null;
  if (parsed.legacy) return parsed.rule.maxScore;
  return parsed.rule.type === 'level' ? parsed.rule.maxScore : 10;
}

function isValidScoreValue(dimName, value) {
  const max = getScoreMax(dimName);
  if (max === null) return false;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max) return false;

  const parsed = parseScoreKey(dimName);
  if (parsed?.rule.type === 'level' && !parsed.legacy) {
    return parsed.rule.levels.includes(n);
  }
  return true;
}

function nearestLevel(value, levels) {
  return levels.reduce((best, current) => {
    const bestDistance = Math.abs(best - value);
    const currentDistance = Math.abs(current - value);
    if (currentDistance < bestDistance) return current;
    if (currentDistance === bestDistance) return Math.max(best, current);
    return best;
  }, levels[0]);
}

function medianLevel(values, levels) {
  if (!values.length) return 0;
  const sorted = [...values].map(Number).sort((a, b) => a - b);
  const middle = sorted.length / 2;
  const rawMedian = sorted.length % 2
    ? sorted[Math.floor(middle)]
    : (sorted[middle - 1] + sorted[middle]) / 2;
  return nearestLevel(rawMedian, levels);
}

function computeDimensionResult(dimensionName, scores) {
  const normalizedDimensionName = normalizeDimensionName(dimensionName);
  const rule = DIMENSION_BY_NAME[normalizedDimensionName];
  if (!rule) {
    return { score: 0, maxScore: 0, count: 0, percentage: 0, itemResults: [] };
  }

  if (rule.type === 'level') {
    const values = scores
      .filter((score) => parseScoreKey(score.dim_name)?.dimensionName === normalizedDimensionName)
      .map((score) => Number(score.score))
      .filter((value) => rule.levels.includes(value));
    const score = medianLevel(values, rule.levels);
    return {
      score,
      avg: score,
      maxScore: rule.maxScore,
      count: values.length,
      total: values.reduce((sum, value) => sum + value, 0),
      percentage: rule.maxScore > 0 ? Math.round((score / rule.maxScore) * 100) : 0,
      itemResults: []
    };
  }

  const itemResults = rule.items.map((item) => {
    const values = scores
      .filter((score) => {
        const parsed = parseScoreKey(score.dim_name);
        return parsed?.dimensionName === normalizedDimensionName && parsed.itemKey === item.key;
      })
      .map((score) => Number(score.score))
      .filter((value) => Number.isFinite(value));
    const avg = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
    return {
      key: item.key,
      label: item.label,
      avg: round2(avg),
      count: values.length,
      total: round2(values.reduce((sum, value) => sum + value, 0))
    };
  });

  const filledItems = itemResults.filter((item) => item.count > 0);
  const itemAverage = filledItems.length
    ? filledItems.reduce((sum, item) => sum + item.avg, 0) / filledItems.length
    : 0;
  const score = round2(itemAverage * rule.multiplier);
  const count = itemResults.reduce((sum, item) => sum + item.count, 0);

  return {
    score,
    avg: score,
    maxScore: rule.maxScore,
    count,
    total: round2(itemResults.reduce((sum, item) => sum + item.total, 0)),
    percentage: rule.maxScore > 0 ? Math.round((score / rule.maxScore) * 100) : 0,
    itemResults
  };
}

function computeProjectScore(scores, bonusScore = 0) {
  const dimTotals = {};
  let baseScore = 0;
  for (const rule of SCORING_DIMENSIONS) {
    const result = computeDimensionResult(rule.name, scores);
    dimTotals[rule.name] = result;
    baseScore += result.score;
  }
  baseScore = round2(baseScore);
  const totalScore = Math.min(100, round2(baseScore + (Number(bonusScore) || 0)));
  return {
    dimTotals,
    baseScore,
    bonusScore: round2(bonusScore),
    totalScore,
    totalMaxScore: 100
  };
}

function computeRoundProjectScore(roundId, scores, bonusScore = 0) {
  const round = ROUND_BY_ID[roundId];
  if (!round) {
    return {
      dimTotals: {},
      baseScore: 0,
      bonusScore: round2(bonusScore),
      totalScore: round2(bonusScore),
      totalMaxScore: 100
    };
  }
  const roundScores = (scores || []).filter((score) => parseScoreKey(score.dim_name)?.roundId === roundId);
  const dimTotals = {};
  let baseScore = 0;
  for (const dimensionName of round.dimensions) {
    const result = computeDimensionResult(dimensionName, roundScores);
    dimTotals[dimensionName] = result;
    baseScore += result.score;
  }
  baseScore = round2(baseScore);
  const totalScore = Math.min(100, round2(baseScore + (Number(bonusScore) || 0)));
  return {
    roundId,
    dimTotals,
    baseScore,
    bonusScore: round2(bonusScore),
    totalScore,
    totalMaxScore: 100
  };
}

function computeWeightedBaseScoreFromScoreMap(scoreMap) {
  const scores = Object.entries(scoreMap || {})
    .filter(([dimName]) => isNormalScoringKey(dimName))
    .map(([dim_name, score]) => ({ dim_name, score }));
  return computeProjectScore(scores).baseScore;
}

function computeRoundBaseScoreFromScoreMap(roundId, scoreMap) {
  const scores = Object.entries(scoreMap || {})
    .filter(([dimName]) => parseScoreKey(dimName)?.roundId === roundId)
    .map(([dim_name, score]) => ({ dim_name, score }));
  return computeRoundProjectScore(roundId, scores).baseScore;
}

function expectedInputCountForDimension(dimensionName) {
  const rule = DIMENSION_BY_NAME[normalizeDimensionName(dimensionName)];
  if (!rule) return 0;
  return rule.type === 'level' ? 1 : rule.items.length;
}

function isNormalScoringKey(dimName) {
  const parsed = parseScoreKey(dimName);
  return Boolean(parsed && !parsed.legacy);
}

module.exports = {
  SCORING_DIMENSIONS,
  REVIEW_ROUNDS,
  ROUND_BY_ID,
  DIMENSION_BY_NAME,
  normalizeDimensionName,
  scoreKey,
  roundScoreKey,
  specialScoreKey,
  parseScoreKey,
  getScoreMax,
  isValidScoreValue,
  computeDimensionResult,
  computeProjectScore,
  computeRoundProjectScore,
  computeWeightedBaseScoreFromScoreMap,
  computeRoundBaseScoreFromScoreMap,
  expectedInputCountForDimension,
  isNormalScoringKey
};
