import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled } from '@/lib/featureFlags';
import { getMaterialProgress, makeMatchKey, normalizeProjectPart } from '@/lib/projectPoolWorkflow';
import { countCompletedReviews, hasCompletedReview, isPendingReviewProject } from '@/lib/adminLifecycle';
import { requireAdminSession, requireReviewerSession } from '@/lib/adminSession';
import { listProjectPool } from '@/lib/db/repositories/projectPool';
import { createProjectWithMaterials, updateProjectDetails } from '@/lib/db/repositories/projectPoolWorkflow';
import { applyProjectPoolMutations } from '@/lib/db/repositories/rpc';

export const dynamic = 'force-dynamic';

function getMonthRange(month: string | null) {
  if (!month) return null;
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return undefined;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return undefined;
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

function unavailable() {
  return NextResponse.json({ error: '项目池功能尚未启用' }, { status: 404 });
}

export async function GET(request: NextRequest) {
  if (!requireReviewerSession(request)) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  if (!isProjectPoolV2Enabled()) return unavailable();
  try {
    const searchParams = new URL(request.url).searchParams;
    const scope = searchParams.get('scope') || 'active';
    if (!['active', 'archived', 'purge_pending', 'pending', 'reviewed'].includes(scope)) {
      return NextResponse.json({ error: 'Invalid project scope' }, { status: 400 });
    }
    const monthRange = getMonthRange(searchParams.get('month'));
    if (monthRange === undefined) return NextResponse.json({ error: 'month must use YYYY-MM' }, { status: 400 });
    const data = await listProjectPool({
      scope,
      monthStart: monthRange?.start,
      monthEnd: monthRange?.end,
    });
    const now = new Date();
    const projects = (data || [])
      .filter((project: any) => {
        const deletionRequest = Array.isArray(project.project_deletion_requests)
          ? project.project_deletion_requests[0]
          : project.project_deletion_requests;
        const isActiveDeletionRequest = deletionRequest && !deletionRequest.restored_at;
        if (scope === 'archived') return !isActiveDeletionRequest;
        if (scope === 'purge_pending') return isActiveDeletionRequest && new Date(deletionRequest.purge_after).getTime() > now.getTime();
        return true;
      })
      .map((project: any) => ({
        ...project,
        material_progress: getMaterialProgress(project.project_materials || []),
        completed_review_count: countCompletedReviews(project.projects || [])
      }));
    const scopedProjects = scope === 'pending' ? projects.filter(isPendingReviewProject) : scope === 'reviewed' ? projects.filter(hasCompletedReview) : projects;
    return NextResponse.json({ projects: scopedProjects }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    return NextResponse.json({ error: `获取项目池失败: ${err.message}` }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!isProjectPoolV2Enabled()) return unavailable();
  try {
    const { name, submitter, description = '', material_statuses: materialStatuses = {} } = await request.json();
    const session = requireAdminSession(request);
    if (!session) return NextResponse.json({ error: '只有管理员可以创建项目' }, { status: 403 });
    if (!String(name || '').trim() || !String(submitter || '').trim()) return NextResponse.json({ error: '项目名称和提报人必填' }, { status: 400 });
    const result = await createProjectWithMaterials({
      name: String(name).trim(),
      submitter: String(submitter).trim(),
      description: String(description).trim(),
      normalizedName: normalizeProjectPart(name),
      normalizedSubmitter: normalizeProjectPart(submitter),
      matchKey: makeMatchKey(name, submitter),
      materialStatuses,
    }, session.code);
    return NextResponse.json({ success: true, project: result.project, materials: result.materials });
  } catch (err: any) {
    return NextResponse.json({ error: `创建项目失败: ${err.message}` }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  if (!isProjectPoolV2Enabled()) return unavailable();
  try {
    const { id, name, submitter, description } = await request.json();
    const session = requireAdminSession(request);
    if (!session) return NextResponse.json({ error: '只有管理员可以编辑项目' }, { status: 403 });
    if (!id || !String(name || '').trim() || !String(submitter || '').trim()) return NextResponse.json({ error: '项目名称和提报人必填' }, { status: 400 });
    const project = await updateProjectDetails(id, {
      name: String(name).trim(),
      submitter: String(submitter).trim(),
      description: String(description || '').trim(),
      normalizedName: normalizeProjectPart(name),
      normalizedSubmitter: normalizeProjectPart(submitter),
      matchKey: makeMatchKey(name, submitter),
    });
    return NextResponse.json({ success: true, project });
  } catch (err: any) {
    return NextResponse.json({ error: `更新项目失败: ${err.message}` }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!isProjectPoolV2Enabled()) return unavailable();
  try {
    const id = new URL(request.url).searchParams.get('id');
    const session = requireAdminSession(request);
    if (!id || !session) return NextResponse.json({ error: 'Unauthorized or missing parameters' }, { status: 403 });
    const mutations = await applyProjectPoolMutations([id], 'archive', null, session.code, 'Archived by administrator');
    if (!mutations.length) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: `删除项目失败: ${err.message}` }, { status: 500 });
  }
}
