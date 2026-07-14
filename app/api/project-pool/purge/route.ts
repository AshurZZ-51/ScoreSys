import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled, supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

async function requireSuperAdmin(code: string) {
  if (String(code || '').toLowerCase() !== 'admin51') return false;
  const { data } = await supabaseAdmin.from('reviewers').select('is_admin').eq('code', code).maybeSingle();
  return Boolean(data?.is_admin);
}

export async function POST(request: NextRequest) {
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: 'Project pool is unavailable' }, { status: 404 });
  try {
    const { operator_code } = await request.json();
    if (!await requireSuperAdmin(operator_code)) return NextResponse.json({ error: 'Only admin51 can run purge cleanup' }, { status: 403 });
    const now = new Date().toISOString();
    const { data: requests, error: requestError } = await supabaseAdmin
      .from('project_deletion_requests')
      .select('project_id')
      .is('restored_at', null)
      .lt('purge_after', now);
    if (requestError) throw requestError;
    const projectIds = (requests || []).map((item) => item.project_id);
    if (!projectIds.length) return NextResponse.json({ success: true, purged: 0 });

    const { data: assignments, error: assignmentError } = await supabaseAdmin
      .from('projects')
      .select('id')
      .in('pool_project_id', projectIds);
    if (assignmentError) throw assignmentError;
    const assignmentIds = (assignments || []).map((assignment) => assignment.id);
    if (assignmentIds.length) {
      const { error: scoresError } = await supabaseAdmin.from('scores').delete().in('project_id', assignmentIds);
      if (scoresError) throw scoresError;
    }
    const { error: projectsError } = await supabaseAdmin.from('projects').delete().in('pool_project_id', projectIds);
    if (projectsError) throw projectsError;
    const { error: poolError } = await supabaseAdmin.from('project_pool').delete().in('id', projectIds);
    if (poolError) throw poolError;

    return NextResponse.json({ success: true, purged: projectIds.length });
  } catch (err: any) {
    return NextResponse.json({ error: `Purge cleanup failed: ${err.message}` }, { status: 500 });
  }
}
