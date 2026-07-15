import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled, supabaseAdmin } from '@/lib/supabase';
import { requireAdminSession } from '@/lib/adminSession';

export const dynamic = 'force-dynamic';
const VALID_STATUSES = new Set(['draft', 'materials_pending', 'ready_r1', 'r1_recheck_ready', 'ready_r2', 'r2_recheck_ready', 'initiation', 'rejected']);

function nextVerdict(status: string, previous: string | null) {
  if (status === 'rejected') return 'rejected';
  if (['initiation', 'ready_r2'].includes(status)) return 'approved';
  if (status.includes('recheck')) return 'recheck';
  return previous;
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: '项目池功能尚未启用' }, { status: 404 });
  try {
    const { status, note = '', confirmed } = await request.json();
    if (!confirmed) return NextResponse.json({ error: '请确认后再手工调整项目状态' }, { status: 400 });
    if (!VALID_STATUSES.has(status)) return NextResponse.json({ error: '无效的项目状态' }, { status: 400 });
    const session = requireAdminSession(request);
    if (!session) return NextResponse.json({ error: '只有管理员可以手工调整项目状态' }, { status: 403 });
    const { data: current, error: currentError } = await supabaseAdmin.from('project_pool').select('id, status, latest_verdict').eq('id', params.id).single();
    if (currentError || !current) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
    const { data: project, error: projectError } = await supabaseAdmin.from('project_pool').update({
      status,
      latest_verdict: nextVerdict(status, current.latest_verdict),
      updated_at: new Date().toISOString()
    }).eq('id', params.id).select().single();
    if (projectError) throw projectError;
    const { error: historyError } = await supabaseAdmin.from('project_status_history').insert({
      project_id: params.id,
      event_type: 'admin_adjustment',
      from_status: current.status,
      to_status: status,
      operator_code: session.code,
      note: String(note || '').trim() || 'Manual status update'
    });
    if (historyError) throw historyError;
    return NextResponse.json({ success: true, project });
  } catch (err: any) {
    return NextResponse.json({ error: `调整项目状态失败: ${err.message}` }, { status: 500 });
  }
}
