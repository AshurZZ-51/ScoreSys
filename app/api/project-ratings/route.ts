import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled } from '@/lib/featureFlags';
import { isSameReviewerCode, requireReviewerSession } from '@/lib/adminSession';
import { normalizeProjectRating } from '@/lib/projectReviewerRating';
import { findReviewerByCode } from '@/lib/db/repositories/reviewers';
import {
  findMeetingReviewerSnapshot,
  getProjectRatingAssignment,
  listProjectRatings,
  upsertProjectRating,
} from '@/lib/db/repositories/scores';

export const dynamic = 'force-dynamic';

async function getReviewer(request: NextRequest) {
  const session = requireReviewerSession(request);
  if (!session) return null;
  const reviewer = await findReviewerByCode(session.code);
  if (!reviewer || reviewer.is_admin) return null;
  return reviewer;
}

async function getReadReviewer(request: NextRequest) {
  const session = requireReviewerSession(request);
  if (!session) return null;
  const reviewer = await findReviewerByCode(session.code);
  if (!reviewer || reviewer.is_admin) return null;
  return reviewer;
}

export async function GET(request: NextRequest) {
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: '项目池功能尚未启用' }, { status: 404 });
  try {
    const reviewer = await getReadReviewer(request);
    if (!reviewer) return NextResponse.json({ error: '请使用评委账号登录' }, { status: 403 });
    const { searchParams } = new URL(request.url);
    const meetingId = searchParams.get('meetingId');
    const projectId = searchParams.get('projectId');
    if (!meetingId) return NextResponse.json({ error: 'meetingId 必填' }, { status: 400 });
    const ratings = await listProjectRatings({ meetingId, reviewerCode: reviewer.code, projectId });
    return NextResponse.json({ ratings }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (error: any) {
    return NextResponse.json({ error: `获取个人评级失败: ${error.message}` }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: '项目池功能尚未启用' }, { status: 404 });
  try {
    const session = requireReviewerSession(request);
    if (!session) return NextResponse.json({ error: '请先登录' }, { status: 401 });
    const reviewer = await getReviewer(request);
    if (!reviewer || !isSameReviewerCode(reviewer.code, session.code)) {
      return NextResponse.json({ error: '只有非管理员评委可以填写个人评级' }, { status: 403 });
    }
    const body = await request.json();
    const meetingId = String(body?.meeting_id || '');
    const projectId = String(body?.project_id || '');
    const rating = normalizeProjectRating(body?.rating);
    if (!meetingId || !projectId || !rating) return NextResponse.json({ error: 'meeting_id、project_id 和 S/A/B/C 评级必填' }, { status: 400 });

    const assignment = await getProjectRatingAssignment(meetingId, projectId);
    if (!assignment?.round_no) return NextResponse.json({ error: '项目尚未绑定评审轮次' }, { status: 400 });

    const snapshot = await findMeetingReviewerSnapshot(meetingId, reviewer.code);
    if (!snapshot) return NextResponse.json({ error: '您不在本场评审会的评委名单中' }, { status: 403 });

    const data = await upsertProjectRating({
      meetingId,
      projectId,
      reviewerCode: reviewer.code,
      roundNo: assignment.round_no,
      attemptNo: assignment.attempt_no || 1,
      rating,
      updatedAt: new Date().toISOString(),
    });
    return NextResponse.json({ success: true, rating: data });
  } catch (error: any) {
    return NextResponse.json({ error: `保存个人评级失败: ${error.message}` }, { status: 500 });
  }
}
