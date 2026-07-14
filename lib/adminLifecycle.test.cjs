const test = require('node:test');
const assert = require('node:assert/strict');
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
