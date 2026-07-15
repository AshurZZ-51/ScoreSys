const test = require('node:test');
const assert = require('node:assert/strict');
const reports = require('./reportSnapshots');

test('snapshot versions increment without replacing earlier versions', () => {
  const existing = [{ version: 1, payload: { projects: ['first'] } }, { version: 2, payload: { projects: ['second'] } }];

  assert.equal(reports.nextSnapshotVersion(existing), 3);
  assert.deepEqual(existing[0].payload, { projects: ['first'] });
});

test('meeting report rankings contain only completed Walker verdicts', () => {
  const payload = reports.buildMeetingReportPayload({
    meeting: { id: 'm1', name: '第一轮评审会' },
    reviewers: [{ code: 'W', name: 'Walker' }],
    projects: [
      { id: 'draft', name: '未结论', totalScore: 99, verdict: null, round_no: 1 },
      { id: 'admin-only', name: '管理员结论', totalScore: 98, verdict: 'approved', walkerVerdict: null, round_no: 1 },
      { id: 'low', name: '已完成低分', totalScore: 70, walkerVerdict: 'approved', round_no: 1 },
      { id: 'high', name: '已完成高分', totalScore: 90, walkerVerdict: 'recheck', round_no: 1 }
    ]
  }, { id: 'm1', name: '第一轮评审会' }, 'round_1');

  assert.deepEqual(payload.projects.map((project) => project.id), ['high', 'low']);
  assert.equal(payload.projects[0].rank, 1);
  assert.equal(payload.projects[0].verdict, 'recheck');
});

test('initiation report retains the completed history for both rounds', () => {
  const payload = reports.buildInitiationProjectPayload({ id: 'pool-1', name: '立项项目', submitter: '提报人' }, [
    { meeting: { id: 'm1', name: '第一轮' }, projects: [{ id: 'r1', pool_project_id: 'pool-1', round_no: 1, walkerVerdict: 'approved', totalScore: 81 }] },
    { meeting: { id: 'm2', name: '第二轮' }, projects: [{ id: 'r2', pool_project_id: 'pool-1', round_no: 2, walkerVerdict: 'approved', totalScore: 86 }] },
    { meeting: { id: 'm3', name: '未结论' }, projects: [{ id: 'draft', pool_project_id: 'pool-1', round_no: 2, walkerVerdict: null, totalScore: 100 }] }
  ], [{ event_type: 'walker_verdict', created_at: '2026-07-14T12:00:00.000Z' }]);

  assert.deepEqual(payload.roundHistory.map((entry) => entry.round_no), [1, 2]);
  assert.equal(payload.roundHistory[1].meeting.name, '第二轮');
  assert.equal(payload.timeline.length, 1);
});

test('initiation report keeps decision evidence and meeting context for a complete project review record', () => {
  const payload = reports.buildInitiationProjectPayload({ id: 'pool-2', name: '项目', submitter: '提报人' }, [
    {
      meeting: { id: 'm1', name: '评审会', meeting_date: '2026-07-15', deadline: '2026-07-16T12:00:00Z', notes: '会议备注' },
      reviewers: [{ code: 'W', name: 'Walker' }],
      projects: [{ pool_project_id: 'pool-2', round_no: 1, attempt_no: 1, walkerVerdict: 'approved', totalScore: 88, dimTotals: { playability: { score: 44, max: 60 } }, problemSummary: '问题', actionSummary: '行动', completionRate: 100 }]
    }
  ], []);

  assert.equal(payload.roundHistory[0].meeting.deadline, '2026-07-16T12:00:00Z');
  assert.equal(payload.roundHistory[0].problemSummary, '问题');
  assert.equal(payload.roundHistory[0].reviewerCount, 1);
  assert.equal(payload.roundHistory[0].rank, 1);
  assert.equal(payload.roundHistory[0].dimTotals.playability.score, 44);
});
