import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled } from '@/lib/featureFlags';
import { getPurgeAfter } from '@/lib/adminLifecycle';
import { isSuperAdminSession, requireAdminSession } from '@/lib/adminSession';
import { archiveProject } from '@/lib/db/repositories/projectPoolWorkflow';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: 'Project pool is unavailable' }, { status: 404 });
  try {
    const { id, action } = await request.json();
    if (!id || !['restore', 'request_purge', 'restore_purge'].includes(action)) {
      return NextResponse.json({ error: 'id and a valid archive action are required' }, { status: 400 });
    }
    const session = requireAdminSession(request);
    if (!session) return NextResponse.json({ error: 'Only administrators can update archives' }, { status: 403 });
    if (['request_purge', 'restore_purge'].includes(action) && !isSuperAdminSession(session)) {
      return NextResponse.json({ error: 'Only admin51 can manage purge requests' }, { status: 403 });
    }

    const requestedAt = new Date();
    const now = requestedAt.toISOString();
    const result = await archiveProject(id, action, session.code, { now, purgeAfter: getPurgeAfter(requestedAt) });
    if (!result.success) return NextResponse.json({ error: result.error }, { status: result.status || 400 });
    return NextResponse.json(result.purge_after ? { success: true, purge_after: result.purge_after } : { success: true });
  } catch (err: any) {
    return NextResponse.json({ error: `Archive action failed: ${err.message}` }, { status: 500 });
  }
}
