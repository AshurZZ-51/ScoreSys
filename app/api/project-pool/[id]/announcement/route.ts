import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled, supabaseAdmin } from '@/lib/supabase';
import { requireAdminSession } from '@/lib/adminSession';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: '项目池功能尚未启用' }, { status: 404 });
  const session = requireAdminSession(request);
  if (!session) return NextResponse.json({ error: '只有管理员可以保存立项公示' }, { status: 403 });
  try {
    const body = await request.json();
    const announcement = String(body?.announcement || '').trim();
    if (!announcement) return NextResponse.json({ error: '立项公示内容不能为空' }, { status: 400 });
    const { data: project, error } = await supabaseAdmin.from('project_pool').update({
      initiation_announcement: announcement,
      initiation_announcement_updated_at: new Date().toISOString(),
      initiation_announcement_updated_by: session.code,
      updated_at: new Date().toISOString()
    }).eq('id', params.id).select().single();
    if (error) throw error;
    return NextResponse.json({ success: true, project });
  } catch (err: any) {
    return NextResponse.json({ error: `保存立项公示失败: ${err.message}` }, { status: 500 });
  }
}
