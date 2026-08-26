import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled } from '@/lib/featureFlags';
import { requireReviewerSession } from '@/lib/adminSession';
import { listResultProjects } from '@/lib/db/repositories/projects';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!requireReviewerSession(request)) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: '项目池功能尚未启用' }, { status: 404 });
  try {
    const bucket = new URL(request.url).searchParams.get('bucket');
    const projects = await listResultProjects({ bucket });
    return NextResponse.json({ projects });
  } catch (err: any) {
    return NextResponse.json({ error: `获取结果池失败: ${err.message}` }, { status: 500 });
  }
}
