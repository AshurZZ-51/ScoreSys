import { NextResponse } from 'next/server';
import { query } from '@/lib/db/client';
import { getPoolStats } from '@/lib/db/pool';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    await query('SELECT 1');
    const { totalCount, idleCount, waitingCount } = getPoolStats();
    return NextResponse.json(
      { ok: true, pool: { totalCount, idleCount, waitingCount } },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch {
    return NextResponse.json(
      { ok: false },
      { status: 503, headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  }
}
