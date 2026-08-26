import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled } from '@/lib/featureFlags';
import { requireAdminSession } from '@/lib/adminSession';
import { assignMeetingProjects, removeMeetingAssignment, reorderMeetingAssignments } from '@/lib/db/repositories/projectPoolWorkflow';

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
    const { assignments, errors } = await assignMeetingProjects(meeting_id, ids, session.code);
    if (errors.some((item) => !item.project_id)) return NextResponse.json({ error: errors[0].error }, { status: 403 });
    if (!assignments.length) return NextResponse.json({ error: errors.map((item) => item.error).join('；') || '安排失败', errors }, { status: 400 });
    return NextResponse.json({ success: true, assignments, errors });
  } catch (err: any) {
    if (err?.status === 400 || err?.status === 409) return NextResponse.json({ error: err.message }, { status: err.status });
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
    await reorderMeetingAssignments(meeting_id, ordered_assignment_ids);
    return NextResponse.json({ success: true, operator: session.code });
  } catch (err: any) {
    if (err?.status === 409) return NextResponse.json({ error: err.message }, { status: 409 });
    return NextResponse.json({ error: `保存评审顺序失败: ${err.message}` }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!isProjectPoolV2Enabled()) return unavailable();
  try {
    const id = new URL(request.url).searchParams.get('id');
    const session = requireAdminSession(request);
    if (!id || !session) return NextResponse.json({ error: '无权限或参数不完整' }, { status: 403 });
    const result = await removeMeetingAssignment(id, session.code);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status || 400 });
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: `移出评审会失败: ${err.message}` }, { status: 500 });
  }
}
