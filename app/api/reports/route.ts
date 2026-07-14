import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { requireAdminSession } from '@/lib/adminSession';
import { buildInitiationProjectPayload, buildMeetingReportPayload, nextSnapshotVersion } from '@/lib/reportSnapshots';

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
  const session = requireAdminSession(request);
  if (!session) return NextResponse.json({ error: '仅管理员可以读取报告快照' }, { status: 403 });
  const { searchParams } = new URL(request.url);
  const scopeType = searchParams.get('scope_type');
  const scopeId = searchParams.get('scope_id');
  const reportType = searchParams.get('report_type');
  if (!validScope(scopeType, scopeId, reportType)) return NextResponse.json({ error: '报告范围或类型无效' }, { status: 400 });
  const { data, error } = await supabaseAdmin.from('report_snapshots')
    .select('id, scope_type, scope_id, report_type, version, payload, generated_by, generated_at')
    .eq('scope_type', scopeType).eq('scope_id', scopeId).eq('report_type', reportType)
    .order('version', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ snapshots: data || [] });
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
      const [{ data: project, error: projectError }, { data: assignments, error: assignmentError }, { data: timeline, error: historyError }] = await Promise.all([
        supabaseAdmin.from('project_pool').select('id, name, submitter, description, status').eq('id', scopeId).single(),
        supabaseAdmin.from('projects').select('meeting_id').eq('pool_project_id', scopeId),
        supabaseAdmin.from('project_status_history').select('event_type, from_status, to_status, note, created_at').eq('project_id', scopeId).order('created_at')
      ]);
      if (projectError || !project) throw projectError || new Error('项目不存在');
      if (assignmentError) throw assignmentError;
      if (historyError) throw historyError;
      const meetingIds = Array.from(new Set((assignments || []).map((item: any) => item.meeting_id).filter(Boolean)));
      const summaries = await Promise.all(meetingIds.map((meetingId) => readSummary(request, meetingId)));
      payload = buildInitiationProjectPayload(project, summaries, timeline || []);
    }

    const { data: existing, error: existingError } = await supabaseAdmin.from('report_snapshots')
      .select('version').eq('scope_type', scopeType).eq('scope_id', scopeId).eq('report_type', reportType);
    if (existingError) throw existingError;
    const version = nextSnapshotVersion(existing || []);
    const { data: snapshot, error } = await supabaseAdmin.from('report_snapshots').insert({
      scope_type: scopeType, scope_id: scopeId, report_type: reportType, version, payload, generated_by: session.code
    }).select('id, scope_type, scope_id, report_type, version, payload, generated_by, generated_at').single();
    if (error) throw error;
    return NextResponse.json({ snapshot }, { status: 201 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || '生成报告快照失败' }, { status: 500 });
  }
}
