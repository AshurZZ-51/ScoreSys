import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled, supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

async function requireAdmin(code: string) {
  if (!code) return false;
  const { data } = await supabaseAdmin.from('reviewers').select('is_admin').eq('code', code).maybeSingle();
  return Boolean(data?.is_admin);
}

function nextVerdict(status: string, currentVerdict: string | null) {
  if (status === 'rejected') return 'rejected';
  if (status === 'initiation' || status === 'ready_r2') return 'approved';
  if (status.includes('recheck')) return 'recheck';
  return currentVerdict;
}

export async function POST(request: NextRequest) {
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: 'Project pool is unavailable' }, { status: 404 });
  try {
    const { ids, action, status, operator_code, reason = '' } = await request.json();
    if (!await requireAdmin(operator_code)) return NextResponse.json({ error: 'Only administrators can update projects' }, { status: 403 });
    const projectIds = Array.isArray(ids) ? Array.from(new Set(ids.filter((id) => typeof id === 'string' && id))) : [];
    if (!projectIds.length || !['status', 'archive'].includes(action)) {
      return NextResponse.json({ error: 'ids and a valid action are required' }, { status: 400 });
    }
    if (action === 'status' && !String(status || '').trim()) {
      return NextResponse.json({ error: 'status is required for bulk status updates' }, { status: 400 });
    }

    const now = new Date().toISOString();
    const note = String(reason).trim() || (action === 'archive' ? 'Bulk archive' : 'Bulk status update');
    for (const projectId of projectIds) {
      const { data: project, error: readError } = await supabaseAdmin
        .from('project_pool')
        .select('status, latest_verdict')
        .eq('id', projectId)
        .single();
      if (readError) throw readError;

      if (action === 'status') {
        const { error: updateError } = await supabaseAdmin
          .from('project_pool')
          .update({ status, latest_verdict: nextVerdict(status, project.latest_verdict), updated_at: now })
          .eq('id', projectId);
        if (updateError) throw updateError;
        const { error: historyError } = await supabaseAdmin.from('project_status_history').insert({
          project_id: projectId,
          event_type: 'admin_adjustment',
          from_status: project.status,
          to_status: status,
          operator_code,
          note
        });
        if (historyError) throw historyError;
      } else {
        const { error: archiveError } = await supabaseAdmin
          .from('project_pool')
          .update({ archived_at: now, updated_at: now })
          .eq('id', projectId);
        if (archiveError) throw archiveError;
        const { error: historyError } = await supabaseAdmin.from('project_status_history').insert({
          project_id: projectId,
          event_type: 'project_archived',
          from_status: project.status,
          to_status: 'archived',
          operator_code,
          note
        });
        if (historyError) throw historyError;
      }
    }

    return NextResponse.json({ success: true, updated: projectIds.length });
  } catch (err: any) {
    return NextResponse.json({ error: `Bulk project update failed: ${err.message}` }, { status: 500 });
  }
}
