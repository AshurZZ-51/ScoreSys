import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled, supabaseAdmin } from '@/lib/supabase';
import { isSameReviewerCode, requireReviewerSession } from '@/lib/adminSession';
import { normalizeProjectRating } from '@/lib/projectReviewerRating';

export const dynamic = 'force-dynamic';

async function getReviewer(request: NextRequest) {
  const session = requireReviewerSession(request);
  if (!session) return null;
  const { data: reviewer, error } = await supabaseAdmin
    .from('reviewers')
    .select('code, is_admin')
    .ilike('code', session.code)
    .single();
  if (error) throw error;
  if (!reviewer || reviewer.is_admin) return null;
  return reviewer;
}

export async function GET(request: NextRequest) {
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: '项目池功能尚未启用' }, { status: 404 });
  try {
    const reviewer = await getReviewer(request);
    if (!reviewer) return NextResponse.json({ error: '请使用评委账号登录' }, { status: 403 });
    const { searchParams } = new URL(request.url);
    const meetingId = searchParams.get('meetingId');
    const projectId = searchParams.get('projectId');
    if (!meetingId) return NextResponse.json({ error: 'meetingId 必填' }, { status: 400 });
    let query = supabaseAdmin
      .from('project_reviewer_ratings')
      .select('id, meeting_id, project_id, reviewer_code, round_no, attempt_no, rating, created_at, updated_at')
      .eq('meeting_id', meetingId)
      .eq('reviewer_code', reviewer.code);
    if (projectId) query = query.eq('project_id', projectId);
    const { data, error } = await query;
    if (error) throw error;
    return NextResponse.json({ ratings: data || [] }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (error: any) {
    return NextResponse.json({ error: `获取个人评级失败: ${error.message}` }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: '项目池功能尚未启用' }, { status: 404 });
  try {
    const session = requireReviewerSession(request);
    if (!session) return NextResponse.json({ error: '请先登录' }, { status: 401 });
    const reviewer = await getReviewer(request);
    if (!reviewer || !isSameReviewerCode(reviewer.code, session.code)) {
      return NextResponse.json({ error: '只有非管理员评委可以填写个人评级' }, { status: 403 });
    }
    const body = await request.json();
    const meetingId = String(body?.meeting_id || '');
    const projectId = String(body?.project_id || '');
    const rating = normalizeProjectRating(body?.rating);
    if (!meetingId || !projectId || !rating) return NextResponse.json({ error: 'meeting_id、project_id 和 S/A/B/C 评级必填' }, { status: 400 });

    const { data: assignment, error: assignmentError } = await supabaseAdmin
      .from('projects')
      .select('id, meeting_id, round_no, attempt_no, assignment_status')
      .eq('id', projectId)
      .eq('meeting_id', meetingId)
      .single();
    if (assignmentError) throw assignmentError;
    if (!assignment?.round_no) return NextResponse.json({ error: '项目尚未绑定评审轮次' }, { status: 400 });

    const { data: snapshot } = await supabaseAdmin
      .from('meeting_reviewers')
      .select('reviewer_code')
      .eq('meeting_id', meetingId)
      .ilike('reviewer_code', reviewer.code)
      .maybeSingle();
    if (!snapshot) return NextResponse.json({ error: '您不在本场评审会的评委名单中' }, { status: 403 });

    const { data, error } = await supabaseAdmin
      .from('project_reviewer_ratings')
      .upsert({
        meeting_id: meetingId,
        project_id: projectId,
        reviewer_code: reviewer.code,
        round_no: assignment.round_no,
        attempt_no: assignment.attempt_no || 1,
        rating,
        updated_at: new Date().toISOString()
      }, { onConflict: 'meeting_id,project_id,reviewer_code,round_no,attempt_no' })
      .select()
      .single();
    if (error) throw error;
    return NextResponse.json({ success: true, rating: data });
  } catch (error: any) {
    return NextResponse.json({ error: `保存个人评级失败: ${error.message}` }, { status: 500 });
  }
}
