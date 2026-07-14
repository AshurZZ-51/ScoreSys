import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled, supabaseAdmin } from '@/lib/supabase';
import { getPurgeAfter } from '@/lib/adminLifecycle';

export const dynamic = 'force-dynamic';

async function requireAdmin(code: string) {
  if (!code) return false;
  const { data } = await supabaseAdmin.from('reviewers').select('is_admin').eq('code', code).maybeSingle();
  return Boolean(data?.is_admin);
}

function isSuperAdmin(code: string) {
  return String(code || '').toLowerCase() === 'admin51';
}

export async function POST(request: NextRequest) {
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: 'Project pool is unavailable' }, { status: 404 });
  try {
    const { id, action, operator_code } = await request.json();
    if (!id || !['restore', 'request_purge', 'restore_purge'].includes(action)) {
      return NextResponse.json({ error: 'id and a valid archive action are required' }, { status: 400 });
    }
    if (!await requireAdmin(operator_code)) return NextResponse.json({ error: 'Only administrators can update archives' }, { status: 403 });
    if (['request_purge', 'restore_purge'].includes(action) && !isSuperAdmin(operator_code)) {
      return NextResponse.json({ error: 'Only admin51 can manage purge requests' }, { status: 403 });
    }

    const { data: project, error: projectError } = await supabaseAdmin
      .from('project_pool')
      .select('status, archived_at')
      .eq('id', id)
      .single();
    if (projectError) throw projectError;
    const requestedAt = new Date();
    const now = requestedAt.toISOString();

    if (action === 'restore') {
      const { data: deletionRequest, error: deletionError } = await supabaseAdmin
        .from('project_deletion_requests')
        .select('project_id')
        .eq('project_id', id)
        .is('restored_at', null)
        .maybeSingle();
      if (deletionError) throw deletionError;
      if (deletionRequest) return NextResponse.json({ error: 'Restore the purge request before restoring the project' }, { status: 409 });
      const { error: restoreError } = await supabaseAdmin
        .from('project_pool')
        .update({ archived_at: null, updated_at: now })
        .eq('id', id);
      if (restoreError) throw restoreError;
      const { error: historyError } = await supabaseAdmin.from('project_status_history').insert({
        project_id: id,
        event_type: 'project_restored',
        from_status: 'archived',
        to_status: project.status,
        operator_code,
        note: 'Restored from archive'
      });
      if (historyError) throw historyError;
      return NextResponse.json({ success: true });
    }

    if (action === 'request_purge') {
      if (!project.archived_at) return NextResponse.json({ error: 'Only archived projects can be queued for purge' }, { status: 409 });
      const { error: requestError } = await supabaseAdmin.from('project_deletion_requests').upsert({
        project_id: id,
        requested_by: operator_code,
        requested_at: now,
        purge_after: getPurgeAfter(requestedAt),
        restored_at: null,
        restored_by: null
      }, { onConflict: 'project_id' });
      if (requestError) throw requestError;
      const { error: historyError } = await supabaseAdmin.from('project_status_history').insert({
        project_id: id,
        event_type: 'purge_requested',
        from_status: project.status,
        to_status: 'archived',
        operator_code,
        note: 'Purge requested with a 15-day recovery window'
      });
      if (historyError) throw historyError;
      return NextResponse.json({ success: true, purge_after: getPurgeAfter(requestedAt) });
    }

    const { data: restoredRequest, error: restoreRequestError } = await supabaseAdmin
      .from('project_deletion_requests')
      .update({ restored_at: now, restored_by: operator_code })
      .eq('project_id', id)
      .is('restored_at', null)
      .select('project_id')
      .maybeSingle();
    if (restoreRequestError) throw restoreRequestError;
    if (!restoredRequest) return NextResponse.json({ error: 'No active purge request exists' }, { status: 404 });
    const { error: historyError } = await supabaseAdmin.from('project_status_history').insert({
      project_id: id,
      event_type: 'purge_restored',
      from_status: 'archived',
      to_status: 'archived',
      operator_code,
      note: 'Purge request restored to archive'
    });
    if (historyError) throw historyError;
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: `Archive action failed: ${err.message}` }, { status: 500 });
  }
}
