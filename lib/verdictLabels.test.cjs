const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const workflow = require('./reviewWorkflow');
const poolWorkflow = require('./projectPoolWorkflow');

test('uses 不通过 for every current user-facing verdict label', () => {
  assert.equal(workflow.VERDICT_OPTIONS.find((option) => option.value === 'rejected').label, '不通过');
  assert.equal(workflow.REVIEW_STATUS_OPTIONS.find((option) => option.value === 'r1_rejected').label, '第一轮不通过');
  assert.equal(workflow.REVIEW_STATUS_OPTIONS.find((option) => option.value === 'r2_rejected').label, '第二轮不通过');
  assert.equal(poolWorkflow.PROJECT_STATUS_LABELS.rejected, '已不通过');

  const files = [
    'app/admin/V2AdminPage.tsx',
    'app/admin/components/LiveReportPanel.tsx',
    'app/admin/components/MeetingWorkspace.tsx',
    'app/admin/components/ResultPool.tsx',
    'app/report/components/RoundOneReport.tsx',
    'app/report/components/InitiationProjectReport.tsx',
    'docs/2026-09-01-盲评推荐与分轮规则说明.md',
    'docs/评委评分指南.md',
    'docs/评委评分指南.html'
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(source, /驳回/, `${file} still contains the old visible verdict wording`);
  }
});
