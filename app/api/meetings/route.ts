import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled } from '@/lib/featureFlags';
import { createMaterialRows, makeMatchKey, normalizeProjectPart } from '@/lib/projectPoolWorkflow';
import { PROJECT_SLOT_COUNT, createTemplateProjects } from '@/lib/projectSlots';
import { sortMeetingsForAdmin } from '@/lib/adminLifecycle';
import { requireAdminSession, requireReviewerSession } from '@/lib/adminSession';
import {
  createMeetingWorkflow,
  listMeetings,
  updateMeetingWorkflow
} from '@/lib/db/repositories/meetingWorkflow';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!requireReviewerSession(request)) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  try {
    const { searchParams } = new URL(request.url);
    const meetingId = searchParams.get('meetingId');
    const includeDeleted = searchParams.get('includeDeleted') === 'true';
    const meetings = await listMeetings({ meetingId, includeDeleted });
    return NextResponse.json({ meetings: sortMeetingsForAdmin(meetings) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    return NextResponse.json({ error: `获取评审会列表失败: ${err.message}` }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
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
    const materialTemplates = createMaterialRows('');
    const result = await createMeetingWorkflow({
      name: String(name).trim(),
      meetingDate: meeting_date,
      deadline: deadline || null,
      notes: String(notes || '').trim(),
      projectPoolV2: v2,
      poolProjectIds: poolIds,
      quickProjects: quickProjects.map((quick: any) => ({
        name: String(quick.name).trim(),
        submitter: String(quick.submitter).trim(),
        description: String(quick.description || '').trim(),
        normalizedName: normalizeProjectPart(quick.name),
        normalizedSubmitter: normalizeProjectPart(quick.submitter),
        matchKey: makeMatchKey(quick.name, quick.submitter),
        roundNo: Number(quick.round_no) === 2 ? 2 : 1,
        materials: materialTemplates.map((material: any) => ({
          itemKey: material.item_key,
          required: material.required,
          status: material.status,
          checkedBy: material.checked_by,
          checkedAt: material.checked_at
        }))
      })),
      templateProjects: v2 ? [] : createTemplateProjects(''),
      operatorCode: session.code
    });
    if (!result.ok) {
      return NextResponse.json({ error: '所选项目不存在、已归档或暂不可安排' }, { status: 400 });
    }
    return NextResponse.json({ success: true, meeting: result.meeting, projectSlotCount: PROJECT_SLOT_COUNT });
  } catch (err: any) {
    return NextResponse.json({ error: `创建评审会失败: ${err.message}` }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const { id, is_current, name, meeting_date, deadline, notes } = await request.json();
    const session = requireAdminSession(request);
    if (!session) return NextResponse.json({ error: '仅管理员可以编辑评审会' }, { status: 403 });
    if (!id) return NextResponse.json({ error: 'id 必填' }, { status: 400 });
    const meeting = await updateMeetingWorkflow({
      id,
      isCurrent: is_current,
      name: name === undefined ? undefined : String(name).trim(),
      meetingDate: meeting_date,
      deadline: deadline === undefined ? undefined : deadline || null,
      notes: notes === undefined ? undefined : String(notes || '').trim()
    });
    return NextResponse.json({ success: true, meeting, operator: session.code });
  } catch (err: any) {
    return NextResponse.json({ error: `更新评审会失败: ${err.message}` }, { status: 500 });
  }
}
