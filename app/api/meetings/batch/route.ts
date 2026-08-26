import { NextRequest, NextResponse } from 'next/server';
import { requireAdminSession } from '@/lib/adminSession';
import { batchUpdateMeetings } from '@/lib/db/repositories/meetingMutations';

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
    const updated = await batchUpdateMeetings(meetingIds, action);
    return NextResponse.json({ success: true, updated: updated.length, operator: session.code });
  } catch (err: any) {
    return NextResponse.json({ error: `批量评审会操作失败: ${err.message}` }, { status: 500 });
  }
}
