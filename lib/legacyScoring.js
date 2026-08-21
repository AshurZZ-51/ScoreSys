const LEGACY_DIMENSIONS = [
  { name: '可玩性', aliases: ['可玩性', '游戏性'], multiplier: 3 },
  { name: '创新性', aliases: ['创新性'], multiplier: 1 },
  { name: '项目规划', aliases: ['项目规划'], multiplier: 2 },
  { name: '技术&美术', aliases: ['技术&美术', '技术和美术'], multiplier: 1.5 },
  { name: '风险评估', aliases: ['风险评估', '风险性'], multiplier: 1.5 }
];

function legacyDimensionName(value) {
  const prefix = String(value || '').split('::')[0];
  return LEGACY_DIMENSIONS.find((dimension) => dimension.aliases.includes(prefix))?.name || null;
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function computeLegacyProjectScore(scores) {
  const dimensionScores = {};
  for (const dimension of LEGACY_DIMENSIONS) {
    const byReviewer = new Map();
    for (const score of scores || []) {
      if (legacyDimensionName(score.dim_name) !== dimension.name) continue;
      const value = numeric(score.score);
      if (value === null) continue;
      const reviewer = score.reviewer_code || '__unknown__';
      const entries = byReviewer.get(reviewer) || [];
      entries.push(value);
      byReviewer.set(reviewer, entries);
    }
    const reviewerAverages = [...byReviewer.values()].map((values) => values.reduce((sum, value) => sum + value, 0) / values.length);
    const average = reviewerAverages.length ? reviewerAverages.reduce((sum, value) => sum + value, 0) / reviewerAverages.length : 0;
    dimensionScores[dimension.name] = average * dimension.multiplier;
  }
  const totalScore = Object.values(dimensionScores).reduce((sum, value) => sum + value, 0);
  return { dimensionScores, totalScore: Math.min(100, totalScore) };
}

function extractLegacyFeedback(scores) {
  const collect = (key) => (scores || [])
    .filter((score) => score.dim_name === key && String(score.comment || '').trim())
    .map((score) => `${score.reviewer_code || '评委'}：${String(score.comment).trim()}`);
  return { problems: collect('__problems__'), actions: collect('__actions__') };
}

module.exports = { computeLegacyProjectScore, extractLegacyFeedback };
