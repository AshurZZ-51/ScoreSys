import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled, supabaseAdmin } from '@/lib/supabase';
import { requireReviewerSession } from '@/lib/adminSession';
import { isValidProjectRating } from '@/lib/initiationWorkflow';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: '项目池功能尚未启用' }, { status: 404 });
  const session = requireReviewerSession(request);
  if (!session) return NextResponse.json({ error: '请先登录' }, { status: 401 });

  try {
    const body = await request.json();
    const ratingType = body?.rating_type === 'final' ? 'final' : body?.rating_type === 'preliminary' ? 'preliminary' : '';
    const rating = String(body?.rating || '').trim().toUpperCase();
    if (!ratingType || !isValidProjectRating(rating)) return NextResponse.json({ error: '评级必须为 S/A/B/C' }, { status: 400 });

    const { data: reviewer, error: reviewerError } = await supabaseAdmin.from('reviewers').select('code, is_admin').ilike('code', session.code).single();
    if (reviewerError) throw reviewerError;
    if (!reviewer?.is_admin && String(reviewer.code).toUpperCase() !== 'W') {
      return NextResponse.json({ error: '只有管理员或 Walker 可以修改项目评级' }, { status: 403 });
    }

    const { data: rawProject, error } = await supabaseAdmin.rpc('apply_project_rating', {
      p_project_id: params.id,
      p_rating_type: ratingType,
      p_rating: rating,
      p_operator_code: session.code
    });
    if (error) throw error;
    const project = Array.isArray(rawProject) ? rawProject[0] : rawProject;
    return NextResponse.json({ success: true, project });
  } catch (err: any) {
    return NextResponse.json({ error: `保存项目评级失败: ${err.message}` }, { status: 500 });
  }
}
