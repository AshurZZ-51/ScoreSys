import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled, supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: '项目池功能尚未启用' }, { status: 404 });
  try {
    let { status, note, operator_code, confirmed } = await request.json();
    note = String(note || '').trim() || 'Manual status update';
    if (!confirmed) return NextResponse.json({ error: '请确认后再手动调整项目状态' }, { status: 400 });
    if (!String(note || '').trim()) return NextResponse.json({ error: '人工调整必须填写说明' }, { status: 400 });
    const { data: reviewer } = await supabaseAdmin.from('reviewers').select('is_admin').eq('code', operator_code).maybeSingle();
    if (!reviewer?.is_admin) return NextResponse.json({ error: '只有管理员可以手动调整项目状态' }, { status: 403 });
    const { data: project, error: readError } = await supabaseAdmin.from('project_pool').select('status, current_round, current_attempt, latest_verdict').eq('id', params.id).single();
    if (readError) throw readError;
    const verdict = status === 'rejected' ? 'rejected' : status === 'initiation' || status === 'ready_r2' ? 'approved' : status.includes('recheck') ? 'recheck' : project.latest_verdict;
    const { data, error } = await supabaseAdmin.from('project_pool').update({ status, latest_verdict: verdict, updated_at: new Date().toISOString() }).eq('id', params.id).select().single();
    if (error) throw error;
    await supabaseAdmin.from('project_status_history').insert({ project_id: params.id, event_type: 'admin_adjustment', from_status: project.status, to_status: status, operator_code, note });
    return NextResponse.json({ success: true, project: data });
  } catch (err: any) {
    return NextResponse.json({ error: `调整项目状态失败: ${err.message}` }, { status: 500 });
  }
}
