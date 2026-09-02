import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled } from '@/lib/featureFlags';
import { getMissingTemplateProjects } from '@/lib/projectSlots';
import { requireReviewerSession } from '@/lib/adminSession';
import { getMeetingSummary, listMeetingReviewers } from '@/lib/db/repositories/meetings';
import { listSummaryProjects } from '@/lib/db/repositories/projects';
import { listAllReviewerDimensions, listReviewers } from '@/lib/db/repositories/reviewers';
import { listMeetingProjectRatings, listMeetingScores } from '@/lib/db/repositories/scores';
import {
  SCORING_DIMENSIONS,
  REVIEW_ROUNDS,
  ROUND_BY_ID,
  computeProjectScore,
  computeRoundProjectScore,
  expectedInputCountForDimension,
  expectedInputCountForRound,
  getRoundDefinition,
  getRoundScoringDimensions,
  isNormalScoringKey,
  normalizeDimensionName,
  parseScoreKey,
  specialScoreKey
} from '@/lib/scoringRules';
import {
  defaultRoundForStatus,
  nextStatusForVerdict,
  stripRoundPrefix
} from '@/lib/reviewWorkflow';
import { buildBlindChoiceStats, buildDimensionAverages, recommendBlindVerdict } from '@/lib/reviewerBlindReview';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function resolveAssignmentScoringVersion(value: unknown) {
  return ['two_round_v2', 'two_round_v3', 'two_round_v4', 'two_round_v5'].includes(String(value))
    ? String(value)
    : 'two_round_v2';
}

