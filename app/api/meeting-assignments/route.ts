import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled, supabaseAdmin } from '@/lib/supabase';
import { validateAssignment } from '@/lib/projectPoolWorkflow';

export const dynamic = 'force-dynamic';

async function requireAdmin(code: string) {
  const { data } = await supabaseAdmin.from('reviewers').select('is_admin').eq('code', code).maybeSingle();
  return Boolean(data?.is_admin);
}

export async function POST(request: NextRequest) {
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: '项目池功能尚未启用' }, { status: 404 });
  try {
    const { meeting_id, pool_project_id, pool_project_ids, round_no, operator_code } = await request.json();
    if (Array.isArray(pool_project_ids)) {
      if (!await requireAdmin(operator_code)) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
      const ids = pool_project_ids.filter(Boolean).filter((id: string, index: number, values: string[]) => values.indexOf(id) === index);
      if (!ids.length) return NextResponse.json({ error: 'No projects selected' }, { status: 400 });
      const [projectRes, assignmentsRes, meetingRes] = await Promise.all([
        supabaseAdmin.from('project_pool').select('*').in('id', ids),
        supabaseAdmin.from('projects').select('id, pool_project_id').eq('meeting_id', meeting_id).not('pool_project_id', 'is', null),
        supabaseAdmin.from('meetings').select('id, status').eq('id', meeting_id).single()
      ]);
      if (projectRes.error) throw projectRes.error;
      if (assignmentsRes.error) throw assignmentsRes.error;
      if (meetingRes.error || !meetingRes.data) return NextResponse.json({ error: 'Meeting not found' }, { status: 404 });
      if (['archived', 'locked'].includes(meetingRes.data.status)) return NextResponse.json({ error: 'Meeting is locked or archived' }, { status: 403 });
      const byId = new Map((projectRes.data || []).map((project: any) => [project.id, project]));
      const existing = assignmentsRes.data || [];
      const assignments: any[] = [];
      const errors: any[] = [];
      for (const id of ids) {
        const project = byId.get(id);
        const valid = project && !existing.some((item: any) => item.pool_project_id === id)
          ? validateAssignment(project, [...existing, ...assignments], Number(round_no))
          : { ok: false, error: project ? 'Project already assigned to this meeting' : 'Project not found' };
        if (!valid.ok) { errors.push({ project_id: id, error: valid.error }); continue; }
        const { data: assignment, error } = await supabaseAdmin.rpc('assign_pool_project_to_meeting', {
          p_project_id: id, p_meeting_id: meeting_id, p_round_no: Number(round_no), p_operator_code: operator_code
        });
        if (error) { errors.push({ project_id: id, error: error.message }); continue; }
        assignments.push(assignment);
      }
      if (!assignments.length) return NextResponse.json({ error: errors.map((item) => item.error).join('; ') || 'Assignment failed', errors }, { status: 400 });
      return NextResponse.json({ success: true, assignments, errors });
    }
    if (!await requireAdmin(operator_code)) return NextResponse.json({ error: '只有管理员可以安排评审会' }, { status: 403 });
    const [projectRes, assignmentsRes, meetingRes] = await Promise.all([
      supabaseAdmin.from('project_pool').select('*').eq('id', pool_project_id).single(),
      supabaseAdmin.from('projects').select('id, pool_project_id').eq('meeting_id', meeting_id).not('pool_project_id', 'is', null),
      supabaseAdmin.from('meetings').select('id, status, workflow_version').eq('id', meeting_id).single()
    ]);
    if (projectRes.error) throw projectRes.error;
    if (assignmentsRes.error) throw assignmentsRes.error;
    if (meetingRes.error || !meetingRes.data) return NextResponse.json({ error: '评审会不存在' }, { status: 404 });
    if (['archived', 'locked'].includes(meetingRes.data.status)) return NextResponse.json({ error: '该评审会已锁定或归档' }, { status: 403 });
    if ((assignmentsRes.data || []).some((item: any) => item.pool_project_id === pool_project_id)) return NextResponse.json({ error: '同一项目不能重复加入同一会议' }, { status: 409 });
    const valid = validateAssignment(projectRes.data, assignmentsRes.data || [], Number(round_no));
    if (!valid.ok) return NextResponse.json({ error: valid.error }, { status: 400 });
    const { data: assignment, error } = await supabaseAdmin.rpc('assign_pool_project_to_meeting', {
      p_project_id: pool_project_id, p_meeting_id: meeting_id, p_round_no: Number(round_no), p_operator_code: operator_code
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ success: true, assignment });
  } catch (err: any) {
    return NextResponse.json({ error: `安排评审会失败: ${err.message}` }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: 'Project pool is not enabled' }, { status: 404 });
  try {
    const { meeting_id, ordered_assignment_ids, operator_code } = await request.json();
    if (!meeting_id || !Array.isArray(ordered_assignment_ids) || !await requireAdmin(operator_code)) return NextResponse.json({ error: 'Unauthorized or missing parameters' }, { status: 403 });
    const { data: assignments, error: readError } = await supabaseAdmin.from('projects').select('id').eq('meeting_id', meeting_id).in('id', ordered_assignment_ids);
    if (readError) throw readError;
    if ((assignments || []).length !== ordered_assignment_ids.length) return NextResponse.json({ error: 'Meeting assignments changed, please refresh' }, { status: 409 });
    for (let index = 0; index < ordered_assignment_ids.length; index += 1) {
      const { error } = await supabaseAdmin.from('projects').update({ seq_no: index + 1 }).eq('id', ordered_assignment_ids[index]);
      if (error) throw error;
    }
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: `Unable to update assessment order: ${err.message}` }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: '项目池功能尚未启用' }, { status: 404 });
  try {
    const id = new URL(request.url).searchParams.get('id');
    const operator = new URL(request.url).searchParams.get('operator_code') || '';
    if (!id || !await requireAdmin(operator)) return NextResponse.json({ error: '无权限或参数不完整' }, { status: 403 });
    const { data: assignment, error: readError } = await supabaseAdmin.from('projects').select('id, pool_project_id, round_no, scores(id)').eq('id', id).single();
    if (readError) throw readError;
    if ((assignment.scores || []).length) return NextResponse.json({ error: '已开始评分的项目不能移出会议' }, { status: 409 });
    const { error } = await supabaseAdmin.from('projects').delete().eq('id', id);
    if (error) throw error;
    const status = assignment.round_no === 1 ? 'ready_r1' : 'ready_r2';
    await supabaseAdmin.from('project_pool').update({ status, updated_at: new Date().toISOString() }).eq('id', assignment.pool_project_id);
    await supabaseAdmin.from('project_status_history').insert({ project_id: assignment.pool_project_id, meeting_project_id: id, event_type: 'meeting_unscheduled', to_status: status, operator_code: operator, note: '从未开始的评审会移除' });
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: `移出评审会失败: ${err.message}` }, { status: 500 });
  }
}
