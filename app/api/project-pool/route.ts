import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled, supabaseAdmin } from '@/lib/supabase';
import { MATERIAL_ITEMS, makeMatchKey, normalizeProjectPart } from '@/lib/projectPoolWorkflow';

export const dynamic = 'force-dynamic';

async function requireAdmin(code: string) {
  if (!code) return false;
  const { data } = await supabaseAdmin.from('reviewers').select('is_admin').eq('code', code).maybeSingle();
  return Boolean(data?.is_admin);
}

function unavailable() {
  return NextResponse.json({ error: '项目池功能尚未启用' }, { status: 404 });
}

export async function GET(request: NextRequest) {
  if (!isProjectPoolV2Enabled()) return unavailable();
  try {
    const scope = new URL(request.url).searchParams.get('scope') || 'all';
    let query = supabaseAdmin
      .from('project_pool')
      .select('*, project_materials(*), projects(id, meeting_id, seq_no, round_no, attempt_no, scoring_version, assignment_status, meetings(id, name, meeting_date, status))')
      .is('archived_at', null)
      .order('updated_at', { ascending: false });
    if (scope === 'pending') query = query.in('status', ['draft', 'materials_pending', 'ready_r1', 'r1_recheck_ready', 'ready_r2', 'r2_recheck_ready']);
    if (scope === 'reviewed') query = query.not('latest_verdict', 'is', null);
    const { data, error } = await query;
    if (error) throw error;
    return NextResponse.json({ projects: data || [] }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    return NextResponse.json({ error: `获取项目池失败: ${err.message}` }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!isProjectPoolV2Enabled()) return unavailable();
  try {
    const { name, submitter, description = '', operator_code } = await request.json();
    if (!await requireAdmin(operator_code)) return NextResponse.json({ error: '只有管理员可以创建项目' }, { status: 403 });
    if (!String(name || '').trim() || !String(submitter || '').trim()) return NextResponse.json({ error: '项目名称和提报人必填' }, { status: 400 });
    const matchKey = makeMatchKey(name, submitter);
    const { data: project, error } = await supabaseAdmin.from('project_pool').insert({
      name: String(name).trim(), submitter: String(submitter).trim(), description: String(description).trim(),
      normalized_name: normalizeProjectPart(name), normalized_submitter: normalizeProjectPart(submitter),
      match_key: matchKey, status: 'materials_pending', material_status: 'incomplete'
    }).select().single();
    if (error) throw error;
    const materials = MATERIAL_ITEMS.map((item) => ({ project_id: project.id, ...item, status: 'missing' }));
    const { error: materialsError } = await supabaseAdmin.from('project_materials').insert(materials);
    if (materialsError) throw materialsError;
    await supabaseAdmin.from('project_status_history').insert({ project_id: project.id, event_type: 'project_created', to_status: 'materials_pending', operator_code, note: '创建待评审项目' });
    return NextResponse.json({ success: true, project });
  } catch (err: any) {
    return NextResponse.json({ error: `创建项目失败: ${err.message}` }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  if (!isProjectPoolV2Enabled()) return unavailable();
  try {
    const { id, name, submitter, description, operator_code } = await request.json();
    if (!await requireAdmin(operator_code)) return NextResponse.json({ error: '只有管理员可以编辑项目' }, { status: 403 });
    if (!id || !String(name || '').trim() || !String(submitter || '').trim()) return NextResponse.json({ error: '项目名称和提报人必填' }, { status: 400 });
    const { data, error } = await supabaseAdmin.from('project_pool').update({
      name: String(name).trim(), submitter: String(submitter).trim(), description: String(description || '').trim(),
      normalized_name: normalizeProjectPart(name), normalized_submitter: normalizeProjectPart(submitter), match_key: makeMatchKey(name, submitter), updated_at: new Date().toISOString()
    }).eq('id', id).select().single();
    if (error) throw error;
    return NextResponse.json({ success: true, project: data });
  } catch (err: any) {
    return NextResponse.json({ error: `更新项目失败: ${err.message}` }, { status: 500 });
  }
}
