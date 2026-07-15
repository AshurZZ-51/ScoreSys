import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled, supabaseAdmin } from '@/lib/supabase';
import { assignmentRoundForStatus, validateAssignment } from '@/lib/projectPoolWorkflow';
import { requireAdminSession } from '@/lib/adminSession';

export const dynamic = 'force-dynamic';

function unavailable() {
  return NextResponse.json({ error: '项目池功能尚未启用' }, { status: 404 });
}

export async function POST(request: NextRequest) {
  if (!isProjectPoolV2Enabled()) return unavailable();
  try {
    const { meeting_id, pool_project_id, pool_project_ids } = await request.json();
    const session = requireAdminSession(request);
    if (!session) return NextResponse.json({ error: '仅管理员可以安排评审会' }, { status: 403 });
    const ids = Array.isArray(pool_project_ids)
      ? Array.from(new Set(pool_project_ids.filter((id) => typeof id === 'string' && id)))
      : [pool_project_id].filter(Boolean);
    if (!meeting_id || !ids.length) return NextResponse.json({ error: '评审会和项目必填' }, { status: 400 });
    const [projectsResult, assignmentsResult, meetingResult] = await Promise.all([
      supabaseAdmin.from('project_pool').select('*').in('id', ids),
      supabaseAdmin.from('projects').select('id, pool_project_id').eq('meeting_id', meeting_id).not('pool_project_id', 'is', null),
      supabaseAdmin.from('meetings').select('id, status, deleted_at').eq('id', meeting_id).single()
    ]);
    if (projectsResult.error) throw projectsResult.error;
    if (assignmentsResult.error) throw assignmentsResult.error;
    if (meetingResult.error || !meetingResult.data || meetingResult.data.deleted_at || ['archived', 'locked'].includes(meetingResult.data.status)) {
      return NextResponse.json({ error: '评审会不存在、已归档或已锁定' }, { status: 403 });
    }
    const byId = new Map((projectsResult.data || []).map((project: any) => [project.id, project]));
    const existing = assignmentsResult.data || [];
    const assignments: any[] = [];
    const errors: any[] = [];
    for (const id of ids) {
      const project = byId.get(id);
      const projectRound = assignmentRoundForStatus(project?.status);
      const valid = project && !existing.some((item: any) => item.pool_project_id === id)
        ? validateAssignment(project, [...existing, ...assignments], projectRound)
        : { ok: false, error: project ? '同一项目不能重复加入同一评审会' : '项目不存在' };
      if (!valid.ok) { errors.push({ project_id: id, error: valid.error }); continue; }
      const attempt_no = valid.attemptNo || 1;
      const { data, error } = await supabaseAdmin.from('projects').insert({
        meeting_id,
        seq_no: existing.length + assignments.length + 1,
        name: project.name,
        submitter: project.submitter,
        description: project.description || '',
        problems: [],
        actions: [],
        is_template: false,
        pool_project_id: id,
        round_no: projectRound,
        attempt_no,
        scoring_version: 'two_round_v2',
        assignment_status: 'scheduled'
      }).select().single();
      if (error) { errors.push({ project_id: id, error: error.message }); continue; }
      const nextStatus = projectRound === 1 ? 'scheduled_r1' : 'scheduled_r2';
      const { error: poolError } = await supabaseAdmin.from('project_pool').update({ status: nextStatus, current_round: projectRound, current_attempt: attempt_no, updated_at: new Date().toISOString() }).eq('id', id);
      if (poolError) { await supabaseAdmin.from('projects').delete().eq('id', data.id); errors.push({ project_id: id, error: poolError.message }); continue; }
      const { error: historyError } = await supabaseAdmin.from('project_status_history').insert({ project_id: id, meeting_project_id: data.id, meeting_id, event_type: 'meeting_scheduled', from_status: project.status, to_status: nextStatus, operator_code: session.code });
      if (historyError) { errors.push({ project_id: id, error: historyError.message }); continue; }
      assignments.push(data);
    }
    if (!assignments.length) return NextResponse.json({ error: errors.map((item) => item.error).join('；') || '安排失败', errors }, { status: 400 });
    return NextResponse.json({ success: true, assignments, errors });
  } catch (err: any) {
    return NextResponse.json({ error: `安排评审会失败: ${err.message}` }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  if (!isProjectPoolV2Enabled()) return unavailable();
  try {
    const { meeting_id, ordered_assignment_ids } = await request.json();
    const session = requireAdminSession(request);
    if (!session || !meeting_id || !Array.isArray(ordered_assignment_ids) || ordered_assignment_ids.length > 12) {
      return NextResponse.json({ error: '未授权或参数无效' }, { status: 403 });
    }
    const { data: assignments, error: readError } = await supabaseAdmin.from('projects').select('id').eq('meeting_id', meeting_id).in('id', ordered_assignment_ids);
    if (readError) throw readError;
    if ((assignments || []).length !== ordered_assignment_ids.length) return NextResponse.json({ error: '评审项目已变更，请刷新后重试' }, { status: 409 });
    for (let index = 0; index < ordered_assignment_ids.length; index += 1) {
      const { error } = await supabaseAdmin.from('projects').update({ seq_no: index + 1 }).eq('id', ordered_assignment_ids[index]);
      if (error) throw error;
    }
    return NextResponse.json({ success: true, operator: session.code });
  } catch (err: any) {
    return NextResponse.json({ error: `保存评审顺序失败: ${err.message}` }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!isProjectPoolV2Enabled()) return unavailable();
  try {
    const id = new URL(request.url).searchParams.get('id');
    const session = requireAdminSession(request);
    if (!id || !session) return NextResponse.json({ error: '无权限或参数不完整' }, { status: 403 });
    const { data: assignment, error: readError } = await supabaseAdmin.from('projects').select('id, pool_project_id, round_no, scores(id)').eq('id', id).single();
    if (readError) throw readError;
    if ((assignment.scores || []).length) return NextResponse.json({ error: '已开始评分的项目不能移出评审会' }, { status: 409 });
    const { error } = await supabaseAdmin.from('projects').delete().eq('id', id);
    if (error) throw error;
    const status = assignment.round_no === 1 ? 'ready_r1' : 'ready_r2';
    await supabaseAdmin.from('project_pool').update({ status, updated_at: new Date().toISOString() }).eq('id', assignment.pool_project_id);
    await supabaseAdmin.from('project_status_history').insert({ project_id: assignment.pool_project_id, meeting_project_id: id, event_type: 'meeting_unscheduled', to_status: status, operator_code: session.code, note: '从未开始的评审会移除' });
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: `移出评审会失败: ${err.message}` }, { status: 500 });
  }
}
