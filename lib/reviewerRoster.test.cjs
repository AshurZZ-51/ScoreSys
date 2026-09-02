const test = require('node:test');
const assert = require('node:assert/strict');
const roster = require('./reviewerRoster');

test('does not hardcode a scoring roster outside the database snapshot', () => {
  assert.deepEqual(roster.SCORING_REVIEWERS, []);
});

test('does not inject Nadia into the reviewer roster', () => {
  assert.equal(roster.SCORING_REVIEWERS.some((reviewer) => reviewer.name === 'Nadia'), false);
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
