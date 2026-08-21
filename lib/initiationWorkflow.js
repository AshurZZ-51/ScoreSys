const PROJECT_RATING_OPTIONS = ['S', 'A', 'B', 'C'];

function isValidProjectRating(value) {
  return PROJECT_RATING_OPTIONS.includes(String(value || '').trim().toUpperCase());
}

function text(value, fallback = '待补充') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function buildInitiationAnnouncement(input = {}) {
  const rating = String(input.rating || '').trim().toUpperCase();
  return [
    '【立项公示】',
    `项目编号：${text(input.projectCode)}`,
    `项目名称：${text(input.projectName)}`,
    `项目评级：${isValidProjectRating(rating) ? rating : '待评级'}`,
    `批准日期：${text(input.approvedAt)}`,
    `项目团队：${text(input.team)}`,
    `资源配置：${text(input.resources)}`,
    `运营考核指标：${text(input.kpi)}`,
    `招标启动：${text(input.tenderStart)}`,
    `关键里程碑：${text(input.milestones)}`
  ].join('\n');
}

module.exports = {
  PROJECT_RATING_OPTIONS,
  isValidProjectRating,
  buildInitiationAnnouncement
};
