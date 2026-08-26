import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled } from '@/lib/featureFlags';
import { requireReviewerSession } from '@/lib/adminSession';
import { isValidProjectRating } from '@/lib/initiationWorkflow';
import { canEditFinalRating } from '@/lib/projectDetailWorkflow';
import { applyProjectRating, findReviewerByCode } from '@/lib/db/repositories/rpc';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: '项目池功能尚未启用' }, { status: 404 });
  const session = requireReviewerSession(request);
  if (!session) return NextResponse.json({ error: '请先登录' }, { status: 401 });

  try {
    const body = await request.json();
    const ratingType = body?.rating_type === 'final' ? 'final' : body?.rating_type === 'preliminary' ? 'preliminary' : '';
    const rating = String(body?.rating || '').trim().toUpperCase();
    if (!ratingType || !isValidProjectRating(rating)) return NextResponse.json({ error: '评级必须为 S/A/B/C' }, { status: 400 });

    const reviewer = await findReviewerByCode(session.code);
    if (!reviewer) throw new Error('reviewer not found');
    if (ratingType === 'final' && !reviewer?.is_admin && !canEditFinalRating(reviewer.code)) {
      return NextResponse.json({ error: '只有管理员或 Walker 可以修改最终评级' }, { status: 403 });
    }
    if (ratingType === 'preliminary' && !reviewer?.is_admin && !canEditFinalRating(reviewer.code)) {
      return NextResponse.json({ error: '只有管理员或 Walker 可以修改项目评级' }, { status: 403 });
    }

    const project = await applyProjectRating(id, ratingType, rating, session.code);
    return NextResponse.json({ success: true, project });
  } catch (err: any) {
    return NextResponse.json({ error: `保存项目评级失败: ${err.message}` }, { status: 500 });
  }
}
