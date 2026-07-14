const COMPLETED_WALKER_VERDICTS = new Set(['approved', 'recheck', 'rejected']);

function isCompletedReview(assignment) {
  const verdict = assignment?.walker_verdict ?? assignment?.walkerVerdict ?? assignment?.verdict;
  return COMPLETED_WALKER_VERDICTS.has(verdict);
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

module.exports = {
  isCompletedReview,
  sortMeetingsForAdmin,
  deriveProjectDeletionState
};
