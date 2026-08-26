import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled } from '@/lib/featureFlags';
import { getMissingTemplateProjects } from '@/lib/projectSlots';
import { requireAdminSession, requireReviewerSession } from '@/lib/adminSession';
import { createProject, deleteProject, listMeetingProjects, updateProject } from '@/lib/db/repositories/projects';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest) {
  try {
    if (!requireReviewerSession(request)) return NextResponse.json({ error: '请先登录' }, { status: 401 });
    const { searchParams } = new URL(request.url);
    const meetingId = searchParams.get('meetingId');
    const role = searchParams.get('role') || 'reviewer';  // 'admin' | 'reviewer'

    if (!meetingId) {
      return NextResponse.json({ error: 'meetingId 必填' }, { status: 400 });
    }

    const storedProjects = await listMeetingProjects({
      meetingId,
      reviewerOnly: role === 'reviewer',
    });
    const projects = !isProjectPoolV2Enabled() && role !== 'reviewer'
      ? [...storedProjects, ...getMissingTemplateProjects(storedProjects, meetingId)]
        .sort((left: any, right: any) => Number(left.seq_no) - Number(right.seq_no))
      : storedProjects;

    return NextResponse.json(
      { projects },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } }
    );
  } catch (err: any) {
    return NextResponse.json(
      { error: '获取项目失败: ' + err.message },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!requireAdminSession(request)) return NextResponse.json({ error: '仅管理员可创建项目' }, { status: 403 });
    const body = await request.json();
    const { meeting_id, seq_no, name, submitter, description, is_pending } = body;

    if (!meeting_id || !name || !submitter) {
      return NextResponse.json({ error: 'meeting_id/name/submitter 必填' }, { status: 400 });
    }

    const project = await createProject({
      meeting_id,
      seq_no: seq_no || 0,
      name,
      submitter,
      description: description || '',
      is_pending: is_pending || false,
      problems: body.problems || [],
      actions: body.actions || [],
    });

    return NextResponse.json({ success: true, project });
  } catch (err: any) {
    return NextResponse.json(
      { error: '创建项目失败: ' + err.message },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    if (!requireAdminSession(request)) return NextResponse.json({ error: '仅管理员可更新项目' }, { status: 403 });
    const body = await request.json();
    const { id, ...updates } = body;

    if (!id) return NextResponse.json({ error: 'id 必填' }, { status: 400 });
    const project = await updateProject(id, updates);

    return NextResponse.json({ success: true, project });
  } catch (err: any) {
    return NextResponse.json(
      { error: '更新项目失败: ' + err.message },
      { status: err?.status === 400 ? 400 : 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    if (!requireAdminSession(request)) return NextResponse.json({ error: '仅管理员可删除项目' }, { status: 403 });
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'id 必填' }, { status: 400 });
    }

    await deleteProject(id);

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json(
      { error: '删除项目失败: ' + err.message },
      { status: 500 }
    );
  }
}
