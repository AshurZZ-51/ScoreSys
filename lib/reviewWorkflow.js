const ROUND_IDS = ['r1', 'r2'];

const ROUND_LABELS = {
  r1: '第一轮',
  r2: '第二轮'
};

const ROUND_TITLES = {
  r1: '游戏性/创新性',
  r2: '项目规划/技术&美术/风险预估'
};

const VERDICT_OPTIONS = [
  { value: 'approved', label: '通过', color: '#10b981', bg: '#d1fae5' },
  { value: 'recheck', label: '重评', color: '#f59e0b', bg: '#fef3c7' },
  { value: 'rejected', label: '驳回', color: '#ef4444', bg: '#fee2e2' }
];

const REVIEW_STATUS_OPTIONS = [
  { value: 'draft', label: '草稿中', color: '#64748b', bg: '#f1f5f9' },
  { value: 'material_check', label: '待资料检查', color: '#2563eb', bg: '#dbeafe' },
  { value: 'material_needs_supplement', label: '资料需补充', color: '#d97706', bg: '#fef3c7' },
  { value: 'r1_pending', label: '待第一轮评审', color: '#7c3aed', bg: '#ede9fe' },
  { value: 'r1_scoring', label: '第一轮评审中', color: '#0891b2', bg: '#cffafe' },
  { value: 'r1_pending_verdict', label: '第一轮待结论', color: '#db2777', bg: '#fce7f3' },
  { value: 'r1_approved', label: '第一轮通过', color: '#059669', bg: '#d1fae5' },
  { value: 'r1_recheck', label: '第一轮重评', color: '#d97706', bg: '#fef3c7' },
  { value: 'r1_rejected', label: '第一轮驳回', color: '#dc2626', bg: '#fee2e2' },
  { value: 'r2_pending', label: '待第二轮评审', color: '#7c3aed', bg: '#ede9fe' },
  { value: 'r2_scoring', label: '第二轮评审中', color: '#0891b2', bg: '#cffafe' },
  { value: 'r2_pending_verdict', label: '第二轮待结论', color: '#db2777', bg: '#fce7f3' },
  { value: 'r2_approved', label: '第二轮通过', color: '#059669', bg: '#d1fae5' },
  { value: 'r2_recheck', label: '第二轮重评', color: '#d97706', bg: '#fef3c7' },
  { value: 'r2_rejected', label: '第二轮驳回', color: '#dc2626', bg: '#fee2e2' },
  { value: 'initiation', label: '进入立项流程', color: '#0f766e', bg: '#ccfbf1' },
  { value: 'cancelled', label: '立项取消', color: '#991b1b', bg: '#fee2e2' }
];

const MATERIAL_STATUS_OPTIONS = [
  { value: 'unchecked', label: '未检查', color: '#64748b', bg: '#f1f5f9' },
  { value: 'complete', label: '资料齐全', color: '#059669', bg: '#d1fae5' },
  { value: 'needs_supplement', label: '需补充', color: '#d97706', bg: '#fef3c7' },
  { value: 'returned', label: '退回补充', color: '#dc2626', bg: '#fee2e2' }
];

const MATERIAL_ITEMS = [
  { key: 'basic_info', label: '项目基础信息', required: true },
  { key: 'positioning', label: '项目定位', required: true },
  { key: 'gameplay_plan', label: '产品/玩法方案', required: true },
  { key: 'risk_statement', label: '风险说明', required: true },
  { key: 'initial_plan', label: '初步计划', required: true },
  { key: 'business_model', label: '商业模式规划', required: false },
  { key: 'resource_needs', label: '资源需求', required: false },
  { key: 'competitors', label: '竞品或参考', required: false }
];

const ADMIN_TRACKING_SPECIAL_DIMENSIONS = new Set([
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

function stripRoundPrefix(dimName) {
  const parts = String(dimName || '').split('::');
  return ROUND_IDS.includes(parts[0]) ? parts.slice(1).join('::') : String(dimName || '');
}

function getRoundFromDimName(dimName) {
  const first = String(dimName || '').split('::')[0];
  return ROUND_IDS.includes(first) ? first : null;
}

function optionByValue(options, value, fallbackValue) {
  return options.find((option) => option.value === value)
    || options.find((option) => option.value === fallbackValue)
    || options[0];
}

function getReviewStatus(value) {
  return optionByValue(REVIEW_STATUS_OPTIONS, value, 'draft');
}

function getMaterialStatus(value) {
  return optionByValue(MATERIAL_STATUS_OPTIONS, value, 'unchecked');
}

function getVerdictOption(value) {
  return optionByValue(VERDICT_OPTIONS, value, 'recheck');
}

function nextStatusForVerdict(roundId, verdict) {
  if (roundId === 'r1') {
    if (verdict === 'approved') return 'r1_approved';
    if (verdict === 'recheck') return 'r1_recheck';
    if (verdict === 'rejected') return 'r1_rejected';
  }
  if (roundId === 'r2') {
    if (verdict === 'approved') return 'initiation';
    if (verdict === 'recheck') return 'r2_recheck';
    if (verdict === 'rejected') return 'r2_rejected';
  }
  return 'draft';
}

function defaultRoundForStatus(status) {
  if (String(status || '').startsWith('r2_') || status === 'initiation') return 'r2';
  return 'r1';
}

module.exports = {
  ROUND_IDS,
  ROUND_LABELS,
  ROUND_TITLES,
  VERDICT_OPTIONS,
  REVIEW_STATUS_OPTIONS,
  MATERIAL_STATUS_OPTIONS,
  MATERIAL_ITEMS,
  ADMIN_TRACKING_SPECIAL_DIMENSIONS,
  stripRoundPrefix,
  getRoundFromDimName,
  getReviewStatus,
  getMaterialStatus,
  getVerdictOption,
  nextStatusForVerdict,
  defaultRoundForStatus
};
