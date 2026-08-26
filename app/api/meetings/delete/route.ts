import { NextRequest, NextResponse } from 'next/server';
import { requireAdminSession } from '@/lib/adminSession';
import { updateMeeting } from '@/lib/db/repositories/meetingMutations';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const { id, action } = await request.json();
    const session = requireAdminSession(request);
    if (!session) return NextResponse.json({ error: '仅管理员可以管理评审会' }, { status: 403 });
    if (!id || !['soft_delete', 'restore'].includes(action)) {
      return NextResponse.json({ error: '需要有效的评审会和操作类型' }, { status: 400 });
    }

    const meeting = await updateMeeting(id, action);
    return NextResponse.json({ success: true, meeting, operator: session.code });
  } catch (err: any) {
    return NextResponse.json({ error: `评审会操作失败: ${err.message}` }, { status: 500 });
  }
}
