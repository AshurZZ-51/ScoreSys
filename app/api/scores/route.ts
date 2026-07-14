import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled, supabaseAdmin } from '@/lib/supabase';
import { transitionForVerdict } from '@/lib/projectPoolWorkflow';
import { getScoreMax, isValidScoreValue, parseScoreKey } from '@/lib/scoringRules';
import { requireReviewerSession } from '@/lib/adminSession';
import {
  ADMIN_TRACKING_SPECIAL_DIMENSIONS,
  getRoundFromDimName,
  nextStatusForVerdict,
  stripRoundPrefix
} from '@/lib/reviewWorkflow';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const meetingId = searchParams.get('meetingId');
    const reviewerCode = searchParams.get('reviewerCode');
    const projectId = searchParams.get('projectId');

    if (!meetingId) {
      return NextResponse.json({ error: 'meetingId 必填' }, { status: 400 });
    }

    let query = supabaseAdmin
      .from('scores')
      .select('id, meeting_id, project_id, reviewer_code, dim_name, score, comment, updated_at')
      .eq('meeting_id', meetingId);

    if (reviewerCode) query = query.eq('reviewer_code', reviewerCode);
    if (projectId) query = query.eq('project_id', projectId);

    const { data: scores, error } = await query;
    if (error) throw error;

    return NextResponse.json({ scores: scores || [] });
  } catch (err: any) {
    return NextResponse.json({ error: '获取评分失败: ' + err.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { meeting_id, project_id, reviewer_code, dim_name, score, comment } = body;

    const session = requireReviewerSession(request);
    if (!session || String(reviewer_code || '').trim().toLowerCase() !== session.code) {
      return NextResponse.json({ error: '登录身份与评分人不一致' }, { status: 403 });
    }

    if (!meeting_id || !project_id || !reviewer_code || !dim_name || score === undefined) {
      return NextResponse.json({ error: '参数不完整' }, { status: 400 });
    }

    const { data: meeting } = await supabaseAdmin
      .from('meetings')
      .select('deadline, status')
      .eq('id', meeting_id)
      .single();

    if (!meeting) return NextResponse.json({ error: '评审会不存在' }, { status: 404 });

    if (meeting.status === 'archived' || meeting.status === 'locked') {
      return NextResponse.json({ error: '该评审会已锁定/归档，无法修改' }, { status: 403 });
    }

    if (meeting.deadline && new Date() > new Date(meeting.deadline)) {
      return NextResponse.json({ error: '已超过打分截止日期' }, { status: 403 });
    }

    const { data: assignment } = await supabaseAdmin
      .from('projects')
      .select('id, pool_project_id, round_no, attempt_no, scoring_version, assignment_status')
      .eq('id', project_id)
      .eq('meeting_id', meeting_id)
      .maybeSingle();
    if (!assignment) return NextResponse.json({ error: '评审项目不存在' }, { status: 404 });
    const isV2Assignment = isProjectPoolV2Enabled() && assignment.scoring_version === 'two_round_v2';

    const { data: reviewerInfo } = await supabaseAdmin
      .from('reviewers')
      .select('is_admin')
      .eq('code', reviewer_code)
      .single();

    const baseDimName = stripRoundPrefix(dim_name);
    const parsedScore = parseScoreKey(dim_name);

    if (isV2Assignment && parsedScore?.roundId !== `r${assignment.round_no}` && !baseDimName.startsWith('__')) {
      return NextResponse.json({ error: '该项目不属于当前评分轮次' }, { status: 400 });
    }
    if (isV2Assignment && !reviewerInfo?.is_admin) {
      const { data: snapshot } = await supabaseAdmin.from('meeting_reviewers').select('reviewer_code').eq('meeting_id', meeting_id).eq('reviewer_code', reviewer_code).maybeSingle();
      if (!snapshot) return NextResponse.json({ error: '您不在本场评审会的评委名单中' }, { status: 403 });
    }

    if (baseDimName === '__bonus__') {
      if (reviewer_code.toUpperCase() !== 'W') {
        return NextResponse.json({ error: '只有 Walker 可以使用加分项' }, { status: 403 });
      }
    } else if (baseDimName === '__verdict__') {
      if (reviewer_code.toUpperCase() !== 'W' && !reviewerInfo?.is_admin) {
        return NextResponse.json({ error: '只有 Walker 或管理员可以设置评审结论' }, { status: 403 });
      }
      if (isV2Assignment && reviewer_code.toUpperCase() !== 'W') return NextResponse.json({ error: '新版评审结论只能由 Walker 给出' }, { status: 403 });
    } else if (baseDimName === '__problems__' || baseDimName === '__actions__') {
      // Text-only review fields reuse the score table.
    } else if (ADMIN_TRACKING_SPECIAL_DIMENSIONS.has(baseDimName)) {
      if (!reviewerInfo?.is_admin) {
        return NextResponse.json({ error: '只有管理员可以更新项目追踪字段' }, { status: 403 });
      }
    } else if (parsedScore?.roundId) {
      if (reviewerInfo?.is_admin) {
        return NextResponse.json({ error: '管理员账号不参与评委评分' }, { status: 403 });
      }
    } else {
      const parentDimension = parsedScore?.dimensionName || dim_name;
      const { data: reviewerDim } = await supabaseAdmin
        .from('reviewer_dims')
        .select('max_score')
        .eq('reviewer_code', reviewer_code)
        .in('dim_name', parentDimension === '风险评估' ? [parentDimension, '风险性'] : [parentDimension])
        .maybeSingle();

      if (!reviewerDim) {
        return NextResponse.json({ error: '您没有该维度的评分权限' }, { status: 403 });
      }
    }

    const maxScore = getScoreMax(dim_name);
    if (maxScore === null) {
      return NextResponse.json({ error: '未知评分项' }, { status: 400 });
    }

    const scoreNum = Number(score);
    if (!isValidScoreValue(dim_name, scoreNum)) {
      const parsed = parseScoreKey(dim_name);
      const hint = parsed?.rule?.type === 'level' && !parsed.legacy
        ? `必须选择 ${parsed.rule.levels.join('/')} 档位`
        : `分数必须在 0-${maxScore} 之间`;
      return NextResponse.json({ error: hint }, { status: 400 });
    }

    const { data, error } = await supabaseAdmin
      .from('scores')
      .upsert({
        meeting_id,
        project_id,
        reviewer_code,
        dim_name,
        score: scoreNum,
        comment: comment || null,
        updated_at: new Date().toISOString()
      }, { onConflict: 'meeting_id,project_id,reviewer_code,dim_name' })
      .select()
      .single();

    if (error) throw error;

    if (baseDimName === '__verdict__' && comment && isV2Assignment) {
      const transition = transitionForVerdict(Number(assignment.round_no), Number(assignment.attempt_no), comment);
      if (!transition.ok) return NextResponse.json({ error: transition.error }, { status: 400 });
      const nextAssignmentStatus = 'completed';
      const { error: assignmentError } = await supabaseAdmin.from('projects').update({ assignment_status: nextAssignmentStatus }).eq('id', project_id);
      if (assignmentError) throw assignmentError;
      const { error: poolError } = await supabaseAdmin.from('project_pool').update({
        status: transition.status, current_round: transition.currentRound, current_attempt: transition.currentAttempt,
        latest_verdict: transition.verdict, updated_at: new Date().toISOString()
      }).eq('id', assignment.pool_project_id);
      if (poolError) throw poolError;
      const { error: historyError } = await supabaseAdmin.from('project_status_history').insert({
        project_id: assignment.pool_project_id, meeting_project_id: project_id, meeting_id,
        event_type: 'walker_verdict', to_status: transition.status, operator_code: reviewer_code, note: comment
      });
      if (historyError) throw historyError;
    } else if (baseDimName === '__verdict__' && comment) {
      const verdictRound = getRoundFromDimName(dim_name);
      if (verdictRound) {
        const nextStatus = nextStatusForVerdict(verdictRound, comment);
        const nextRound = verdictRound === 'r1' && comment === 'approved' ? 'r2' : verdictRound;
        const trackingRows = [
          {
            meeting_id,
            project_id,
            reviewer_code,
            dim_name: '__review_status__',
            score: 0,
            comment: nextStatus,
            updated_at: new Date().toISOString()
          },
          {
            meeting_id,
            project_id,
            reviewer_code,
            dim_name: '__current_round__',
            score: 0,
            comment: nextRound,
            updated_at: new Date().toISOString()
          }
        ];
        if (comment === 'recheck') {
          trackingRows.push({
            meeting_id,
            project_id,
            reviewer_code,
            dim_name: verdictRound === 'r1' ? '__r1_retry_count__' : '__r2_retry_count__',
            score: 0,
            comment: '1',
            updated_at: new Date().toISOString()
          });
        }
        const { error: trackingError } = await supabaseAdmin
          .from('scores')
          .upsert(trackingRows, { onConflict: 'meeting_id,project_id,reviewer_code,dim_name' });
        if (trackingError) throw trackingError;
      }
    }

    return NextResponse.json({ success: true, score: data });
  } catch (err: any) {
    console.error('Submit score error:', err);
    return NextResponse.json({ error: '提交评分失败: ' + err.message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const meetingId = searchParams.get('meetingId');
    const reviewerCode = searchParams.get('reviewerCode');
    const projectId = searchParams.get('projectId');

    if (!meetingId) return NextResponse.json({ error: 'meetingId 必填' }, { status: 400 });

    let query = supabaseAdmin.from('scores').delete().eq('meeting_id', meetingId);
    if (reviewerCode) query = query.eq('reviewer_code', reviewerCode);
    if (projectId) query = query.eq('project_id', projectId);

    const { error } = await query;
    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: '重置评分失败: ' + err.message }, { status: 500 });
  }
}
