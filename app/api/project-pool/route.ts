import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled, supabaseAdmin } from '@/lib/supabase';
import { createMaterialRows, getMaterialProgress, makeMatchKey, normalizeProjectPart } from '@/lib/projectPoolWorkflow';
import { countCompletedReviews, hasCompletedReview, isPendingReviewProject } from '@/lib/adminLifecycle';
import { requireAdminSession } from '@/lib/adminSession';

export const dynamic = 'force-dynamic';

function getMonthRange(month: string | null) {
  if (!month) return null;
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return undefined;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return undefined;
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

function unavailable() {
  return NextResponse.json({ error: '项目池功能尚未启用' }, { status: 404 });
}

export async function GET(request: NextRequest) {
  if (!isProjectPoolV2Enabled()) return unavailable();
  try {
    const searchParams = new URL(request.url).searchParams;
    const scope = searchParams.get('scope') || 'active';
    if (!['active', 'archived', 'purge_pending', 'pending', 'reviewed'].includes(scope)) {
      return NextResponse.json({ error: 'Invalid project scope' }, { status: 400 });
    }
    const monthRange = getMonthRange(searchParams.get('month'));
    if (monthRange === undefined) return NextResponse.json({ error: 'month must use YYYY-MM' }, { status: 400 });
    let query = supabaseAdmin
      .from('project_pool')
      .select('*, project_materials(*), project_deletion_requests(*), projects(id, meeting_id, seq_no, round_no, attempt_no, scoring_version, assignment_status, meetings(id, name, meeting_date, status), scores(reviewer_code, dim_name, comment))')
      .order('updated_at', { ascending: false });
    if (scope === 'active' || scope === 'pending' || scope === 'reviewed') query = query.is('archived_at', null);
    else query = query.not('archived_at', 'is', null);
    if (monthRange) query = query.gte('created_at', monthRange.start).lt('created_at', monthRange.end);
    const { data, error } = await query;
    if (error) throw error;
    const now = new Date();
    const projects = (data || [])
      .filter((project: any) => {
        const deletionRequest = Array.isArray(project.project_deletion_requests)
          ? project.project_deletion_requests[0]
          : project.project_deletion_requests;
        const isActiveDeletionRequest = deletionRequest && !deletionRequest.restored_at;
        if (scope === 'archived') return !isActiveDeletionRequest;
        if (scope === 'purge_pending') return isActiveDeletionRequest && new Date(deletionRequest.purge_after).getTime() > now.getTime();
        return true;
      })
      .map((project: any) => ({
        ...project,
        material_progress: getMaterialProgress(project.project_materials || []),
        completed_review_count: countCompletedReviews(project.projects || [])
      }));
    const scopedProjects = scope === 'pending' ? projects.filter(isPendingReviewProject) : scope === 'reviewed' ? projects.filter(hasCompletedReview) : projects;
    return NextResponse.json({ projects: scopedProjects }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    return NextResponse.json({ error: `获取项目池失败: ${err.message}` }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!isProjectPoolV2Enabled()) return unavailable();
  try {
    const { name, submitter, description = '' } = await request.json();
    const session = requireAdminSession(request);
    if (!session) return NextResponse.json({ error: '只有管理员可以创建项目' }, { status: 403 });
    if (!String(name || '').trim() || !String(submitter || '').trim()) return NextResponse.json({ error: '项目名称和提报人必填' }, { status: 400 });
    const matchKey = makeMatchKey(name, submitter);
    const { data: project, error } = await supabaseAdmin.from('project_pool').insert({
      name: String(name).trim(), submitter: String(submitter).trim(), description: String(description).trim(),
      normalized_name: normalizeProjectPart(name), normalized_submitter: normalizeProjectPart(submitter),
      match_key: matchKey, status: 'materials_pending', material_status: 'incomplete'
    }).select().single();
    if (error) throw error;
    const materials = createMaterialRows(project.id);
    const { error: materialsError } = await supabaseAdmin.from('project_materials').insert(materials);
    if (materialsError) throw materialsError;
    const { error: historyError } = await supabaseAdmin.from('project_status_history').insert({ project_id: project.id, event_type: 'project_created', to_status: 'materials_pending', operator_code: session.code, note: '创建待评审项目' });
    if (historyError) throw historyError;
    return NextResponse.json({ success: true, project });
  } catch (err: any) {
    return NextResponse.json({ error: `创建项目失败: ${err.message}` }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  if (!isProjectPoolV2Enabled()) return unavailable();
  try {
    const { id, name, submitter, description } = await request.json();
    const session = requireAdminSession(request);
    if (!session) return NextResponse.json({ error: '只有管理员可以编辑项目' }, { status: 403 });
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

export async function DELETE(request: NextRequest) {
  if (!isProjectPoolV2Enabled()) return unavailable();
  try {
    const id = new URL(request.url).searchParams.get('id');
    const session = requireAdminSession(request);
    if (!id || !session) return NextResponse.json({ error: 'Unauthorized or missing parameters' }, { status: 403 });
    const { data: mutations, error } = await supabaseAdmin.rpc('apply_project_pool_mutations', {
      p_project_ids: [id], p_action: 'archive', p_status: null, p_operator_code: session.code, p_note: 'Archived by administrator'
    });
    if (error) throw error;
    if (!mutations?.length) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: `删除项目失败: ${err.message}` }, { status: 500 });
  }
}
