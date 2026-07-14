const PROJECT_POOL_FEATURE_FLAG = 'PROJECT_POOL_V2_ENABLED';
const MAX_MEETING_ASSIGNMENTS = 12;

const MATERIAL_ITEMS = [
  { item_key: 'basic_info', label: '项目基础信息', required: true },
  { item_key: 'positioning', label: '项目定位', required: true },
  { item_key: 'gameplay_plan', label: '产品/玩法方案', required: true },
  { item_key: 'risk_statement', label: '风险说明', required: true },
  { item_key: 'initial_plan', label: '初步计划', required: true },
  { item_key: 'business_model', label: '商业模式规划', required: false },
  { item_key: 'resource_needs', label: '资源需求', required: false },
  { item_key: 'competitors', label: '竞品或参考', required: false }
];

function normalizeProjectPart(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function makeMatchKey(name, submitter) {
  return `${normalizeProjectPart(name)}::${normalizeProjectPart(submitter)}`;
}

function getMaterialStatus(materials) {
  const statusByKey = new Map((materials || []).map((item) => [item.item_key, item.status]));
  const missing = MATERIAL_ITEMS.filter((item) => item.required && statusByKey.get(item.item_key) !== 'approved');
  return missing.length
    ? { value: 'incomplete', missing: missing.map((item) => item.label) }
    : { value: 'complete', missing: [] };
}

function createMaterialRows(projectId) {
  return MATERIAL_ITEMS.map((item) => ({
    project_id: projectId,
    item_key: item.item_key,
    required: item.required,
    status: 'missing'
  }));
}

function validateAssignment(project, meetingAssignments, roundNo) {
  if (Number(meetingAssignments?.length || 0) >= MAX_MEETING_ASSIGNMENTS) return { ok: false, error: '评审会已满（最多 12 个项目）' };
  if (project.material_status !== 'complete') return { ok: false, error: '必填资料未通过，不能安排评审会' };
  const status = project.status;
  if (roundNo === 1 && status === 'ready_r1') return { ok: true, attemptNo: 1 };
  if (roundNo === 1 && status === 'r1_recheck_ready') return { ok: true, attemptNo: 2 };
  if (roundNo === 2 && status === 'ready_r2') return { ok: true, attemptNo: 1 };
  if (roundNo === 2 && status === 'r2_recheck_ready') return { ok: true, attemptNo: 2 };
  return { ok: false, error: '项目当前状态与评审轮次不匹配' };
}

function transitionForVerdict(roundNo, attemptNo, verdict) {
  if (!['approved', 'recheck', 'rejected'].includes(verdict)) return { ok: false, error: '无效结论' };
  if (attemptNo === 2 && verdict === 'recheck') return { ok: false, error: '本轮重评机会已使用' };
  if (verdict === 'rejected') return { ok: true, status: 'rejected', currentRound: roundNo, currentAttempt: attemptNo, verdict };
  if (verdict === 'recheck') return { ok: true, status: roundNo === 1 ? 'r1_recheck_ready' : 'r2_recheck_ready', currentRound: roundNo, currentAttempt: 2, verdict };
  if (roundNo === 1) return { ok: true, status: 'ready_r2', currentRound: 2, currentAttempt: 1, verdict };
  return { ok: true, status: 'initiation', currentRound: 2, currentAttempt: attemptNo, verdict };
}

function resultBucket(project) {
  if (project.latest_verdict === 'approved') return 'approved';
  if (project.latest_verdict === 'recheck') return 'recheck';
  if (project.latest_verdict === 'rejected') return 'rejected';
  return null;
}

function getAdminViews() {
  return ['pending', 'meetings', 'reports', 'reviewed', 'results'];
}

module.exports = {
  PROJECT_POOL_FEATURE_FLAG,
  MAX_MEETING_ASSIGNMENTS,
  MATERIAL_ITEMS,
  normalizeProjectPart,
  makeMatchKey,
  getMaterialStatus,
  createMaterialRows,
  validateAssignment,
  transitionForVerdict,
  resultBucket,
  getAdminViews
};
