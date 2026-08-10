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

    const { data: current, error: currentError } = await supabaseAdmin.from('project_pool').select('id, preliminary_rating, final_rating').eq('id', params.id).single();
    if (currentError) throw currentError;
    const column = ratingType === 'final' ? 'final_rating' : 'preliminary_rating';
    const fromRating = current[column];
    const { data: project, error: updateError } = await supabaseAdmin.from('project_pool').update({
      [column]: rating,
      rating_updated_at: new Date().toISOString(),
      rating_updated_by: session.code,
      updated_at: new Date().toISOString()
    }).eq('id', params.id).select().single();
    if (updateError) throw updateError;

    const { error: historyError } = await supabaseAdmin.from('project_rating_history').insert({
      project_id: params.id,
      rating_type: ratingType,
      from_rating: fromRating || null,
      to_rating: rating,
      operator_code: session.code
    });
    if (historyError) throw historyError;
    return NextResponse.json({ success: true, project });
  } catch (err: any) {
    return NextResponse.json({ error: `保存项目评级失败: ${err.message}` }, { status: 500 });
  }
}
