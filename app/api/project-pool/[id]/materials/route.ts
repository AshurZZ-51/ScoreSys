import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled, supabaseAdmin } from '@/lib/supabase';
import { getMaterialStatus, isMaterialStatus } from '@/lib/projectPoolWorkflow';
import { requireAdminSession } from '@/lib/adminSession';

export const dynamic = 'force-dynamic';

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: '项目池功能尚未启用' }, { status: 404 });
  const { data, error } = await supabaseAdmin.from('project_materials').select('*').eq('project_id', params.id).order('item_key');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ materials: data || [] });
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: '项目池功能尚未启用' }, { status: 404 });
  try {
    const { item_key, status, note = '' } = await request.json();
    const session = requireAdminSession(request);
    if (!session) return NextResponse.json({ error: '只有管理员可以检查资料' }, { status: 403 });
    if (!isMaterialStatus(status)) return NextResponse.json({ error: '无效资料状态' }, { status: 400 });
    const now = new Date().toISOString();
    const { error } = await supabaseAdmin.from('project_materials').update({ status, note, checked_by: session.code, checked_at: now, updated_at: now }).eq('project_id', params.id).eq('item_key', item_key);
    if (error) throw error;
    const { data: materials, error: readError } = await supabaseAdmin.from('project_materials').select('*').eq('project_id', params.id);
    if (readError) throw readError;
    const derived = getMaterialStatus(materials || []);
    const { data: current, error: currentError } = await supabaseAdmin.from('project_pool').select('status').eq('id', params.id).single();
    if (currentError) throw currentError;
    const { data: project, error: projectError } = await supabaseAdmin.from('project_pool').update({ material_status: derived.value, updated_at: now }).eq('id', params.id).select().single();
    if (projectError) throw projectError;
    const { error: historyError } = await supabaseAdmin.from('project_status_history').insert({ project_id: params.id, event_type: 'material_checked', from_status: current.status, to_status: current.status, operator_code: session.code, note: `${item_key}: ${status}${note ? `；${note}` : ''}` });
    if (historyError) throw historyError;
    return NextResponse.json({ success: true, project, materials: materials || [], material_status: derived.value, status: current.status, missing: derived.missing });
  } catch (err: any) {
    return NextResponse.json({ error: `保存资料检查失败: ${err.message}` }, { status: 500 });
  }
}