export async function GET(request: NextRequest) {
  try {
    if (!requireReviewerSession(request)) return NextResponse.json({ error: '请先登录' }, { status: 401 });
    const { searchParams } = new URL(request.url);
    const meetingId = searchParams.get('meetingId');

    if (!meetingId) {
      return NextResponse.json({ error: 'meetingId 必填' }, { status: 400 });
    }

    const [meeting, fetchedProjects, scores, allReviewers, meetingReviewers, reviewerDims, reviewerRatings] = await Promise.all([
      getMeetingSummary(meetingId),
      listSummaryProjects(meetingId),
      listMeetingScores(meetingId),
      listReviewers(),
      listMeetingReviewers(meetingId),
      listAllReviewerDimensions(),
      listMeetingProjectRatings(meetingId).catch(() => []),
    ]);

    const summaryMissingProjects = isProjectPoolV2Enabled() ? [] : getMissingTemplateProjects(fetchedProjects, meetingId).map((project: any) => ({
      ...project,
      id: `missing-slot-${meetingId}-${project.seq_no}`,
      is_pending: false
    }));
    const projects = [...fetchedProjects, ...summaryMissingProjects]
      .sort((a: any, b: any) => Number(a.seq_no) - Number(b.seq_no));
    const scoredReviewerCodes = new Set(scores.filter((score: any) => score.reviewer_code).map((score: any) => String(score.reviewer_code).toLowerCase()));
    const reviewers = meetingReviewers.length
      ? meetingReviewers.map((snapshot: any) => ({
        code: snapshot.reviewer_code,
        name: snapshot.reviewer_name || allReviewers.find((reviewer: any) => reviewer.code === snapshot.reviewer_code)?.name || snapshot.reviewer_code,
        role: snapshot.reviewer_role || allReviewers.find((reviewer: any) => reviewer.code === snapshot.reviewer_code)?.role || '',
        is_admin: false
      }))
      : allReviewers.filter((reviewer: any) => reviewer.is_admin
        || scoredReviewerCodes.has(String(reviewer.code).toLowerCase())
        || !['o', 'si'].includes(String(reviewer.code).toLowerCase()));

    const reviewerDimNames: Record<string, string[]> = {};
    reviewerDims.forEach((rd: any) => {
      if (!reviewerDimNames[rd.reviewer_code]) reviewerDimNames[rd.reviewer_code] = [];
      const dimName = normalizeDimensionName(rd.dim_name);
      if (!reviewerDimNames[rd.reviewer_code].includes(dimName)) {
        reviewerDimNames[rd.reviewer_code].push(dimName);
      }
    });

    const configRules = projects.flatMap((project: any) => getRoundScoringDimensions(`r${Number(project.round_no || 1)}`, resolveAssignmentScoringVersion(project.scoring_version)));
    const dimConfigRules = Array.from(new Map((configRules.length ? configRules : SCORING_DIMENSIONS).map((rule: any) => [rule.name, rule])).values());
    const meetingDimensionNames = dimConfigRules.map((rule: any) => rule.name);
    const dimConfig = dimConfigRules.map((rule: any) => ({
      name: rule.name,
      maxScore: rule.maxScore,
      type: rule.type,
      roundId: rule.roundId,
      multiplier: rule.multiplier || null,
      items: rule.items || [],
      levels: rule.levels || [],
      levelLabels: rule.levelLabels || {},
      reviewerCount: reviewers.filter((reviewer: any) => !reviewer.is_admin).length
    }));

    const nonAdminReviewers = reviewers.filter((reviewer: any) => !reviewer.is_admin);
    const nonAdminReviewerCodes = nonAdminReviewers.map((reviewer: any) => reviewer.code);
    const blindReviewerCodes = nonAdminReviewerCodes;
    const expectedInputsPerReviewer = projects.reduce((total: number, project: any) => {
      if (!project.name || !project.submitter) return total;
      const scoringVersion = resolveAssignmentScoringVersion(project.scoring_version);
      const round = project.round_no
        ? getRoundDefinition(`r${project.round_no}`, scoringVersion)
        : null;
      if (!round) return total;
      return total + expectedInputCountForRound(round.id, scoringVersion);
    }, 0);
    const scoringVersionByProject = new Map(projects.map((project: any) => [
      project.id,
      resolveAssignmentScoringVersion(project.scoring_version)
    ]));

    const projectsWithScores = projects.map((project: any) => {
      const scoringVersion = resolveAssignmentScoringVersion(project.scoring_version);
      const projectScores = scores.filter((s: any) => s.project_id === project.id);
      const normalScores = projectScores.filter((s: any) => isNormalScoringKey(s.dim_name, scoringVersion));
      let bonusScore = 0;
      const bonusDetails: { reviewer: string; value: number; reason: string }[] = [];
      const reviewerProblems: { reviewer_code: string; reviewer_name: string; problems: string[] }[] = [];
      const reviewerActions: { reviewer_code: string; reviewer_name: string; actions: string[] }[] = [];
      let verdict: string | null = null;

      const latestSpecialComment = (dimName: string) => {
        const items = projectScores
          .filter((s: any) => s.dim_name === dimName)
          .sort((a: any, b: any) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime());
        const adminItem = items.find((s: any) => allReviewers.find((r: any) => r.code === s.reviewer_code)?.is_admin);
        return (adminItem || items[0])?.comment || '';
      };

      const roundSummaries: Record<string, any> = {};
      ['r1', 'r2'].forEach((roundId: string) => {
        const round = getRoundDefinition(roundId, scoringVersion);
        if (!round) return;
        const roundScores = projectScores.filter((s: any) => parseScoreKey(s.dim_name, scoringVersion)?.roundId === round.id);
        const roundBonusDetails = projectScores
          .filter((s: any) => s.dim_name === specialScoreKey(round.id, '__bonus__'))
          .map((s: any) => ({ reviewer: s.reviewer_code, value: Number(s.score), reason: s.comment || '' }));
        const roundBonusScore = roundBonusDetails.reduce((sum: number, item: any) => sum + item.value, 0);
        const roundDimensionAverages = buildDimensionAverages({
          rules: getRoundScoringDimensions(round.id, scoringVersion),
          scores: roundScores,
          reviewerCodes: nonAdminReviewerCodes
        });
        const roundNo = Number(round.id.slice(1));
        const attemptNo = Number(project.attempt_no || 1);
        const roundBlindVerdictScores = projectScores.filter((score: any) => (
          score.dim_name === specialScoreKey(round.id, '__verdict__')
          && blindReviewerCodes.some((code: string) => code.toLowerCase() === String(score.reviewer_code || '').toLowerCase())
        ));
        const blindRecommendation = recommendBlindVerdict(roundBlindVerdictScores.map((score: any) => score.comment));
        const adminVerdict = projectScores
          .filter((score: any) => (
            score.dim_name === specialScoreKey(round.id, '__admin_verdict__')
            && allReviewers.some((reviewer: any) => reviewer.code === score.reviewer_code && reviewer.is_admin)
          ))
          .sort((left: any, right: any) => new Date(right.updated_at || 0).getTime() - new Date(left.updated_at || 0).getTime())[0]?.comment || null;
        const specialVotes = projectScores
          .filter((score: any) => (
            score.dim_name === specialScoreKey(round.id, '__special_vote__')
            && Number(score.score) === 1
            && blindReviewerCodes.some((code: string) => code.toLowerCase() === String(score.reviewer_code || '').toLowerCase())
          ))
          .map((score: any) => ({
            reviewer_code: score.reviewer_code,
            reviewer_name: allReviewers.find((reviewer: any) => reviewer.code === score.reviewer_code)?.name || score.reviewer_code,
            updated_at: score.updated_at || null
          }));
        const roundVerdict = adminVerdict || blindRecommendation.verdict || null;
        const roundBlindRatings = reviewerRatings.filter((rating: any) => (
          rating.project_id === project.id
          && Number(rating.round_no) === roundNo
          && Number(rating.attempt_no || 1) === attemptNo
          && blindReviewerCodes.some((code: string) => code.toLowerCase() === String(rating.reviewer_code || '').toLowerCase())
        ));
        const roundProblems: { reviewer_code: string; reviewer_name: string; problems: string[] }[] = [];
        const roundActions: { reviewer_code: string; reviewer_name: string; actions: string[] }[] = [];
        projectScores.forEach((s: any) => {
          if (s.dim_name === specialScoreKey(round.id, '__problems__') && s.comment?.trim()) {
            const rName = allReviewers.find((r: any) => r.code === s.reviewer_code)?.name || s.reviewer_code;
            roundProblems.push({
              reviewer_code: s.reviewer_code,
              reviewer_name: rName,
              problems: s.comment.split('\n').map((line: string) => line.trim()).filter(Boolean)
            });
          }
          if (s.dim_name === specialScoreKey(round.id, '__actions__') && s.comment?.trim()) {
            const rName = allReviewers.find((r: any) => r.code === s.reviewer_code)?.name || s.reviewer_code;
            roundActions.push({
              reviewer_code: s.reviewer_code,
              reviewer_name: rName,
              actions: s.comment.split('\n').map((line: string) => line.trim()).filter(Boolean)
            });
          }
        });
        const computed = computeRoundProjectScore(round.id, roundScores, roundBonusScore, scoringVersion);
        const autoProblems = roundProblems.flatMap((item) => item.problems);
        const autoActions = roundActions.flatMap((item) => item.actions);
        const adminProblems = latestSpecialComment(specialScoreKey(round.id, '__admin_problems__'));
        const adminActions = latestSpecialComment(specialScoreKey(round.id, '__admin_actions__'));
        roundSummaries[round.id] = {
          ...computed,
          label: round.label,
          title: round.title,
          dimensionAverages: roundDimensionAverages,
          blindRatingStats: buildBlindChoiceStats(
            roundBlindRatings.map((rating: any) => rating.rating),
            blindReviewerCodes.length,
            ['S', 'A', 'B', 'C']
          ),
          blindVerdictStats: buildBlindChoiceStats(
            roundBlindVerdictScores.map((score: any) => score.comment),
            blindReviewerCodes.length
          ),
          recommendedVerdict: blindRecommendation.verdict,
          adminVerdict,
          specialVotes,
          bonusDetails: roundBonusDetails,
          verdict: roundVerdict,
          reviewerProblems: roundProblems,
          reviewerActions: roundActions,
          problemSummary: adminProblems || autoProblems.join('\n'),
          actionSummary: adminActions || autoActions.join('\n'),
          problemSummaryEdited: Boolean(adminProblems),
          actionSummaryEdited: Boolean(adminActions),
          completionRate: nonAdminReviewers.length * expectedInputCountForRound(round.id, scoringVersion) > 0
            ? Math.min(100, Math.round((roundScores.length / (nonAdminReviewers.length * expectedInputCountForRound(round.id, scoringVersion))) * 100))
            : 0
        };
      });

      verdict = (project.round_no ? roundSummaries[`r${project.round_no}`]?.verdict : null)
        || roundSummaries.r2?.verdict
        || roundSummaries.r1?.verdict
        || null;

      const materialStatus = latestSpecialComment('__material_status__') || 'unchecked';
      const materialNote = latestSpecialComment('__material_note__');
      const materialCheckedAt = latestSpecialComment('__material_checked_at__');
      const materialChecker = latestSpecialComment('__material_checker__');
      const savedStatus = latestSpecialComment('__review_status__');
      const r1Verdict = roundSummaries.r1?.verdict;
      const r2Verdict = roundSummaries.r2?.verdict;
      const derivedStatus = savedStatus
        || (r2Verdict ? nextStatusForVerdict('r2', r2Verdict)
          : r1Verdict === 'approved' ? 'r2_pending'
            : r1Verdict ? nextStatusForVerdict('r1', r1Verdict)
              : project.name && project.submitter ? 'r1_pending' : 'draft');
      const currentRound = project.round_no
        ? `r${project.round_no}`
        : latestSpecialComment('__current_round__') || defaultRoundForStatus(derivedStatus);
      const hasCurrentRoundScores = projectScores.some(
        (score: any) => parseScoreKey(score.dim_name, scoringVersion)?.roundId === currentRound
      );
      const currentRoundSummary = hasCurrentRoundScores ? roundSummaries[currentRound] : null;

      projectScores.forEach((s: any) => {
        if (stripRoundPrefix(s.dim_name) === '__verdict__' || stripRoundPrefix(s.dim_name) === '__admin_verdict__' || stripRoundPrefix(s.dim_name) === '__special_vote__') return;
        if (s.dim_name === '__bonus__') {
          bonusScore += Number(s.score);
          bonusDetails.push({ reviewer: s.reviewer_code, value: Number(s.score), reason: s.comment || '' });
          return;
        }
        if (s.dim_name === '__problems__' && s.comment?.trim()) {
          const rName = allReviewers.find((r: any) => r.code === s.reviewer_code)?.name || s.reviewer_code;
          reviewerProblems.push({
            reviewer_code: s.reviewer_code,
            reviewer_name: rName,
            problems: s.comment.split('\n').map((line: string) => line.trim()).filter(Boolean)
          });
          return;
        }
        if (s.dim_name === '__actions__' && s.comment?.trim()) {
          const rName = allReviewers.find((r: any) => r.code === s.reviewer_code)?.name || s.reviewer_code;
          reviewerActions.push({
            reviewer_code: s.reviewer_code,
            reviewer_name: rName,
            actions: s.comment.split('\n').map((line: string) => line.trim()).filter(Boolean)
          });
        }
      });

      const computed = currentRoundSummary || computeProjectScore(normalScores, bonusScore);
      const legacyProblemSummary = latestSpecialComment('__admin_problems__')
        || reviewerProblems.flatMap((item) => item.problems).join('\n');
      const legacyActionSummary = latestSpecialComment('__admin_actions__')
        || reviewerActions.flatMap((item) => item.actions).join('\n');

      return {
        ...project,
        currentRound,
        reviewStatus: derivedStatus,
        materialStatus,
        materialNote,
        materialCheckedAt,
        materialChecker,
        roundSummaries,
        dimTotals: currentRoundSummary?.dimTotals || computed.dimTotals,
        dimensionAverages: currentRoundSummary?.dimensionAverages || [],
        baseScore: currentRoundSummary?.baseScore ?? computed.baseScore,
        bonusScore: currentRoundSummary?.bonusScore ?? computed.bonusScore,
        bonusDetails: currentRoundSummary?.bonusDetails || bonusDetails,
        totalScore: currentRoundSummary?.totalScore ?? computed.totalScore,
        scoreCount: projectScores.length,
        completionRate: currentRoundSummary?.completionRate || 0,
        reviewerProblems: currentRoundSummary?.reviewerProblems || reviewerProblems,
        reviewerActions: currentRoundSummary?.reviewerActions || reviewerActions,
        problemSummary: currentRoundSummary?.problemSummary || legacyProblemSummary,
        actionSummary: currentRoundSummary?.actionSummary || legacyActionSummary,
        walkerVerdict: null,
        recommendedVerdict: currentRoundSummary?.recommendedVerdict || roundSummaries[currentRound]?.recommendedVerdict || null,
        adminVerdict: currentRoundSummary?.adminVerdict || roundSummaries[currentRound]?.adminVerdict || null,
        specialVotes: currentRoundSummary?.specialVotes || roundSummaries[currentRound]?.specialVotes || [],
        verdict: currentRoundSummary?.verdict || verdict
      };
    });

    const reviewerStats = reviewers.map((r: any) => {
      const rScores = scores.filter((s: any) => s.reviewer_code === r.code);
      const rNormalScores = rScores.filter((s: any) => isNormalScoringKey(
        s.dim_name,
        scoringVersionByProject.get(s.project_id) || 'two_round_v2'
      ));
      const projectsScored = new Set(rNormalScores.map((s: any) => s.project_id)).size;
      const dimensions = r.is_admin ? [] : meetingDimensionNames;
      return {
        code: r.code,
        name: r.name,
        role: r.role,
        is_admin: r.is_admin,
        scoresGiven: rNormalScores.length,
        projectsScored,
        totalGiven: rNormalScores.reduce((sum: number, s: any) => sum + Number(s.score), 0),
        expectedScores: r.is_admin ? 0 : expectedInputsPerReviewer,
        dimensions,
        dimMaxTotal: dimensions.reduce((sum: number, d: string) => {
          const rule = dimConfigRules.find((x: any) => x.name === d);
          return sum + (rule?.maxScore || 0);
        }, 0)
      };
    });

    return NextResponse.json(
      {
        meeting,
        projects: projectsWithScores,
        scores,
        reviewers: reviewerStats,
        dimConfig,
        totalMaxScore: 100
      },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } }
    );
  } catch (err: any) {
    console.error('Get summary error:', err);
    return NextResponse.json({ error: '获取汇总失败: ' + err.message }, { status: 500 });
  }
}
