import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled, supabaseAdmin } from '@/lib/supabase';
import { requireAdminSession } from '@/lib/adminSession';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: 'Project pool is unavailable' }, { status: 404 });
  try {
    const { ids, action, status, reason = '' } = await request.json();
    const session = requireAdminSession(request);
    if (!session) return NextResponse.json({ error: 'Only administrators can update projects' }, { status: 403 });
    const projectIds = Array.isArray(ids) ? Array.from(new Set(ids.filter((id) => typeof id === 'string' && id))) : [];
    if (!projectIds.length || !['status', 'archive'].includes(action)) {
      return NextResponse.json({ error: 'ids and a valid action are required' }, { status: 400 });
    }
    if (action === 'status' && !String(status || '').trim()) {
      return NextResponse.json({ error: 'status is required for bulk status updates' }, { status: 400 });
    }

    const note = String(reason).trim() || (action === 'archive' ? 'Bulk archive' : 'Bulk status update');
    const { data, error } = await supabaseAdmin.rpc('apply_project_pool_mutations', {
      p_project_ids: projectIds, p_action: action, p_status: action === 'status' ? String(status).trim() : null,
      p_operator_code: session.code, p_note: note
    });
    if (error) throw error;
    return NextResponse.json({ success: true, updated: data?.length || 0 });
  } catch (err: any) {
    return NextResponse.json({ error: `Bulk project update failed: ${err.message}` }, { status: 500 });
  }
}
