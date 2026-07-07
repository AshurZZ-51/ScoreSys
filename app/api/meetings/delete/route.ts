import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// 软删除（标记 3 天后清理）
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, action } = body;  // action: 'soft_delete' | 'restore' | 'purge'

    if (!id) {
      return NextResponse.json({ error: 'id 必填' }, { status: 400 });
    }

    if (action === 'soft_delete') {
      const purgeAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabaseAdmin
        .from('meetings')
        .update({
          deleted_at: new Date().toISOString(),
          scheduled_purge_at: purgeAt,
          status: 'pending_delete',
          is_current: false
        })
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      return NextResponse.json({ success: true, meeting: data, message: '已标记删除，3天后将自动清理' });
    }

    if (action === 'restore') {
      const { data, error } = await supabaseAdmin
        .from('meetings')
        .update({
          deleted_at: null,
          scheduled_purge_at: null,
          status: 'active'
        })
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      return NextResponse.json({ success: true, meeting: data, message: '已恢复' });
    }

    if (action === 'purge') {
      // 立即彻底删除（不可恢复）
      // 1. 删除关联项目
      await supabaseAdmin.from('projects').delete().eq('meeting_id', id);
      // 2. 删除关联评分
      await supabaseAdmin.from('scores').delete().eq('meeting_id', id);
      // 3. 删除会议
      const { error } = await supabaseAdmin.from('meetings').delete().eq('id', id);
      if (error) throw error;
      return NextResponse.json({ success: true, message: '已彻底删除' });
    }

    return NextResponse.json({ error: '未知 action' }, { status: 400 });
  } catch (err: any) {
    console.error('Meeting delete error:', err);
    return NextResponse.json(
      { error: '操作失败: ' + err.message },
      { status: 500 }
    );
  }
}
