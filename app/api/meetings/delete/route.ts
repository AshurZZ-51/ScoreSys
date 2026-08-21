import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { requireAdminSession } from '@/lib/adminSession';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const { id, action } = await request.json();
    const session = requireAdminSession(request);
    if (!session) return NextResponse.json({ error: '仅管理员可以管理评审会' }, { status: 403 });
    if (!id || !['soft_delete', 'restore'].includes(action)) {
      return NextResponse.json({ error: '需要有效的评审会和操作类型' }, { status: 400 });
    }

    const updates = action === 'soft_delete'
      ? { deleted_at: new Date().toISOString(), scheduled_purge_at: null, status: 'archived', is_current: false }
      : { deleted_at: null, scheduled_purge_at: null, status: 'active' };
    const { data, error } = await supabaseAdmin.from('meetings').update(updates).eq('id', id).select().single();
    if (error) throw error;
    return NextResponse.json({ success: true, meeting: data, operator: session.code });
  } catch (err: any) {
    return NextResponse.json({ error: `评审会操作失败: ${err.message}` }, { status: 500 });
  }
}
