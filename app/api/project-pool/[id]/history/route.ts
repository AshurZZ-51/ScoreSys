import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled, supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: '项目池功能尚未启用' }, { status: 404 });
  try {
    const [project, history, assignments] = await Promise.all([
      supabaseAdmin.from('project_pool').select('*, project_materials(*)').eq('id', params.id).single(),
      supabaseAdmin.from('project_status_history').select('*').eq('project_id', params.id).order('created_at', { ascending: false }),
      supabaseAdmin.from('projects').select('*, meetings(id, name, meeting_date, status), scores(reviewer_code, dim_name, score, comment, updated_at)').eq('pool_project_id', params.id).order('created_at')
    ]);
    if (project.error) throw project.error;
    if (history.error) throw history.error;
    if (assignments.error) throw assignments.error;
    return NextResponse.json({ project: project.data, history: history.data || [], assignments: assignments.data || [] });
  } catch (err: any) {
    return NextResponse.json({ error: `获取项目历史失败: ${err.message}` }, { status: 500 });
  }
}
