import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled } from '@/lib/featureFlags';
import { requireAdminSession } from '@/lib/adminSession';
import { updateProjectAnnouncement } from '@/lib/db/repositories/projectPoolWorkflow';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: '项目池功能尚未启用' }, { status: 404 });
  const session = requireAdminSession(request);
  if (!session) return NextResponse.json({ error: '只有管理员可以保存立项公示' }, { status: 403 });
  try {
    const body = await request.json();
    const announcement = String(body?.announcement || '').trim();
    if (!announcement) return NextResponse.json({ error: '立项公示内容不能为空' }, { status: 400 });
    const result = await updateProjectAnnouncement(id, announcement, session.code);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status || 409 });
    const project = result.project;
    return NextResponse.json({ success: true, project });
  } catch (err: any) {
    return NextResponse.json({ error: `保存立项公示失败: ${err.message}` }, { status: 500 });
  }
}
