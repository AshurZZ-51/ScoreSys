import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled } from '@/lib/featureFlags';
import { transitionForVerdict } from '@/lib/projectPoolWorkflow';
import { getScoreMax, isValidScoreValue, parseScoreKey } from '@/lib/scoringRules';
import { isSameReviewerCode, requireAdminSession, requireReviewerSession } from '@/lib/adminSession';
import {
  ADMIN_TRACKING_SPECIAL_DIMENSIONS,
  getRoundFromDimName,
  nextStatusForVerdict,
  stripRoundPrefix
} from '@/lib/reviewWorkflow';
import { shouldAdvanceProjectWorkflow } from '@/lib/reviewerBlindReview';
import { listScores } from '@/lib/db/repositories/scores';
import {
  deleteScores,
  getScoringAssignment,
  getScoringMeeting,
  getScoringReviewer,
  hasReviewerDimension,
  isMeetingReviewer,
  submitScoreWorkflow
} from '@/lib/db/repositories/scoreWorkflow';

export const dynamic = 'force-dynamic';

const PROJECT_POOL_SCORING_VERSIONS = ['two_round_v2', 'two_round_v3', 'two_round_v4', 'two_round_v5'];

export async function GET(request: NextRequest) {
  try {
    if (!requireReviewerSession(request)) return NextResponse.json({ error: '请先登录' }, { status: 401 });
    const { searchParams } = new URL(request.url);
    const meetingId = searchParams.get('meetingId');
    const reviewerCode = searchParams.get('reviewerCode');
    const projectId = searchParams.get('projectId');

    if (!meetingId) {
      return NextResponse.json({ error: 'meetingId 必填' }, { status: 400 });
    }

    const scores = await listScores({ meetingId, reviewerCode, projectId });

    return NextResponse.json({ scores });
  } catch (err: any) {
    return NextResponse.json({ error: '获取评分失败: ' + err.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { meeting_id, project_id, reviewer_code, dim_name, score, comment } = body;

    const session = requireReviewerSession(request);
    if (!session || !isSameReviewerCode(reviewer_code, session.code)) {
      return NextResponse.json({ error: '登录身份与评分人不一致' }, { status: 403 });
    }

    if (!meeting_id || !project_id || !reviewer_code || !dim_name || score === undefined) {
      return NextResponse.json({ error: '参数不完整' }, { status: 400 });
    }

    const meeting = await getScoringMeeting(meeting_id);

    if (!meeting) return NextResponse.json({ error: '评审会不存在' }, { status: 404 });

    if (meeting.status === 'archived' || meeting.status === 'locked') {
      return NextResponse.json({ error: '该评审会已锁定/归档，无法修改' }, { status: 403 });
    }

    if (meeting.deadline && new Date() > new Date(meeting.deadline)) {
      return NextResponse.json({ error: '已超过打分截止日期' }, { status: 403 });
    }

    const assignment = await getScoringAssignment(meeting_id, project_id);
    if (!assignment) return NextResponse.json({ error: '评审项目不存在' }, { status: 404 });
    const isV2Assignment = isProjectPoolV2Enabled() && PROJECT_POOL_SCORING_VERSIONS.includes(assignment.scoring_version);
    const scoringVersion = PROJECT_POOL_SCORING_VERSIONS.includes(assignment.scoring_version)
      ? assignment.scoring_version
      : 'two_round_v2';

    const reviewerInfo = await getScoringReviewer(reviewer_code);

    const baseDimName = stripRoundPrefix(dim_name);
    const parsedScore = parseScoreKey(dim_name, scoringVersion);

    if (isV2Assignment && parsedScore?.roundId !== `r${assignment.round_no}` && !baseDimName.startsWith('__')) {
      return NextResponse.json({ error: '该项目不属于当前评分轮次' }, { status: 400 });
    }
    if (isV2Assignment && !reviewerInfo?.is_admin) {
      if (!await isMeetingReviewer(meeting_id, reviewer_code)) {
        return NextResponse.json({ error: '您不在本场评审会的评委名单中' }, { status: 403 });
      }
    }

    if (baseDimName === '__bonus__') {
      if (reviewer_code.toUpperCase() !== 'W') {
        return NextResponse.json({ error: '只有 Walker 可以使用加分项' }, { status: 403 });
      }
    } else if (baseDimName === '__special_vote__') {
      if (reviewerInfo?.is_admin) {
        return NextResponse.json({ error: '管理员不能填写特别推荐票' }, { status: 403 });
      }
    } else if (baseDimName === '__verdict__') {
      if (reviewerInfo?.is_admin) {
        return NextResponse.json({ error: '管理员不能填写个人评审结论' }, { status: 403 });
      }
    } else if (baseDimName === '__admin_verdict__') {
      if (!reviewerInfo?.is_admin) {
        return NextResponse.json({ error: '只有管理员可以修改推荐结论' }, { status: 403 });
      }
      if (comment && !['approved', 'recheck', 'rejected'].includes(comment)) {
        return NextResponse.json({ error: '无效结论' }, { status: 400 });
      }
    } else if (baseDimName === '__problems__' || baseDimName === '__actions__') {
      // Text-only review fields reuse the score table.
    } else if (ADMIN_TRACKING_SPECIAL_DIMENSIONS.has(baseDimName)) {
      if (!reviewerInfo?.is_admin) {
        return NextResponse.json({ error: '只有管理员可以更新项目追踪字段' }, { status: 403 });
      }
    } else if (parsedScore?.roundId) {
      if (reviewerInfo?.is_admin) {
        return NextResponse.json({ error: '管理员账号不参与评委评分' }, { status: 403 });
      }
    } else {
      const parentDimension = parsedScore?.dimensionName || dim_name;
      const dimensions = parentDimension === '风险评估' ? [parentDimension, '风险性'] : [parentDimension];
      if (!await hasReviewerDimension(reviewer_code, dimensions)) {
        return NextResponse.json({ error: '您没有该维度的评分权限' }, { status: 403 });
      }
    }

    const maxScore = getScoreMax(dim_name, scoringVersion);
    if (maxScore === null) {
      return NextResponse.json({ error: '未知评分项' }, { status: 400 });
    }

    const scoreNum = Number(score);
    if (!isValidScoreValue(dim_name, scoreNum, scoringVersion)) {
      const parsed = parseScoreKey(dim_name, scoringVersion);
      const hint = parsed?.rule?.type === 'level' && !parsed.legacy
        ? `必须选择 ${parsed.rule.levels.join('/')} 档位`
        : `分数必须在 0-${maxScore} 之间`;
      return NextResponse.json({ error: hint }, { status: 400 });
    }

    if (baseDimName === '__admin_verdict__' && !comment) {
      await deleteScores({ meetingId: meeting_id, projectId: project_id, reviewerCode: reviewer_code, dimName: dim_name });
      return NextResponse.json({ success: true, score: null, cleared: true });
    }

    let followUp: Parameters<typeof submitScoreWorkflow>[0]['followUp'] = { type: 'none' };
    if (baseDimName === '__verdict__' && comment && isV2Assignment && shouldAdvanceProjectWorkflow(reviewer_code)) {
      const transition = transitionForVerdict(Number(assignment.round_no), Number(assignment.attempt_no), comment);
      if (!transition.ok) return NextResponse.json({ error: transition.error }, { status: 400 });
      followUp = {
        type: 'project_pool_verdict',
        assignmentId: project_id,
        poolProjectId: assignment.pool_project_id!,
        status: transition.status,
        currentRound: transition.currentRound,
        currentAttempt: transition.currentAttempt,
        verdict: transition.verdict,
        meetingId: meeting_id,
        operatorCode: reviewer_code,
        note: comment
      };
    } else if (baseDimName === '__verdict__' && comment && !isV2Assignment) {
      const verdictRound = getRoundFromDimName(dim_name);
      if (verdictRound) {
        const nextStatus = nextStatusForVerdict(verdictRound, comment);
        const nextRound = verdictRound === 'r1' && comment === 'approved' ? 'r2' : verdictRound;
        const trackingScores = [
          {
            meetingId: meeting_id,
            projectId: project_id,
            reviewerCode: reviewer_code,
            dimName: '__review_status__',
            score: 0,
            comment: nextStatus,
            updatedAt: new Date().toISOString()
          },
          {
            meetingId: meeting_id,
            projectId: project_id,
            reviewerCode: reviewer_code,
            dimName: '__current_round__',
            score: 0,
            comment: nextRound,
            updatedAt: new Date().toISOString()
          }
        ];
        if (comment === 'recheck') {
          trackingScores.push({
            meetingId: meeting_id,
            projectId: project_id,
            reviewerCode: reviewer_code,
            dimName: verdictRound === 'r1' ? '__r1_retry_count__' : '__r2_retry_count__',
            score: 0,
            comment: '1',
            updatedAt: new Date().toISOString()
          });
        }
        followUp = { type: 'legacy_verdict', trackingScores };
      }
    }

    const savedScore = await submitScoreWorkflow({
      score: {
        meetingId: meeting_id,
        projectId: project_id,
        reviewerCode: reviewer_code,
        dimName: dim_name,
        score: scoreNum,
        comment: comment || null,
        updatedAt: new Date().toISOString()
      },
      followUp
    });

    return NextResponse.json({ success: true, score: savedScore });
  } catch (err: any) {
    console.error('Submit score error:', err);
    return NextResponse.json({ error: '提交评分失败: ' + err.message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const session = requireReviewerSession(request);
    if (!session) return NextResponse.json({ error: '请先登录' }, { status: 401 });
    const adminSession = requireAdminSession(request);
    const { searchParams } = new URL(request.url);
    const meetingId = searchParams.get('meetingId');
    const reviewerCode = searchParams.get('reviewerCode');
    const projectId = searchParams.get('projectId');

    if (!meetingId) return NextResponse.json({ error: 'meetingId 必填' }, { status: 400 });
    if (!adminSession && !reviewerCode) {
      return NextResponse.json({ error: 'reviewerCode 必填' }, { status: 400 });
    }
    if (!adminSession && !isSameReviewerCode(reviewerCode, session.code)) {
      return NextResponse.json({ error: '登录身份与评分人不一致' }, { status: 403 });
    }

    await deleteScores({ meetingId, reviewerCode, projectId });

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: '重置评分失败: ' + err.message }, { status: 500 });
  }
}
