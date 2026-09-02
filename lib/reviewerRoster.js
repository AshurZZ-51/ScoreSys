// The database and meeting snapshot are the only source of truth for the roster.
// Keep this export for legacy consumers without inventing a second reviewer list.
const SCORING_REVIEWERS = [];

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
