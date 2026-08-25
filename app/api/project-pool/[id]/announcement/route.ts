import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled, supabaseAdmin } from '@/lib/supabase';
import { requireAdminSession } from '@/lib/adminSession';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: '项目池功能尚未启用' }, { status: 404 });
  const session = requireAdminSession(request);
  if (!session) return NextResponse.json({ error: '只有管理员可以保存立项公示' }, { status: 403 });
  try {
    const body = await request.json();
    const announcement = String(body?.announcement || '').trim();
    if (!announcement) return NextResponse.json({ error: '立项公示内容不能为空' }, { status: 400 });
    const [{ data: poolProject, error: poolError }, { data: assignments, error: assignmentsError }] = await Promise.all([
      supabaseAdmin.from('project_pool').select('status').eq('id', id).single(),
      supabaseAdmin.from('projects').select('round_no, scores(reviewer_code, dim_name, comment)').eq('pool_project_id', id)
    ]);
    if (poolError) throw poolError;
    if (poolProject.status !== 'initiation') return NextResponse.json({ error: '项目尚未进入立项流程，不能生成立项公示' }, { status: 409 });
    if (assignmentsError) throw assignmentsError;
    const approvedRounds = new Set((assignments || []).flatMap((assignment: any) => {
      const roundId = `r${Number(assignment.round_no || 0)}`;
      const approved = (assignment.scores || []).some((score: any) => score.reviewer_code?.toUpperCase() === 'W'
        && score.dim_name === `${roundId}::__verdict__` && score.comment === 'approved');
      return approved ? [Number(assignment.round_no)] : [];
    }));
    if (!approvedRounds.has(1) || !approvedRounds.has(2)) {
      return NextResponse.json({ error: '只有第一轮和第二轮均由 Walker 确认通过后才能生成立项公示' }, { status: 409 });
    }
    const { data: project, error } = await supabaseAdmin.from('project_pool').update({
      initiation_announcement: announcement,
      initiation_announcement_updated_at: new Date().toISOString(),
      initiation_announcement_updated_by: session.code,
      updated_at: new Date().toISOString()
    }).eq('id', id).select().single();
    if (error) throw error;
    return NextResponse.json({ success: true, project });
  } catch (err: any) {
    return NextResponse.json({ error: `保存立项公示失败: ${err.message}` }, { status: 500 });
  }
}
