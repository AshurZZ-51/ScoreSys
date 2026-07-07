import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

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

    if (reviewerCode) {
      query = query.eq('reviewer_code', reviewerCode);
    }
    if (projectId) {
      query = query.eq('project_id', projectId);
    }

    const { data: scores, error } = await query;
    if (error) throw error;

    return NextResponse.json({ scores: scores || [] });
  } catch (err: any) {
    return NextResponse.json(
      { error: '获取评分失败: ' + err.message },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { meeting_id, project_id, reviewer_code, dim_name, score, comment } = body;

    if (!meeting_id || !project_id || !reviewer_code || !dim_name || score === undefined) {
      return NextResponse.json({ error: '参数不完整' }, { status: 400 });
    }

    // 检查会议状态和截止日期
    const { data: meeting } = await supabaseAdmin
      .from('meetings')
      .select('deadline, status')
      .eq('id', meeting_id)
      .single();

    if (!meeting) {
      return NextResponse.json({ error: '评审会不存在' }, { status: 404 });
    }

    if (meeting.status === 'archived' || meeting.status === 'locked') {
      return NextResponse.json({ error: '该评审会已锁定/归档，无法修改' }, { status: 403 });
    }

    if (meeting.deadline) {
      const deadline = new Date(meeting.deadline);
      const now = new Date();
      if (now > deadline) {
        return NextResponse.json({ error: '已超过打分截止日期' }, { status: 403 });
      }
    }

    // 验证评委的维度权限（真实表 reviewer_dims）
    // Walker 加分项是特殊维度（dim_name = '__bonus__'），不走reviewer_dims
    // __problems__ 和 __actions__ 是评审意见，不计分，所有评委都可以提交
    let maxScore: number;
    if (dim_name === '__bonus__') {
      if (reviewer_code.toUpperCase() !== 'W') {
        return NextResponse.json({ error: '只有 Walker 可以使用加分项' }, { status: 403 });
      }
      maxScore = 5;
    } else if (dim_name === '__problems__' || dim_name === '__actions__' || dim_name === '__verdict__') {
      maxScore = 0; // 评审意见/结论不计分
    } else {
      const { data: reviewerDim } = await supabaseAdmin
        .from('reviewer_dims')
        .select('max_score')
        .eq('reviewer_code', reviewer_code)
        .eq('dim_name', dim_name)
        .single();

      if (!reviewerDim) {
        return NextResponse.json({ error: '您没有该维度的评分权限' }, { status: 403 });
      }
      maxScore = reviewerDim.max_score;
    }

    // 验证分数
    const scoreNum = Number(score);
    if (isNaN(scoreNum) || scoreNum < 0 || scoreNum > maxScore) {
      return NextResponse.json(
        { error: `分数必须在 0-${maxScore} 之间` },
        { status: 400 }
      );
    }

    // Upsert评分
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
      }, {
        onConflict: 'meeting_id,project_id,reviewer_code,dim_name'
      })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({ success: true, score: data });
  } catch (err: any) {
    console.error('Submit score error:', err);
    return NextResponse.json(
      { error: '提交评分失败: ' + err.message },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const meetingId = searchParams.get('meetingId');
    const reviewerCode = searchParams.get('reviewerCode');
    const projectId = searchParams.get('projectId');

    if (!meetingId) {
      return NextResponse.json({ error: 'meetingId 必填' }, { status: 400 });
    }

    let query = supabaseAdmin.from('scores').delete().eq('meeting_id', meetingId);

    if (reviewerCode) {
      query = query.eq('reviewer_code', reviewerCode);
    }
    if (projectId) {
      query = query.eq('project_id', projectId);
    }

    const { error } = await query;
    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json(
      { error: '重置评分失败: ' + err.message },
      { status: 500 }
    );
  }
}
