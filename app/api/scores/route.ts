import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getScoreMax, isValidScoreValue, parseScoreKey } from '@/lib/scoringRules';

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

    const { data: reviewerInfo } = await supabaseAdmin
      .from('reviewers')
      .select('is_admin')
      .eq('code', reviewer_code)
      .single();

    if (dim_name === '__bonus__') {
      if (reviewer_code.toUpperCase() !== 'W') {
        return NextResponse.json({ error: '只有 Walker 可以使用加分项' }, { status: 403 });
      }
    } else if (dim_name === '__verdict__') {
      if (reviewer_code.toUpperCase() !== 'W' && !reviewerInfo?.is_admin) {
        return NextResponse.json({ error: '只有 Walker 或管理员可以设置评审结论' }, { status: 403 });
      }
    } else if (dim_name === '__problems__' || dim_name === '__actions__') {
      // Text-only review fields reuse the score table.
    } else {
      const parsed = parseScoreKey(dim_name);
      const parentDimension = parsed?.dimensionName || dim_name;
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
