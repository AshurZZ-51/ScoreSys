import { NextRequest, NextResponse } from 'next/server';
import { requireAdminSession, requireReviewerSession } from '@/lib/adminSession';
import { buildInitiationProjectPayload, buildMeetingReportPayload } from '@/lib/reportSnapshots';
import { createReportSnapshot, getProjectReportData, listReportSnapshots } from '@/lib/db/repositories/reports';

export const dynamic = 'force-dynamic';

const meetingReportTypes = new Set(['round_1', 'round_2']);

function validScope(scopeType: string | null, scopeId: string | null, reportType: string | null) {
  return Boolean(scopeId && ((scopeType === 'meeting' && meetingReportTypes.has(reportType || '')) || (scopeType === 'project' && reportType === 'initiation')));
}

async function readSummary(request: NextRequest, meetingId: string) {
  const url = new URL('/api/summary', request.url);
  url.searchParams.set('meetingId', meetingId);
  const response = await fetch(url, { cache: 'no-store', headers: { cookie: request.headers.get('cookie') || '' } });
  if (!response.ok) throw new Error((await response.json()).error || '无法读取会议汇总');
  return response.json();
}

export async function GET(request: NextRequest) {
  if (!requireReviewerSession(request)) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  const session = requireAdminSession(request);
  if (!session) return NextResponse.json({ error: '仅管理员可以读取报告快照' }, { status: 403 });
  const { searchParams } = new URL(request.url);
  const scopeType = searchParams.get('scope_type');
  const scopeId = searchParams.get('scope_id');
  const reportType = searchParams.get('report_type');
  if (!validScope(scopeType, scopeId, reportType)) return NextResponse.json({ error: '报告范围或类型无效' }, { status: 400 });
  try {
    const snapshots = await listReportSnapshots({ scopeType: scopeType!, scopeId: scopeId!, reportType: reportType! });
    return NextResponse.json({ snapshots });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = requireAdminSession(request);
  if (!session) return NextResponse.json({ error: '仅管理员可以生成报告快照' }, { status: 403 });
  try {
    const { scope_type: scopeType, scope_id: scopeId, report_type: reportType } = await request.json();
    if (!validScope(scopeType, scopeId, reportType)) return NextResponse.json({ error: '报告范围或类型无效' }, { status: 400 });

    let payload: Record<string, any>;
    if (scopeType === 'meeting') {
      const summary = await readSummary(request, scopeId);
      payload = buildMeetingReportPayload(summary, summary.meeting, reportType);
    } else {
      const { project, assignments, timeline } = await getProjectReportData(scopeId);
      const meetingIds = Array.from(new Set((assignments || []).map((item: any) => item.meeting_id).filter(Boolean)));
      const summaries = await Promise.all(meetingIds.map((meetingId) => readSummary(request, meetingId)));
      payload = buildInitiationProjectPayload(project, summaries, timeline || []);
    }

    const snapshot = await createReportSnapshot({
      scopeType,
      scopeId,
      reportType,
      payload,
      generatedBy: session.code,
    });
    return NextResponse.json({ snapshot }, { status: 201 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || '生成报告快照失败' }, { status: 500 });
  }
}
