const COMPLETED_WALKER_VERDICTS = new Set(['approved', 'recheck', 'rejected']);

function nextSnapshotVersion(snapshots) {
  return (snapshots || []).reduce((highest, snapshot) => {
    const version = Number(snapshot?.version);
    return Number.isInteger(version) && version > highest ? version : highest;
  }, 0) + 1;
}

function isCompletedWalkerReview(project) {
  return COMPLETED_WALKER_VERDICTS.has(project?.walkerVerdict ?? project?.walker_verdict);
}

function roundForReportType(reportType) {
  return reportType === 'round_1' ? 1 : reportType === 'round_2' ? 2 : null;
}

function reportProject(project, rank) {
  return {
    id: project.id,
    pool_project_id: project.pool_project_id || null,
    name: project.name,
    submitter: project.submitter,
    description: project.description || '',
    round_no: Number(project.round_no || 1),
    attempt_no: Number(project.attempt_no || 1),
    rank,
    totalScore: Number(project.totalScore || 0),
    totalMaxScore: Number(project.totalMaxScore || 100),
    baseScore: Number(project.baseScore || 0),
    bonusScore: Number(project.bonusScore || 0),
    completionRate: Number(project.completionRate || 0),
    dimTotals: project.dimTotals || {},
    roundSummaries: project.roundSummaries || {},
    reviewerProblems: project.reviewerProblems || [],
    reviewerActions: project.reviewerActions || [],
    problemSummary: project.problemSummary || project.roundSummaries?.[`r${project.round_no}`]?.problemSummary || '',
    actionSummary: project.actionSummary || project.roundSummaries?.[`r${project.round_no}`]?.actionSummary || '',
    verdict: project.walkerVerdict ?? project.walker_verdict
  };
}

function buildMeetingReportPayload(summary, meeting, reportType) {
  const roundNo = roundForReportType(reportType);
  const projects = (summary?.projects || [])
    .filter((project) => !roundNo || Number(project.round_no || 1) === roundNo)
    .filter(isCompletedWalkerReview)
    .sort((left, right) => Number(right.totalScore || 0) - Number(left.totalScore || 0))
    .map((project, index) => reportProject(project, index + 1));

  return {
    reportType,
    meeting: {
      id: meeting?.id || summary?.meeting?.id,
      name: meeting?.name || summary?.meeting?.name || '',
      meeting_date: meeting?.meeting_date || summary?.meeting?.meeting_date || '',
      notes: meeting?.notes || summary?.meeting?.notes || ''
    },
    round_no: roundNo,
    generatedFrom: 'live_summary',
    reviewers: summary?.reviewers || [],
    projects
  };
}

function buildInitiationProjectPayload(project, summaries, timeline) {
  const roundHistory = (summaries || []).flatMap((summary) => (
    (summary?.projects || [])
      .filter((assignment) => assignment.pool_project_id === project?.id)
      .filter(isCompletedWalkerReview)
      .map((assignment) => {
        const ranked = (summary?.projects || [])
          .filter((candidate) => Number(candidate.round_no || 1) === Number(assignment.round_no || 1))
          .filter(isCompletedWalkerReview)
          .sort((left, right) => Number(right.totalScore || 0) - Number(left.totalScore || 0));
        const rank = ranked.findIndex((candidate) => candidate.id === assignment.id) + 1;
        return {
        ...reportProject(assignment, rank || 0),
        meeting: summary.meeting || {},
        reviewerCount: (summary.reviewers || []).filter((reviewer) => !reviewer.is_admin).length,
        reviewers: (summary.reviewers || []).filter((reviewer) => !reviewer.is_admin).map((reviewer) => ({
          code: reviewer.code,
          name: reviewer.name || reviewer.code,
          role: reviewer.role || '',
          scoresGiven: reviewer.scoresGiven || 0,
          expectedScores: reviewer.expectedScores || 0
        }))
      };
      })
  )).sort((left, right) => Number(left.round_no) - Number(right.round_no));

  return {
    reportType: 'initiation',
    project: {
      id: project?.id,
      name: project?.name || '',
      submitter: project?.submitter || '',
      description: project?.description || '',
      status: project?.status || ''
    },
    roundHistory,
    timeline: timeline || []
  };
}

module.exports = {
  nextSnapshotVersion,
  isCompletedWalkerReview,
  buildMeetingReportPayload,
  buildInitiationProjectPayload
};
