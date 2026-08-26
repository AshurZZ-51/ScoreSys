import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled } from '@/lib/featureFlags';
import { supabaseAdmin } from '@/lib/supabase';
import { buildMaterialUpsert, getMaterialStatus, isMaterialStatus, MATERIAL_ITEMS } from '@/lib/projectPoolWorkflow';
import { requireAdminSession } from '@/lib/adminSession';
import { listProjectMaterials } from '@/lib/db/repositories/projectMaterials';

export const dynamic = 'force-dynamic';

export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: '项目池功能尚未启用' }, { status: 404 });
  try {
    const materials = await listProjectMaterials(id);
    return NextResponse.json({ materials });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: '项目池功能尚未启用' }, { status: 404 });
  try {
    const { item_key, status, note = '' } = await request.json();
    const session = requireAdminSession(request);
    if (!session) return NextResponse.json({ error: '只有管理员可以检查资料' }, { status: 403 });
    if (!isMaterialStatus(status)) return NextResponse.json({ error: '无效资料状态' }, { status: 400 });
    const materialDefinition = MATERIAL_ITEMS.find((item) => item.item_key === item_key);
    if (!materialDefinition) return NextResponse.json({ error: '无效资料项' }, { status: 400 });
    const now = new Date().toISOString();
    const { error } = await supabaseAdmin.from('project_materials').upsert(
      buildMaterialUpsert(id, item_key, materialDefinition.required, status, note, session.code, now),
      { onConflict: 'project_id,item_key' }
    );
    if (error) throw error;
    const { data: materials, error: readError } = await supabaseAdmin.from('project_materials').select('*').eq('project_id', id);
    if (readError) throw readError;
    const derived = getMaterialStatus(materials || []);
    const { data: current, error: currentError } = await supabaseAdmin.from('project_pool').select('status').eq('id', id).single();
    if (currentError) throw currentError;
    const { data: project, error: projectError } = await supabaseAdmin.from('project_pool').update({ material_status: derived.value, updated_at: now }).eq('id', id).select().single();
    if (projectError) throw projectError;
    const { error: historyError } = await supabaseAdmin.from('project_status_history').insert({ project_id: id, event_type: 'material_checked', from_status: current.status, to_status: current.status, operator_code: session.code, note: `${item_key}: ${status}${note ? `；${note}` : ''}` });
    if (historyError) throw historyError;
    return NextResponse.json({ success: true, project, materials: materials || [], material_status: derived.value, status: current.status, missing: derived.missing });
  } catch (err: any) {
    return NextResponse.json({ error: `保存资料检查失败: ${err.message}` }, { status: 500 });
  }
}
