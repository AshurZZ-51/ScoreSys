const COMPLETED_WALKER_VERDICTS = new Set(['approved', 'recheck', 'rejected']);
const { expectedInputCountForRound, isNormalScoringKey } = require('./scoringRules');

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
    scoring_version: project.scoring_version || 'two_round_v2',
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

function buildMeetingReviewerStats(summary, projects) {
  const selectedProjects = projects || [];
  const versionByProject = new Map(selectedProjects.map((project) => [
    project.id,
    project.scoring_version === 'two_round_v3' ? 'two_round_v3' : 'two_round_v2'
  ]));
  const selectedIds = new Set(versionByProject.keys());
  return (summary?.reviewers || []).map((reviewer) => {
    if (reviewer.is_admin) return { ...reviewer, scoresGiven: 0, totalGiven: 0, expectedScores: 0 };
    const relevantScores = (summary?.scores || []).filter((score) => (
      score.reviewer_code === reviewer.code
      && selectedIds.has(score.project_id)
      && isNormalScoringKey(score.dim_name, versionByProject.get(score.project_id))
    ));
    const expectedScores = selectedProjects.reduce((total, project) => (
      total + expectedInputCountForRound(`r${Number(project.round_no || 1)}`, versionByProject.get(project.id))
    ), 0);
    return {
      ...reviewer,
      scoresGiven: relevantScores.length,
      totalGiven: relevantScores.reduce((total, score) => total + Number(score.score || 0), 0),
      expectedScores
    };
  });
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
    reviewers: buildMeetingReviewerStats(summary, projects),
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
  buildMeetingReviewerStats,
  buildMeetingReportPayload,
  buildInitiationProjectPayload
};
