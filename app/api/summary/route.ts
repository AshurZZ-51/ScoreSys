import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const meetingId = searchParams.get('meetingId');

    if (!meetingId) {
      return NextResponse.json({ error: 'meetingId 必填' }, { status: 400 });
    }

    // 并行查询
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

    // ---- 维度配置 ----
    // 构建 dimConfig：每个维度的总满分 = 所有评委该维度满分之和
    const dimMaxScores: Record<string, number> = {};
    const dimReviewerMap: Record<string, string[]> = {};
    const reviewerDimNames: Record<string, string[]> = {};

    reviewerDims.forEach(rd => {
      // 维度总满分 = 各评委满分之和
      dimMaxScores[rd.dim_name] = (dimMaxScores[rd.dim_name] || 0) + (rd.max_score || 0);
      // 维度对应评委列表
      if (!dimReviewerMap[rd.dim_name]) dimReviewerMap[rd.dim_name] = [];
      dimReviewerMap[rd.dim_name].push(rd.reviewer_code);
      // 每个评委的维度列表
      if (!reviewerDimNames[rd.reviewer_code]) reviewerDimNames[rd.reviewer_code] = [];
      reviewerDimNames[rd.reviewer_code].push(rd.dim_name);
    });

    // dimConfig 数组：供前端/报告使用
    const dimConfig = Object.entries(dimMaxScores).map(([name, maxScore]) => ({
      name,
      maxScore,
      reviewerCount: dimReviewerMap[name]?.length || 0
    }));

    // 总满分 = 各维度满分均值之和（因为我们取平均）
    // 实际上对于 AVG 方式：每个维度的"满分"就是该维度单个评委的满分（假设每个评委同维度满分相同）
    // 更准确：满分 = sum of (each dim's max_score for any single reviewer) - 但各评委可能不同
    // 简化：每个维度取第一个评委的 max_score 作为该维度的满分基准
    const dimMaxForAvg: Record<string, number> = {};
    reviewerDims.forEach(rd => {
      if (dimMaxForAvg[rd.dim_name] === undefined) {
        dimMaxForAvg[rd.dim_name] = rd.max_score || 0;
      }
    });
    const totalMaxScore = Object.values(dimMaxForAvg).reduce((a, b) => a + b, 0);

    // 动态计算：每个项目应有的正常评分条数 = 所有评委的维度总和（不含特殊维度）
    const totalExpectedPerProject = reviewerDims.length;

    // 每个评委负责的维度数量
    const dimCountByReviewer: Record<string, number> = {};
    reviewerDims.forEach(rd => {
      dimCountByReviewer[rd.reviewer_code] = (dimCountByReviewer[rd.reviewer_code] || 0) + 1;
    });

    // 已填写的项目数
    const filledProjectCount = projects.filter(p => p.name && p.submitter).length;

    const projectsWithScores = projects.map(project => {
      const projectScores = scores.filter(s => s.project_id === project.id);

      // 按维度汇总（计算平均分）
      const dimTotals: Record<string, { total: number; avg: number; count: number; maxScore: number; percentage: number; reviewers: string[] }> = {};
      let baseScore = 0;
      let bonusScore = 0;
      const bonusDetails: { reviewer: string; value: number; reason: string }[] = [];

      // 收集每个评委的 problems 和 actions
      const reviewerProblems: { reviewer_code: string; reviewer_name: string; problems: string[] }[] = [];
      const reviewerActions: { reviewer_code: string; reviewer_name: string; actions: string[] }[] = [];
      let verdict: string | null = null;

      projectScores.forEach(s => {
        if (s.dim_name === '__verdict__') {
          verdict = s.comment || null;
          return;
        }
        if (s.dim_name === '__bonus__') {
          bonusScore += Number(s.score);
          bonusDetails.push({
            reviewer: s.reviewer_code,
            value: Number(s.score),
            reason: s.comment || ''
          });
          return;
        }
        if (s.dim_name === '__problems__') {
          if (s.comment && s.comment.trim()) {
            const rName = reviewers.find(r => r.code === s.reviewer_code)?.name || s.reviewer_code;
            reviewerProblems.push({
              reviewer_code: s.reviewer_code,
              reviewer_name: rName,
              problems: s.comment.split('\n').map((l: string) => l.trim()).filter(Boolean)
            });
          }
          return;
        }
        if (s.dim_name === '__actions__') {
          if (s.comment && s.comment.trim()) {
            const rName = reviewers.find(r => r.code === s.reviewer_code)?.name || s.reviewer_code;
            reviewerActions.push({
              reviewer_code: s.reviewer_code,
              reviewer_name: rName,
              actions: s.comment.split('\n').map((l: string) => l.trim()).filter(Boolean)
            });
          }
          return;
        }

        // 正常维度得分
        if (!dimTotals[s.dim_name]) {
          dimTotals[s.dim_name] = {
            total: 0,
            avg: 0,
            count: 0,
            maxScore: dimMaxForAvg[s.dim_name] || 0,
            percentage: 0,
            reviewers: []
          };
        }
        dimTotals[s.dim_name].total += Number(s.score);
        dimTotals[s.dim_name].count += 1;
        dimTotals[s.dim_name].reviewers.push(s.reviewer_code);
      });

      // 计算每个维度的平均分
      Object.entries(dimTotals).forEach(([dimName, d]) => {
        if (d.count > 0) {
          d.avg = Math.round((d.total / d.count) * 100) / 100;
        }
        if (d.maxScore > 0) {
          d.percentage = Math.round((d.avg / d.maxScore) * 100);
        }
        // baseScore = 各维度平均分之和
        baseScore += d.avg;
      });

      const totalScore = baseScore + bonusScore;

      // completionRate 只算正常维度（排除 __bonus__, __problems__, __actions__）
      const normalScoreCount = projectScores.filter(s => !s.dim_name.startsWith('__')).length;

      return {
        ...project,
        dimTotals,
        baseScore: Math.round(baseScore * 100) / 100,
        bonusScore: Math.round(bonusScore * 100) / 100,
        bonusDetails,
        totalScore: Math.round(totalScore * 100) / 100,
        scoreCount: projectScores.length,
        completionRate: totalExpectedPerProject > 0
          ? Math.min(100, Math.round((normalScoreCount / totalExpectedPerProject) * 100))
          : 0,
        reviewerProblems,
        reviewerActions,
        verdict
      };
    });

    // 评委贡献度
    const reviewerStats = reviewers.map(r => {
      const rScores = scores.filter(s => s.reviewer_code === r.code);
      const rNormalScores = rScores.filter(s => !s.dim_name.startsWith('__'));
      const projectsScored = new Set(rNormalScores.map(s => s.project_id)).size;
      const dimCount = dimCountByReviewer[r.code] || 0;
      const dimensions = reviewerDimNames[r.code] || [];
      return {
        code: r.code,
        name: r.name,
        role: r.role,
        is_admin: r.is_admin,
        scoresGiven: rNormalScores.length,
        projectsScored,
        totalGiven: rNormalScores.reduce((sum, s) => sum + Number(s.score), 0),
        expectedScores: dimCount * filledProjectCount,
        dimensions,
        dimMaxTotal: dimensions.reduce((sum, d) => {
          const rd = reviewerDims.find(x => x.reviewer_code === r.code && x.dim_name === d);
          return sum + (rd?.max_score || 0);
        }, 0)
      };
    });

    return NextResponse.json({
      meeting: meetingRes.data,
      projects: projectsWithScores,
      scores,
      reviewers: reviewerStats,
      dimConfig,
      totalMaxScore
    });
  } catch (err: any) {
    console.error('Get summary error:', err);
    return NextResponse.json(
      { error: '获取汇总失败: ' + err.message },
      { status: 500 }
    );
  }
}
