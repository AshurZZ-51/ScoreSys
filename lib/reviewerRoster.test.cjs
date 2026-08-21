const test = require('node:test');
const assert = require('node:assert/strict');
const roster = require('./reviewerRoster');

test('includes Ollie and Simon in the scoring roster', () => {
  assert.deepEqual(roster.SCORING_REVIEWERS.filter((reviewer) => ['o', 'si'].includes(reviewer.code)), [
    { code: 'o', name: 'Ollie', role: '运营评委' },
    { code: 'si', name: 'Simon', role: '商务评委' }
  ]);
});

test('meeting reviewer snapshots exclude administrators but include every reviewer', () => {
  const snapshot = roster.buildMeetingReviewerSnapshot([
    { code: 'admin51', name: 'Admin', role: '管理员', is_admin: true },
    { code: 'W', name: 'Walker', role: '制作人', is_admin: false },
    { code: 'o', name: 'Ollie', role: '运营评委', is_admin: false },
    { code: 'si', name: 'Simon', role: '商务评委', is_admin: false }
  ]);

  assert.deepEqual(snapshot.map((reviewer) => reviewer.reviewer_code), ['W', 'o', 'si']);
});
