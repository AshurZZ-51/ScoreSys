import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled, supabaseAdmin } from '@/lib/supabase';
import { isSuperAdminSession, requireAdminSession } from '@/lib/adminSession';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: 'Project pool is unavailable' }, { status: 404 });
  try {
    const session = requireAdminSession(request);
    if (!isSuperAdminSession(session)) return NextResponse.json({ error: 'Only admin51 can run purge cleanup' }, { status: 403 });
    const { data, error } = await supabaseAdmin.rpc('purge_due_project_deletions');
    if (error) throw error;
    return NextResponse.json({ success: true, purged: data?.length || 0 });
  } catch (err: any) {
    return NextResponse.json({ error: `Purge cleanup failed: ${err.message}` }, { status: 500 });
  }
}
