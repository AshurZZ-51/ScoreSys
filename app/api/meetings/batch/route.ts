import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { requireAdminSession } from '@/lib/adminSession';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const { ids, action } = await request.json();
    const session = requireAdminSession(request);
    if (!session) return NextResponse.json({ error: '仅管理员可以管理评审会' }, { status: 403 });
    const meetingIds = Array.isArray(ids) ? Array.from(new Set(ids.filter((id) => typeof id === 'string' && id))) : [];
    if (!meetingIds.length || !['recycle', 'restore'].includes(action)) {
      return NextResponse.json({ error: '需要评审会列表和有效操作类型' }, { status: 400 });
    }
    const updates = action === 'recycle'
      ? { deleted_at: new Date().toISOString(), scheduled_purge_at: null, status: 'archived', is_current: false }
      : { deleted_at: null, scheduled_purge_at: null, status: 'active' };
    const { data, error } = await supabaseAdmin.from('meetings').update(updates).in('id', meetingIds).select('id');
    if (error) throw error;
    return NextResponse.json({ success: true, updated: data?.length || 0, operator: session.code });
  } catch (err: any) {
    return NextResponse.json({ error: `批量评审会操作失败: ${err.message}` }, { status: 500 });
  }
}
