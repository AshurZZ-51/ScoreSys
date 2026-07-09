import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getMissingTemplateProjects } from '@/lib/projectSlots';
import {
  SCORING_DIMENSIONS,
  computeProjectScore,
  expectedInputCountForDimension,
  isNormalScoringKey,
  normalizeDimensionName,
  parseScoreKey
} from '@/lib/scoringRules';

export const dynamic = 'force-dynamic';

const SPECIAL_DIMENSIONS = new Set(['__bonus__', '__problems__', '__actions__', '__verdict__']);

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const meetingId = searchParams.get('meetingId');

    if (!meetingId) {
      return NextResponse.json({ error: 'meetingId 必填' }, { status: 400 });
    }

    const { data: existingProjects, error: existingProjectsError } = await supabaseAdmin
      .from('projects')
      .select('seq_no')
      .eq('meeting_id', meetingId);
    if (existingProjectsError) throw existingProjectsError;
    const missingProjects = getMissingTemplateProjects(existingProjects || [], meetingId);
    if (missingProjects.length > 0) {
      const { error: insertMissingError } = await supabaseAdmin.from('projects').insert(missingProjects);
      if (insertMissingError) throw insertMissingError;
    }

    const [meetingRes, projectsRes, scoresRes, reviewersRes, reviewerDimsRes] = await Promise.all([
      supabaseAdmin.from('meetings').select('id, name, meeting_date, deadline, status, notes').eq('id', meetingId).single(),
      supabaseAdmin.from('projects').select('id, meeting_id, seq_no, name, submitter, description, problems, actions, is_pending').eq('meeting_id', meetingId).order('seq_no'),
      supabaseAdmin.from('scores').select('id, meeting_id, project_id, reviewer_code, dim_name, score, comment, updated_at').eq('meeting_id', meetingId),
      supabaseAdmin.from('reviewers').select('code, name, role, is_admin').order('code'),
      supabaseAdmin.from('reviewer_dims').select('reviewer_code, dim_name, max_score')
    ]);

    if (meetingRes.error) throw meetingRes.error;

    const projects = projectsRes.data || [];
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
      multiplier: rule.multiplier || null,
      items: rule.items || [],
      levels: rule.levels || [],
      levelLabels: rule.levelLabels || {},
      reviewerCount: reviewerDims.filter((rd: any) => normalizeDimensionName(rd.dim_name) === rule.name).length
    }));

    const uniqueReviewerDims = Array.from(new Map(
      reviewerDims.map((rd: any) => [`${rd.reviewer_code}:${normalizeDimensionName(rd.dim_name)}`, {
        ...rd,
        dim_name: normalizeDimensionName(rd.dim_name)
      }])
    ).values());

    const totalExpectedPerProject = uniqueReviewerDims.reduce((sum: number, rd: any) => {
      return sum + expectedInputCountForDimension(rd.dim_name);
    }, 0);

    const expectedByReviewer: Record<string, number> = {};
    uniqueReviewerDims.forEach((rd: any) => {
      expectedByReviewer[rd.reviewer_code] = (expectedByReviewer[rd.reviewer_code] || 0) + expectedInputCountForDimension(rd.dim_name);
    });

    const filledProjectCount = projects.filter((p: any) => p.name && p.submitter).length;

    const projectsWithScores = projects.map((project: any) => {
      const projectScores = scores.filter((s: any) => s.project_id === project.id);
      const normalScores = projectScores.filter((s: any) => isNormalScoringKey(s.dim_name));
      let bonusScore = 0;
      const bonusDetails: { reviewer: string; value: number; reason: string }[] = [];
      const reviewerProblems: { reviewer_code: string; reviewer_name: string; problems: string[] }[] = [];
      const reviewerActions: { reviewer_code: string; reviewer_name: string; actions: string[] }[] = [];
      let verdict: string | null = null;

      const verdictScores = projectScores
        .filter((s: any) => s.dim_name === '__verdict__')
        .sort((a: any, b: any) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime());
      const adminVerdict = verdictScores.find((s: any) => reviewers.find((r: any) => r.code === s.reviewer_code)?.is_admin);
      const walkerVerdict = verdictScores.find((s: any) => s.reviewer_code?.toUpperCase() === 'W');
      verdict = (adminVerdict || walkerVerdict || verdictScores[0])?.comment || null;

      projectScores.forEach((s: any) => {
        if (s.dim_name === '__verdict__') return;
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

      const computed = computeProjectScore(normalScores, bonusScore);

      return {
        ...project,
        dimTotals: computed.dimTotals,
        baseScore: computed.baseScore,
        bonusScore: computed.bonusScore,
        bonusDetails,
        totalScore: computed.totalScore,
        scoreCount: projectScores.length,
        completionRate: totalExpectedPerProject > 0
          ? Math.min(100, Math.round((normalScores.length / totalExpectedPerProject) * 100))
          : 0,
        reviewerProblems,
        reviewerActions,
        verdict
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
        expectedScores: (expectedByReviewer[r.code] || 0) * filledProjectCount,
        dimensions,
        dimMaxTotal: dimensions.reduce((sum: number, d: string) => {
          const rule = SCORING_DIMENSIONS.find((x: any) => x.name === d);
          return sum + (rule?.maxScore || 0);
        }, 0)
      };
    });

    return NextResponse.json({
      meeting: meetingRes.data,
      projects: projectsWithScores,
      scores,
      reviewers: reviewerStats,
      dimConfig,
      totalMaxScore: 100
    });
  } catch (err: any) {
    console.error('Get summary error:', err);
    return NextResponse.json({ error: '获取汇总失败: ' + err.message }, { status: 500 });
  }
}
