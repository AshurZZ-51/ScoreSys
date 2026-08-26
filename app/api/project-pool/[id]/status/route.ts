import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled } from '@/lib/featureFlags';
import { requireAdminSession } from '@/lib/adminSession';
import { updateProjectStatus } from '@/lib/db/repositories/projectPoolWorkflow';

export const dynamic = 'force-dynamic';
const VALID_STATUSES = new Set(['draft', 'materials_pending', 'ready_r1', 'r1_recheck_ready', 'ready_r2', 'r2_recheck_ready', 'initiation', 'rejected']);

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: '项目池功能尚未启用' }, { status: 404 });
  try {
    const { status, note = '', confirmed } = await request.json();
    if (!confirmed) return NextResponse.json({ error: '请确认后再手工调整项目状态' }, { status: 400 });
    if (!VALID_STATUSES.has(status)) return NextResponse.json({ error: '无效的项目状态' }, { status: 400 });
    const session = requireAdminSession(request);
    if (!session) return NextResponse.json({ error: '只有管理员可以手工调整项目状态' }, { status: 403 });
    const project = await updateProjectStatus(id, status, String(note || '').trim() || 'Manual status update', session.code);
    return NextResponse.json({ success: true, project });
  } catch (err: any) {
    if (err?.status === 404) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
    return NextResponse.json({ error: `调整项目状态失败: ${err.message}` }, { status: 500 });
  }
}
