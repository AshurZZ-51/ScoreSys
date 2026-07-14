const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lifecycle = require('./adminLifecycle');

test('isCompletedReview only accepts completed Walker verdicts', () => {
  for (const verdict of ['approved', 'recheck', 'rejected']) {
    assert.equal(lifecycle.isCompletedReview({ walker_verdict: verdict }), true);
  }
  for (const verdict of [null, undefined, '', 'pending', 'approved_by_admin']) {
    assert.equal(lifecycle.isCompletedReview({ walker_verdict: verdict }), false);
  }
});

test('sortMeetingsForAdmin puts the current meeting first and others by date descending', () => {
  const meetings = [
    { id: 'old', meeting_date: '2026-01-01', is_current: false },
    { id: 'current', meeting_date: '2025-01-01', is_current: true },
    { id: 'new', meeting_date: '2026-06-01', is_current: false }
  ];

  assert.deepEqual(lifecycle.sortMeetingsForAdmin(meetings).map((meeting) => meeting.id), ['current', 'new', 'old']);
  assert.equal(meetings[0].id, 'old');
});

test('deriveProjectDeletionState distinguishes restored, pending, and due requests', () => {
  const now = new Date('2026-07-20T00:00:00.000Z');
  assert.equal(lifecycle.deriveProjectDeletionState({ purge_after: '2026-07-29T00:00:00.000Z', restored_at: null }, now), 'purge_pending');
  assert.equal(lifecycle.deriveProjectDeletionState({ purge_after: '2026-07-19T00:00:00.000Z', restored_at: null }, now), 'purged');
  assert.equal(lifecycle.deriveProjectDeletionState({ purge_after: '2026-07-19T00:00:00.000Z', restored_at: '2026-07-18T00:00:00.000Z' }, now), 'archived');
});

test('getPurgeAfter creates an exactly fifteen-day recovery window', () => {
  assert.equal(
    lifecycle.getPurgeAfter(new Date('2026-07-14T12:00:00.000Z')),
    '2026-07-29T12:00:00.000Z'
  );
});

test('countCompletedReviews only counts Walker verdict assignments', () => {
  const assignments = [
    { scores: [{ reviewer_code: 'A', dim_name: '__verdict__', comment: 'approved' }] },
    { scores: [{ reviewer_code: 'W', dim_name: '__verdict__', comment: 'recheck' }] },
    { scores: [{ reviewer_code: 'W', dim_name: '__verdict__', comment: 'pending' }] },
    { scores: [{ reviewer_code: 'W', dim_name: 'r2:__verdict__', comment: 'rejected' }] }
  ];

  assert.equal(lifecycle.countCompletedReviews(assignments), 2);
});

test('project drawer overlay dismisses only direct overlay clicks', () => {
  const drawerPath = path.join(__dirname, '..', 'app', 'admin', 'components', 'ProjectDrawer.tsx');
  const source = fs.existsSync(drawerPath) ? fs.readFileSync(drawerPath, 'utf8') : '';

  assert.match(source, /onMouseDown=\{\(event\) => \{\s*if \(event\.target !== event\.currentTarget\) return;\s*onDismiss\(\);\s*\}\}/);
});
