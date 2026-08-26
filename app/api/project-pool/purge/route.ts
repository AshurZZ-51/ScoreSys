import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled } from '@/lib/featureFlags';
import { isSuperAdminSession, requireAdminSession } from '@/lib/adminSession';
import { purgeDueProjectDeletions } from '@/lib/db/repositories/rpc';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: 'Project pool is unavailable' }, { status: 404 });
  try {
    const session = requireAdminSession(request);
    if (!isSuperAdminSession(session)) return NextResponse.json({ error: 'Only admin51 can run purge cleanup' }, { status: 403 });
    const purged = await purgeDueProjectDeletions();
    return NextResponse.json({ success: true, purged: purged.length });
  } catch (err: any) {
    return NextResponse.json({ error: `Purge cleanup failed: ${err.message}` }, { status: 500 });
  }
}
