import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled, supabaseAdmin } from '@/lib/supabase';
import { createMaterialRows, makeMatchKey, normalizeProjectPart } from '@/lib/projectPoolWorkflow';
import { PROJECT_SLOT_COUNT, createTemplateProjects } from '@/lib/projectSlots';
import { sortMeetingsForAdmin } from '@/lib/adminLifecycle';
import { requireAdminSession } from '@/lib/adminSession';

export const dynamic = 'force-dynamic';

function assignmentRound(status: string) {
  if (['ready_r2', 'r2_recheck_ready'].includes(status)) return 2;
  if (['draft', 'materials_pending', 'ready_r1', 'r1_recheck_ready'].includes(status)) return 1;
  return null;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const meetingId = searchParams.get('meetingId');
    const includeDeleted = searchParams.get('includeDeleted') === 'true';
    let query = supabaseAdmin
      .from('meetings')
      .select('id, name, meeting_date, deadline, status, notes, workflow_version, is_current, deleted_at, scheduled_purge_at, created_at')
      .order('meeting_date', { ascending: false });
    if (meetingId) query = query.eq('id', meetingId);
    else if (!includeDeleted) query = query.is('deleted_at', null);
    const { data, error } = await query;
    if (error) throw error;
    return NextResponse.json({ meetings: sortMeetingsForAdmin(data || []) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    return NextResponse.json({ error: `获取评审会列表失败: ${err.message}` }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  let meetingId = '';
  const quickProjectIds: string[] = [];
  try {
    const { name, meeting_date, deadline, notes = '', pool_project_ids = [], create_projects = [] } = await request.json();
    const session = requireAdminSession(request);
    if (!session) return NextResponse.json({ error: '仅管理员可以创建评审会' }, { status: 403 });
    if (!String(name || '').trim() || !meeting_date) return NextResponse.json({ error: '评审会名称和日期必填' }, { status: 400 });
    const poolIds = Array.isArray(pool_project_ids) ? Array.from(new Set(pool_project_ids.filter((id) => typeof id === 'string' && id))) : [];
    const quickProjects = Array.isArray(create_projects) ? create_projects : [];
    if (poolIds.length + quickProjects.length > PROJECT_SLOT_COUNT) return NextResponse.json({ error: '每场评审会最多安排 12 个项目' }, { status: 400 });
    if (quickProjects.some((project: any) => !String(project?.name || '').trim() || !String(project?.submitter || '').trim())) {
      return NextResponse.json({ error: '快速创建项目需要项目名称和提报人' }, { status: 400 });
    }

    const v2 = isProjectPoolV2Enabled();
    let selectedProjects: any[] = [];
    if (v2 && poolIds.length) {
      const { data, error } = await supabaseAdmin.from('project_pool').select('id, status, archived_at').in('id', poolIds);
      if (error) throw error;
      if ((data || []).length !== poolIds.length || (data || []).some((project: any) => project.archived_at || !assignmentRound(project.status))) {
        return NextResponse.json({ error: '所选项目不存在、已归档或暂不可安排' }, { status: 400 });
      }
      selectedProjects = data || [];
    }

    const { data: meeting, error: meetingError } = await supabaseAdmin.from('meetings').insert({
      name: String(name).trim(), meeting_date, deadline: deadline || null, notes: String(notes || '').trim(), status: 'active',
      workflow_version: v2 ? 'two_round_v2' : 'legacy_v1'
    }).select().single();
    if (meetingError) throw meetingError;
    meetingId = meeting.id;

    if (v2) {
      const { data: reviewers, error: reviewerError } = await supabaseAdmin.from('reviewers').select('code, name, role, is_admin').eq('is_admin', false);
      if (reviewerError) throw reviewerError;
      if (reviewers?.length) {
        const { error } = await supabaseAdmin.from('meeting_reviewers').insert(reviewers.map((reviewer: any) => ({
          meeting_id: meeting.id, reviewer_code: reviewer.code, reviewer_name: reviewer.name || '', reviewer_role: reviewer.role || ''
        })));
        if (error) throw error;
      }
      for (const quick of quickProjects) {
        const round = Number(quick.round_no) === 2 ? 2 : 1;
        const { data: project, error } = await supabaseAdmin.from('project_pool').insert({
          name: String(quick.name).trim(), submitter: String(quick.submitter).trim(), description: String(quick.description || '').trim(),
          normalized_name: normalizeProjectPart(quick.name), normalized_submitter: normalizeProjectPart(quick.submitter),
          match_key: makeMatchKey(quick.name, quick.submitter), status: round === 2 ? 'ready_r2' : 'ready_r1', material_status: 'incomplete'
        }).select().single();
        if (error) throw error;
        quickProjectIds.push(project.id);
        const { error: materialsError } = await supabaseAdmin.from('project_materials').insert(createMaterialRows(project.id));
        if (materialsError) throw materialsError;
        const { error: historyError } = await supabaseAdmin.from('project_status_history').insert({
          project_id: project.id, event_type: 'project_created', to_status: project.status, operator_code: session.code, note: '在创建评审会时快速创建'
        });
        if (historyError) throw historyError;
        selectedProjects.push(project);
      }
      for (let index = 0; index < selectedProjects.length; index += 1) {
        const project = selectedProjects[index];
        const roundNo = assignmentRound(project.status);
        const attemptNo = String(project.status).includes('recheck') ? 2 : 1;
        const { data: assignment, error: assignmentError } = await supabaseAdmin.from('projects').insert({
          meeting_id: meeting.id, seq_no: index + 1, name: project.name, submitter: project.submitter, description: project.description || '',
          problems: [], actions: [], is_template: false, pool_project_id: project.id, round_no: roundNo, attempt_no: attemptNo,
          scoring_version: 'two_round_v2', assignment_status: 'scheduled'
        }).select().single();
        if (assignmentError) throw assignmentError;
        const nextStatus = roundNo === 1 ? 'scheduled_r1' : 'scheduled_r2';
        const { error: updateError } = await supabaseAdmin.from('project_pool').update({ status: nextStatus, current_round: roundNo, current_attempt: attemptNo, updated_at: new Date().toISOString() }).eq('id', project.id);
        if (updateError) { await supabaseAdmin.from('projects').delete().eq('id', assignment.id); throw updateError; }
        const { error: historyError } = await supabaseAdmin.from('project_status_history').insert({ project_id: project.id, meeting_project_id: assignment.id, meeting_id: meeting.id, event_type: 'meeting_scheduled', from_status: project.status, to_status: nextStatus, operator_code: session.code });
        if (historyError) throw historyError;
      }
    } else {
      const { error } = await supabaseAdmin.from('projects').insert(createTemplateProjects(meeting.id));
      if (error) throw error;
    }
    return NextResponse.json({ success: true, meeting, projectSlotCount: PROJECT_SLOT_COUNT });
  } catch (err: any) {
    if (meetingId) await supabaseAdmin.from('meetings').delete().eq('id', meetingId);
    if (quickProjectIds.length) await supabaseAdmin.from('project_pool').delete().in('id', quickProjectIds);
    return NextResponse.json({ error: `创建评审会失败: ${err.message}` }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const { id, is_current, name, meeting_date, deadline, notes } = await request.json();
    const session = requireAdminSession(request);
    if (!session) return NextResponse.json({ error: '仅管理员可以编辑评审会' }, { status: 403 });
    if (!id) return NextResponse.json({ error: 'id 必填' }, { status: 400 });
    if (is_current === true) {
      const { error } = await supabaseAdmin.from('meetings').update({ is_current: false }).eq('is_current', true);
      if (error) throw error;
    }
    const updateData: Record<string, any> = {};
    if (is_current !== undefined) updateData.is_current = is_current;
    if (name !== undefined) updateData.name = String(name).trim();
    if (meeting_date !== undefined) updateData.meeting_date = meeting_date;
    if (deadline !== undefined) updateData.deadline = deadline || null;
    if (notes !== undefined) updateData.notes = String(notes || '').trim();
    const { data, error } = await supabaseAdmin.from('meetings').update(updateData).eq('id', id).is('deleted_at', null).select().single();
    if (error) throw error;
    return NextResponse.json({ success: true, meeting: data, operator: session.code });
  } catch (err: any) {
    return NextResponse.json({ error: `更新评审会失败: ${err.message}` }, { status: 500 });
  }
}
