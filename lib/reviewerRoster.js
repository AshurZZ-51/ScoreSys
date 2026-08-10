const SCORING_REVIEWERS = [
  { code: 'W', name: 'Walker', role: '制作人' },
  { code: 'N', name: 'Nadia', role: '策划评委' },
  { code: 'S', name: 'Simon', role: '技术评委' },
  { code: 'J', name: 'Jarvis', role: '美术评委' },
  { code: 'G', name: 'Gouki', role: '项目评委' },
  { code: 'o', name: 'Ollie', role: '运营评委' },
  { code: 'si', name: 'Simon', role: '商务评委' }
];

function buildMeetingReviewerSnapshot(reviewers = []) {
  return reviewers
    .filter((reviewer) => reviewer && reviewer.is_admin !== true)
    .map((reviewer) => ({
      meeting_id: reviewer.meeting_id,
      reviewer_code: reviewer.code,
      reviewer_name: reviewer.name || '',
      reviewer_role: reviewer.role || ''
    }));
}

module.exports = { SCORING_REVIEWERS, buildMeetingReviewerSnapshot };
