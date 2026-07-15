import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled, supabaseAdmin } from '@/lib/supabase';
import { requireAdminSession } from '@/lib/adminSession';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: '项目池功能尚未启用' }, { status: 404 });
  try {
    let { status, note, confirmed } = await request.json();
    note = String(note || '').trim() || 'Manual status update';
    if (!confirmed) return NextResponse.json({ error: '请确认后再手动调整项目状态' }, { status: 400 });
    if (!String(note || '').trim()) return NextResponse.json({ error: '人工调整必须填写说明' }, { status: 400 });
    const session = requireAdminSession(request);
    if (!session) return NextResponse.json({ error: '只有管理员可以手动调整项目状态' }, { status: 403 });
    const { data, error } = await supabaseAdmin.rpc('apply_project_pool_mutations', {
      p_project_ids: [params.id], p_action: 'status', p_status: status, p_operator_code: session.code, p_note: note
    });
    if (error) throw error;
    if (!data?.length) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
    const { data: project, error: projectError } = await supabaseAdmin.from('project_pool').select('*').eq('id', params.id).single();
    if (projectError) throw projectError;
    return NextResponse.json({ success: true, project });
  } catch (err: any) {
    return NextResponse.json({ error: `调整项目状态失败: ${err.message}` }, { status: 500 });
  }
}
