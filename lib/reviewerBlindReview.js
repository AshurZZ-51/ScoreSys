function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function roundPercent(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function scoreParts(dimName) {
  const parts = String(dimName || '').split('::');
  if (parts[0] === 'r1' || parts[0] === 'r2') parts.shift();
  return { dimensionName: parts[0], itemKey: parts[1] || null };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function buildBlindChoiceStats(values, expectedCount, choices = ['approved', 'recheck', 'rejected']) {
  const counts = Object.fromEntries(choices.map((choice) => [choice, 0]));
  for (const value of values || []) {
    if (value && Object.prototype.hasOwnProperty.call(counts, value)) counts[value] += 1;
  }
  const submittedCount = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const percentages = Object.fromEntries(choices.map((choice) => [
    choice,
    submittedCount ? Math.round((counts[choice] / submittedCount) * 100) : 0
  ]));
  return { submittedCount, expectedCount: Number(expectedCount) || 0, counts, percentages };
}

function recommendBlindVerdict(values) {
  const stats = buildBlindChoiceStats(values, 0);
  if (!stats.submittedCount) {
    return { verdict: null, ...stats };
  }

  if (stats.counts.approved > stats.submittedCount / 2) {
    return { verdict: 'approved', ...stats };
  }

  const nonApprovedCount = stats.counts.recheck + stats.counts.rejected;
  const verdict = stats.counts.recheck >= nonApprovedCount / 2 ? 'recheck' : 'rejected';
  return { verdict, ...stats };
}

function buildDimensionAverages({ rules = [], scores = [], reviewerCodes = [] }) {
  const allowed = new Set((reviewerCodes || []).map((code) => String(code).toLowerCase()));
  return rules.map((rule) => {
    const matching = (scores || []).filter((score) => {
      if (allowed.size && !allowed.has(String(score.reviewer_code || '').toLowerCase())) return false;
      const parsed = scoreParts(score.dim_name);
      return parsed.dimensionName === rule.name;
    });
    let averageScore = 0;
    let submittedCount = 0;
    const expectedCount = allowed.size * (rule.type === 'level' ? 1 : rule.items.length);
    if (rule.type === 'level') {
      const values = matching.map((score) => Number(score.score)).filter(Number.isFinite);
      averageScore = median(values);
      submittedCount = values.length;
    } else {
      const itemAverages = (rule.items || []).map((item) => {
        const values = matching
          .filter((score) => scoreParts(score.dim_name).itemKey === item.key)
          .map((score) => Number(score.score))
          .filter(Number.isFinite);
        submittedCount += values.length;
        return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
      });
      const filledItems = itemAverages.filter((_, index) => matching.some((score) => scoreParts(score.dim_name).itemKey === rule.items[index].key));
      averageScore = (filledItems.length ? filledItems.reduce((sum, value) => sum + value, 0) / filledItems.length : 0) * (Number(rule.multiplier) || 1);
    }
    const maxScore = Number(rule.maxScore) || 0;
    return {
      name: rule.name,
      averageScore: round2(averageScore),
      maxScore,
      percentage: maxScore ? roundPercent((averageScore / maxScore) * 100) : 0,
      submittedCount,
      expectedCount
    };
  });
}

function roundBadge(roundId) {
  return String(roundId) === 'r2'
    ? { label: '立项阶段', color: '#15803d', bg: '#dcfce7' }
    : { label: '创意阶段', color: '#2563eb', bg: '#dbeafe' };
}

function attemptBadge(attemptNo) {
  return Number(attemptNo) === 2
    ? { label: '第二次', color: '#b91c1c', bg: '#fee2e2' }
    : { label: '第一次', color: '#a16207', bg: '#fef3c7' };
}

function canSubmitPersonalVerdict({ isAdmin, reviewerCode }) {
  return isAdmin !== true && Boolean(String(reviewerCode || '').trim());
}

function shouldAdvanceProjectWorkflow(reviewerCode) {
  return false;
}

module.exports = {
  buildBlindChoiceStats,
  recommendBlindVerdict,
  buildDimensionAverages,
  roundBadge,
  attemptBadge,
  canSubmitPersonalVerdict,
  shouldAdvanceProjectWorkflow
};
