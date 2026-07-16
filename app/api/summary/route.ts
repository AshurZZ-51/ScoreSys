import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled, supabaseAdmin } from '@/lib/supabase';
import { getMissingTemplateProjects } from '@/lib/projectSlots';
import { requireReviewerSession } from '@/lib/adminSession';
import {
  SCORING_DIMENSIONS,
  REVIEW_ROUNDS,
  ROUND_BY_ID,
  computeProjectScore,
  computeRoundProjectScore,
  expectedInputCountForDimension,
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

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const SPECIAL_DIMENSIONS = new Set(['__bonus__', '__problems__', '__actions__', '__verdict__']);

export async function GET(request: NextRequest) {
  try {
    if (!requireReviewerSession(request)) return NextResponse.json({ error: '请先登录' }, { status: 401 });
    const { searchParams } = new URL(request.url);
    const meetingId = searchParams.get('meetingId');

    if (!meetingId) {
      return NextResponse.json({ error: 'meetingId 必填' }, { status: 400 });
    }

    if (!isProjectPoolV2Enabled()) {
      const { data: existingProjects, error: existingProjectsError } = await supabaseAdmin.from('projects').select('seq_no').eq('meeting_id', meetingId);
      if (existingProjectsError) throw existingProjectsError;
      const missingProjects = getMissingTemplateProjects(existingProjects || [], meetingId);
      if (missingProjects.length > 0) {
        const { error: insertMissingError } = await supabaseAdmin.from('projects').insert(missingProjects);
        if (insertMissingError) throw insertMissingError;
      }
    }

    const [meetingRes, projectsRes, scoresRes, reviewersRes, reviewerDimsRes] = await Promise.all([
      supabaseAdmin.from('meetings').select('id, name, meeting_date, deadline, status, notes').eq('id', meetingId).single(),
      supabaseAdmin.from('projects').select('id, meeting_id, seq_no, name, submitter, description, problems, actions, is_pending, pool_project_id, round_no, attempt_no, scoring_version, assignment_status').eq('meeting_id', meetingId).order('seq_no'),
      supabaseAdmin.from('scores').select('id, meeting_id, project_id, reviewer_code, dim_name, score, comment, updated_at').eq('meeting_id', meetingId),
      supabaseAdmin.from('reviewers').select('code, name, role, is_admin').order('code'),
      supabaseAdmin.from('reviewer_dims').select('reviewer_code, dim_name, max_score')
    ]);

    if (meetingRes.error) throw meetingRes.error;

    const fetchedProjects = projectsRes.data || [];
    const summaryMissingProjects = isProjectPoolV2Enabled() ? [] : getMissingTemplateProjects(fetchedProjects, meetingId).map((project: any) => ({
      ...project,
      id: `missing-slot-${meetingId}-${project.seq_no}`,
      is_pending: false
    }));
    const projects = [...fetchedProjects, ...summaryMissingProjects]
      .sort((a: any, b: any) => Number(a.seq_no) - Number(b.seq_no));
    const scores = scoresRes.data || [];
    const reviewers = reviewersRes.data || [];
    const reviewerDims = reviewerDimsRes.data || [];

    const reviewerDimNames: Record<string, string[]> = {};
    reviewerDims.forEach((rd: any) => {
      if (!reviewerDimNames[rd.reviewer_code]) reviewerDimNames[rd.reviewer_code] = [];
      const dimName = normalizeDimensionName(rd.dim_name);
      if (!reviewerDimNames[rd.reviewer_code].includes(dimName)) {
        reviewerDimNames[rd.reviewer_code].push(dimName);
      }
    });

    const dimConfig = SCORING_DIMENSIONS.map((rule: any) => ({
      name: rule.name,
      maxScore: rule.maxScore,
      type: rule.type,
      roundId: rule.roundId,
      multiplier: rule.multiplier || null,
      items: rule.items || [],
      levels: rule.levels || [],
      levelLabels: rule.levelLabels || {},
      reviewerCount: reviewerDims.filter((rd: any) => normalizeDimensionName(rd.dim_name) === rule.name).length
    }));

    const nonAdminReviewers = reviewers.filter((reviewer: any) => !reviewer.is_admin);
    const expectedByRound: Record<string, number> = {};
    REVIEW_ROUNDS.forEach((round: any) => {
      expectedByRound[round.id] = nonAdminReviewers.length * round.dimensions.reduce((sum: number, dimName: string) => {
        return sum + expectedInputCountForDimension(dimName);
      }, 0);
    });

    const expectedInputsPerReviewer = projects.reduce((total: number, project: any) => {
      if (!project.name || !project.submitter) return total;
      const round = project.scoring_version === 'two_round_v2' && project.round_no
        ? ROUND_BY_ID[`r${project.round_no}`]
        : null;
      if (!round) return total;
      return total + round.dimensions.reduce((sum: number, dimensionName: string) => sum + expectedInputCountForDimension(dimensionName), 0);
    }, 0);

    const projectsWithScores = projects.map((project: any) => {
      const projectScores = scores.filter((s: any) => s.project_id === project.id);
      const normalScores = projectScores.filter((s: any) => isNormalScoringKey(s.dim_name));
      let bonusScore = 0;
      const bonusDetails: { reviewer: string; value: number; reason: string }[] = [];
      const reviewerProblems: { reviewer_code: string; reviewer_name: string; problems: string[] }[] = [];
      const reviewerActions: { reviewer_code: string; reviewer_name: string; actions: string[] }[] = [];
      let verdict: string | null = null;

      const latestSpecialComment = (dimName: string) => {
        const items = projectScores
          .filter((s: any) => s.dim_name === dimName)
          .sort((a: any, b: any) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime());
        const adminItem = items.find((s: any) => reviewers.find((r: any) => r.code === s.reviewer_code)?.is_admin);
        return (adminItem || items[0])?.comment || '';
      };

      const getRoundVerdict = (roundId: string) => {
        const dimName = specialScoreKey(roundId, '__verdict__');
        const verdictScores = projectScores
          .filter((s: any) => s.dim_name === dimName && s.reviewer_code?.toUpperCase() === 'W')
          .sort((a: any, b: any) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime());
        return verdictScores[0]?.comment || null;
      };

      const roundSummaries: Record<string, any> = {};
      REVIEW_ROUNDS.forEach((round: any) => {
        const roundScores = projectScores.filter((s: any) => parseScoreKey(s.dim_name)?.roundId === round.id);
        const roundBonusDetails = projectScores
          .filter((s: any) => s.dim_name === specialScoreKey(round.id, '__bonus__'))
          .map((s: any) => ({ reviewer: s.reviewer_code, value: Number(s.score), reason: s.comment || '' }));
        const roundBonusScore = roundBonusDetails.reduce((sum: number, item: any) => sum + item.value, 0);
        const roundVerdict = getRoundVerdict(round.id);
        const roundProblems: { reviewer_code: string; reviewer_name: string; problems: string[] }[] = [];
        const roundActions: { reviewer_code: string; reviewer_name: string; actions: string[] }[] = [];
        projectScores.forEach((s: any) => {
          if (s.dim_name === specialScoreKey(round.id, '__problems__') && s.comment?.trim()) {
            const rName = reviewers.find((r: any) => r.code === s.reviewer_code)?.name || s.reviewer_code;
            roundProblems.push({
              reviewer_code: s.reviewer_code,
              reviewer_name: rName,
              problems: s.comment.split('\n').map((line: string) => line.trim()).filter(Boolean)
            });
          }
          if (s.dim_name === specialScoreKey(round.id, '__actions__') && s.comment?.trim()) {
            const rName = reviewers.find((r: any) => r.code === s.reviewer_code)?.name || s.reviewer_code;
            roundActions.push({
              reviewer_code: s.reviewer_code,
              reviewer_name: rName,
              actions: s.comment.split('\n').map((line: string) => line.trim()).filter(Boolean)
            });
          }
        });
        const computed = computeRoundProjectScore(round.id, roundScores, roundBonusScore);
        const autoProblems = roundProblems.flatMap((item) => item.problems);
        const autoActions = roundActions.flatMap((item) => item.actions);
        const adminProblems = latestSpecialComment(specialScoreKey(round.id, '__admin_problems__'));
        const adminActions = latestSpecialComment(specialScoreKey(round.id, '__admin_actions__'));
        roundSummaries[round.id] = {
          ...computed,
          label: round.label,
          title: round.title,
          bonusDetails: roundBonusDetails,
          verdict: roundVerdict,
          reviewerProblems: roundProblems,
          reviewerActions: roundActions,
          problemSummary: adminProblems || autoProblems.join('\n'),
          actionSummary: adminActions || autoActions.join('\n'),
          problemSummaryEdited: Boolean(adminProblems),
          actionSummaryEdited: Boolean(adminActions),
          completionRate: expectedByRound[round.id] > 0
            ? Math.min(100, Math.round((roundScores.length / expectedByRound[round.id]) * 100))
            : 0
        };
      });

      const verdictScores = projectScores
        .filter((s: any) => stripRoundPrefix(s.dim_name) === '__verdict__' && s.reviewer_code?.toUpperCase() === 'W')
        .sort((a: any, b: any) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime());
      verdict = verdictScores[0]?.comment || null;

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
      const currentRound = project.scoring_version === 'two_round_v2' && project.round_no
        ? `r${project.round_no}`
        : latestSpecialComment('__current_round__') || defaultRoundForStatus(derivedStatus);
      const hasCurrentRoundScores = projectScores.some(
        (score: any) => parseScoreKey(score.dim_name)?.roundId === currentRound
      );
      const currentRoundSummary = hasCurrentRoundScores ? roundSummaries[currentRound] : null;

      projectScores.forEach((s: any) => {
        if (stripRoundPrefix(s.dim_name) === '__verdict__') return;
        if (s.dim_name === '__bonus__') {
          bonusScore += Number(s.score);
          bonusDetails.push({ reviewer: s.reviewer_code, value: Number(s.score), reason: s.comment || '' });
          return;
        }
        if (s.dim_name === '__problems__' && s.comment?.trim()) {
          const rName = reviewers.find((r: any) => r.code === s.reviewer_code)?.name || s.reviewer_code;
          reviewerProblems.push({
            reviewer_code: s.reviewer_code,
            reviewer_name: rName,
            problems: s.comment.split('\n').map((line: string) => line.trim()).filter(Boolean)
          });
          return;
        }
        if (s.dim_name === '__actions__' && s.comment?.trim()) {
          const rName = reviewers.find((r: any) => r.code === s.reviewer_code)?.name || s.reviewer_code;
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
        walkerVerdict: currentRoundSummary?.verdict || verdict,
        verdict: currentRoundSummary?.verdict || verdict
      };
    });

    const reviewerStats = reviewers.map((r: any) => {
      const rScores = scores.filter((s: any) => s.reviewer_code === r.code);
      const rNormalScores = rScores.filter((s: any) => isNormalScoringKey(s.dim_name));
      const projectsScored = new Set(rNormalScores.map((s: any) => s.project_id)).size;
      const dimensions = reviewerDimNames[r.code] || [];
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
          const rule = SCORING_DIMENSIONS.find((x: any) => x.name === d);
          return sum + (rule?.maxScore || 0);
        }, 0)
      };
    });

    return NextResponse.json(
      {
        meeting: meetingRes.data,
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
