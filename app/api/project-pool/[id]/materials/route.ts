import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled, supabaseAdmin } from '@/lib/supabase';
import { getMaterialStatus } from '@/lib/projectPoolWorkflow';

export const dynamic = 'force-dynamic';

async function admin(code: string) {
  const { data } = await supabaseAdmin.from('reviewers').select('is_admin').eq('code', code).maybeSingle();
  return Boolean(data?.is_admin);
}

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: '项目池功能尚未启用' }, { status: 404 });
  const { data, error } = await supabaseAdmin.from('project_materials').select('*').eq('project_id', params.id).order('item_key');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ materials: data || [] });
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: '项目池功能尚未启用' }, { status: 404 });
  try {
    const { item_key, status, note = '', operator_code } = await request.json();
    if (!await admin(operator_code)) return NextResponse.json({ error: '只有管理员可以检查资料' }, { status: 403 });
    if (!['missing', 'submitted', 'approved', 'needs_revision'].includes(status)) return NextResponse.json({ error: '无效资料状态' }, { status: 400 });
    const now = new Date().toISOString();
    const { error } = await supabaseAdmin.from('project_materials').update({ status, note, checked_by: operator_code, checked_at: now, updated_at: now }).eq('project_id', params.id).eq('item_key', item_key);
    if (error) throw error;
    const { data: materials, error: readError } = await supabaseAdmin.from('project_materials').select('*').eq('project_id', params.id);
    if (readError) throw readError;
    const derived = getMaterialStatus(materials || []);
    const nextStatus = derived.value === 'complete' ? 'ready_r1' : 'materials_pending';
    const { data: current, error: currentError } = await supabaseAdmin.from('project_pool').select('status').eq('id', params.id).single();
    if (currentError) throw currentError;
    const { error: projectError } = await supabaseAdmin.from('project_pool').update({ material_status: derived.value, status: current.status === 'draft' || current.status === 'materials_pending' || current.status === 'ready_r1' ? nextStatus : current.status, updated_at: now }).eq('id', params.id);
    if (projectError) throw projectError;
    await supabaseAdmin.from('project_status_history').insert({ project_id: params.id, event_type: 'material_checked', from_status: current.status, to_status: nextStatus, operator_code, note: `${item_key}: ${status}${note ? `；${note}` : ''}` });
    return NextResponse.json({ success: true, material_status: derived.value, status: nextStatus, missing: derived.missing });
  } catch (err: any) {
    return NextResponse.json({ error: `保存资料检查失败: ${err.message}` }, { status: 500 });
  }
}
