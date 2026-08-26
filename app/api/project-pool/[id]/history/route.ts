import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled } from '@/lib/featureFlags';
import { computeLegacyProjectScore, extractLegacyFeedback } from '@/lib/legacyScoring';
import { isCompletedReview } from '@/lib/adminLifecycle';
import { getProjectHistory } from '@/lib/db/repositories/projectHistory';

export const dynamic = 'force-dynamic';

export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: '项目池功能尚未启用' }, { status: 404 });
  try {
    const result = await getProjectHistory(id);
    const enrichedAssignments = result.assignments.map((assignment: any) => {
      const scores = assignment.scores || [];
      const isLegacy = assignment.scoring_version === 'legacy_v1' || !scores.some((score: any) => String(score.dim_name || '').startsWith('r'));
      const feedback = extractLegacyFeedback(scores);
      return { ...assignment, history_summary: isLegacy ? { ...computeLegacyProjectScore(scores), problems: feedback.problems, actions: feedback.actions } : null };
    });
    const completedReviews = enrichedAssignments.filter(isCompletedReview);
    return NextResponse.json({ project: result.project, history: result.history, assignments: enrichedAssignments, completed_reviews: completedReviews });
  } catch (err: any) {
    return NextResponse.json({ error: `获取项目历史失败: ${err.message}` }, { status: err.status === 404 ? 404 : 500 });
  }
}
