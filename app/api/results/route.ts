import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled, supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: '项目池功能尚未启用' }, { status: 404 });
  try {
    const bucket = new URL(request.url).searchParams.get('bucket');
    let query = supabaseAdmin.from('project_pool').select('*, project_materials(*)').is('archived_at', null).order('updated_at', { ascending: false });
    if (bucket === 'approved') query = query.eq('latest_verdict', 'approved');
    if (bucket === 'recheck') query = query.eq('latest_verdict', 'recheck');
    if (bucket === 'rejected') query = query.eq('latest_verdict', 'rejected');
    const { data, error } = await query;
    if (error) throw error;
    return NextResponse.json({ projects: data || [] });
  } catch (err: any) {
    return NextResponse.json({ error: `获取结果池失败: ${err.message}` }, { status: 500 });
  }
}
