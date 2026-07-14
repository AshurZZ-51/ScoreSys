const COMPLETED_WALKER_VERDICTS = new Set(['approved', 'recheck', 'rejected']);

function getWalkerVerdict(assignment) {
  const directVerdict = assignment?.walker_verdict ?? assignment?.walkerVerdict ?? assignment?.verdict;
  if (directVerdict !== undefined && directVerdict !== null) return directVerdict;
  const verdictScore = (assignment?.scores || []).find((score) => (
    String(score?.reviewer_code || '').toUpperCase() === 'W'
    && String(score?.dim_name || '').includes('__verdict__')
  ));
  return verdictScore?.comment;
}

function isCompletedReview(assignment) {
  return COMPLETED_WALKER_VERDICTS.has(getWalkerVerdict(assignment));
}

function countCompletedReviews(assignments) {
  return (assignments || []).filter(isCompletedReview).length;
}

function sortMeetingsForAdmin(meetings) {
  return [...(meetings || [])].sort((left, right) => {
    if (Boolean(left.is_current) !== Boolean(right.is_current)) return left.is_current ? -1 : 1;
    return String(right.meeting_date || '').localeCompare(String(left.meeting_date || ''));
  });
}

function deriveProjectDeletionState(request, now = new Date()) {
  if (request?.restored_at) return 'archived';
  if (!request?.purge_after) return 'archived';
  return new Date(request.purge_after).getTime() <= new Date(now).getTime() ? 'purged' : 'purge_pending';
}

function getPurgeAfter(now = new Date()) {
  return new Date(new Date(now).getTime() + 15 * 24 * 60 * 60 * 1000).toISOString();
}

module.exports = {
  isCompletedReview,
  countCompletedReviews,
  sortMeetingsForAdmin,
  deriveProjectDeletionState,
  getPurgeAfter
};
