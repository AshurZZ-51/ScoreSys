import type { Connector } from '../client';
import { execute, maybeOne, one, query, tx } from '../client';
import { ConflictError, NotFoundError } from '../errors';
import { pool } from '../pool';
import {
  assignmentRoundForStatus,
  createMaterialRows,
  getMaterialStatus,
  validateAssignment,
} from '../../projectPoolWorkflow';
import { assignPoolProjectToMeeting } from './rpc';

export interface ProjectPoolWriteResult {
  project: Record<string, unknown>;
  materials?: Record<string, unknown>[];
}

export interface ArchiveWriteResult {
  success: boolean;
  error?: string;
  status?: number;
  purge_after?: string;
}

export interface MeetingAssignmentResult {
  assignments: Record<string, unknown>[];
  errors: { project_id: string; error: string }[];
}

export interface CreateProjectInput {
  name: string;
  submitter: string;
  description: string;
  normalizedName: string;
  normalizedSubmitter: string;
  matchKey: string;
  materialStatuses?: Record<string, string>;
}

function materialInsertSql(rows: Record<string, unknown>[]): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  const values = rows.map((row) => {
    const start = params.length + 1;
    params.push(
      row.project_id,
      row.item_key,
      row.required,
      row.status,
      row.note || '',
      row.checked_by ?? null,
      row.checked_at ?? null,
    );
    return `($${start}, $${start + 1}, $${start + 2}, $${start + 3}, $${start + 4}, $${start + 5}, $${start + 6})`;
  });
  return {
    text: `INSERT INTO project_materials (project_id, item_key, required, status, note, checked_by, checked_at)
           VALUES ${values.join(', ')}`,
    params,
  };
}

export async function createProjectWithMaterials(
  input: CreateProjectInput,
  operatorCode: string,
  connector: Connector = pool,
): Promise<ProjectPoolWriteResult> {
  return tx(async (executor) => {
    const project = await one<Record<string, unknown>>(
      `INSERT INTO project_pool
        (name, submitter, description, normalized_name, normalized_submitter, match_key, status, material_status)
       VALUES ($1, $2, $3, $4, $5, $6, 'materials_pending', 'incomplete')
       RETURNING *`,
      [input.name, input.submitter, input.description, input.normalizedName, input.normalizedSubmitter, input.matchKey],
      executor,
    );
    const checkedAt = new Date().toISOString();
    const rows = createMaterialRows(project.id, input.materialStatuses || {}, operatorCode, checkedAt);
    const materialInsert = materialInsertSql(rows);
    if (rows.length) await execute(materialInsert.text, materialInsert.params, executor);
    const materialStatus = getMaterialStatus(rows).value;
    const savedProject = await one<Record<string, unknown>>(
      'UPDATE project_pool SET material_status = $1, updated_at = $2 WHERE id = $3 RETURNING *',
      [materialStatus, checkedAt, project.id],
      executor,
    );
    await execute(
      `INSERT INTO project_status_history
        (project_id, event_type, to_status, operator_code, note)
       VALUES ($1, 'project_created', 'materials_pending', $2, $3)`,
      [project.id, operatorCode, Object.keys(input.materialStatuses || {}).length ? '创建项目并完成初始资料检查' : '创建待评审项目'],
      executor,
    );
    return { project: savedProject, materials: rows };
  }, connector);
}

export async function updateProjectDetails(
  id: string,
  input: { name: string; submitter: string; description: string; normalizedName: string; normalizedSubmitter: string; matchKey: string },
  connector: Connector = pool,
): Promise<Record<string, unknown>> {
  return tx(async (executor) => one<Record<string, unknown>>(
    `UPDATE project_pool
        SET name = $1, submitter = $2, description = $3,
            normalized_name = $4, normalized_submitter = $5, match_key = $6, updated_at = $7
      WHERE id = $8
      RETURNING *`,
    [input.name, input.submitter, input.description, input.normalizedName, input.normalizedSubmitter, input.matchKey, new Date().toISOString(), id],
    executor,
  ), connector);
}

export async function updateProjectStatus(
  id: string,
  status: string,
  note: string,
  operatorCode: string,
  connector: Connector = pool,
): Promise<Record<string, unknown>> {
  return tx(async (executor) => {
    const current = await maybeOne<{ id: string; status: string; latest_verdict: string | null }>(
      'SELECT id, status, latest_verdict FROM project_pool WHERE id = $1 FOR UPDATE',
      [id],
      executor,
    );
    if (!current) throw new NotFoundError('project not found');
    const project = await one<Record<string, unknown>>(
      'UPDATE project_pool SET status = $1, latest_verdict = $2, updated_at = $3 WHERE id = $4 RETURNING *',
      [status, current.latest_verdict, new Date().toISOString(), id],
      executor,
    );
    await execute(
      `INSERT INTO project_status_history
        (project_id, event_type, from_status, to_status, operator_code, note)
       VALUES ($1, 'admin_adjustment', $2, $3, $4, $5)`,
      [id, current.status, status, operatorCode, note],
      executor,
    );
    return project;
  }, connector);
}

export async function updateProjectAnnouncement(
  id: string,
  announcement: string,
  operatorCode: string,
  connector: Connector = pool,
): Promise<{ project: Record<string, unknown>; error?: string; status?: number }> {
  return tx(async (executor) => {
    const current = await maybeOne<{ status: string }>(
      'SELECT status FROM project_pool WHERE id = $1 FOR UPDATE',
      [id],
      executor,
    );
    if (!current) throw new NotFoundError('project not found');
    if (current.status !== 'initiation') return { project: {}, error: '项目尚未进入立项流程，不能生成立项公示', status: 409 };
    const assignments = await query<{ round_no: number | null; approved: boolean }>(
      `SELECT assignment.round_no,
              EXISTS (
                SELECT 1 FROM scores AS score
                 WHERE score.project_id = assignment.id
                   AND upper(score.reviewer_code) = 'W'
                   AND score.dim_name = ('r' || assignment.round_no || '::__verdict__')
                   AND score.comment = 'approved'
              ) AS approved
         FROM projects AS assignment
        WHERE assignment.pool_project_id = $1`,
      [id],
      executor,
    );
    const approvedRounds = new Set(assignments.filter((item) => item.approved).map((item) => Number(item.round_no)));
    if (!approvedRounds.has(1) || !approvedRounds.has(2)) {
      return { project: {}, error: '只有第一轮和第二轮均由 Walker 确认通过后才能生成立项公示', status: 409 };
    }
    const now = new Date().toISOString();
    const project = await one<Record<string, unknown>>(
      `UPDATE project_pool
          SET initiation_announcement = $1,
              initiation_announcement_updated_at = $2,
              initiation_announcement_updated_by = $3,
              updated_at = $2
        WHERE id = $4
        RETURNING *`,
      [announcement, now, operatorCode, id],
      executor,
    );
    return { project };
  }, connector);
}

export async function archiveProject(
  id: string,
  action: 'restore' | 'request_purge' | 'restore_purge',
  operatorCode: string,
  input: { now: string; purgeAfter: string },
  connector: Connector = pool,
): Promise<ArchiveWriteResult> {
  return tx(async (executor) => {
    const project = await maybeOne<{ status: string; archived_at: string | null }>(
      'SELECT status, archived_at FROM project_pool WHERE id = $1 FOR UPDATE',
      [id],
      executor,
    );
    if (!project) throw new NotFoundError('project not found');

    if (action === 'restore') {
      const deletionRequest = await maybeOne<{ project_id: string }>(
        'SELECT project_id FROM project_deletion_requests WHERE project_id = $1 AND restored_at IS NULL',
        [id],
        executor,
      );
      if (deletionRequest) return { success: false, error: 'Restore the purge request before restoring the project', status: 409 };
      await execute('UPDATE project_pool SET archived_at = NULL, updated_at = $1 WHERE id = $2', [input.now, id], executor);
      await execute(
        `INSERT INTO project_status_history
          (project_id, event_type, from_status, to_status, operator_code, note)
         VALUES ($1, 'project_restored', 'archived', $2, $3, 'Restored from archive')`,
        [id, project.status, operatorCode],
        executor,
      );
      return { success: true };
    }

    if (action === 'request_purge') {
      if (!project.archived_at) return { success: false, error: 'Only archived projects can be queued for purge', status: 409 };
      await execute(
        `INSERT INTO project_deletion_requests
          (project_id, requested_by, requested_at, purge_after, restored_at, restored_by)
         VALUES ($1, $2, $3, $4, NULL, NULL)
         ON CONFLICT (project_id) DO UPDATE SET
           requested_by = EXCLUDED.requested_by,
           requested_at = EXCLUDED.requested_at,
           purge_after = EXCLUDED.purge_after,
           restored_at = NULL,
           restored_by = NULL`,
        [id, operatorCode, input.now, input.purgeAfter],
        executor,
      );
      await execute(
        `INSERT INTO project_status_history
          (project_id, event_type, from_status, to_status, operator_code, note)
         VALUES ($1, 'purge_requested', $2, 'archived', $3, 'Purge requested with a 15-day recovery window')`,
        [id, project.status, operatorCode],
        executor,
      );
      return { success: true, purge_after: input.purgeAfter };
    }

    const restored = await maybeOne<{ project_id: string }>(
      `UPDATE project_deletion_requests
          SET restored_at = $1, restored_by = $2
        WHERE project_id = $3 AND restored_at IS NULL
        RETURNING project_id`,
      [input.now, operatorCode, id],
      executor,
    );
    if (!restored) return { success: false, error: 'No active purge request exists', status: 404 };
    await execute(
      `INSERT INTO project_status_history
        (project_id, event_type, from_status, to_status, operator_code, note)
       VALUES ($1, 'purge_restored', 'archived', 'archived', $2, 'Purge request restored to archive')`,
      [id, operatorCode],
      executor,
    );
    return { success: true };
  }, connector);
}

export async function upsertProjectMaterial(
  projectId: string,
  itemKey: string,
  required: boolean,
  status: string,
  note: string,
  checkedBy: string,
  checkedAt: string,
  connector: Connector = pool,
): Promise<{ project: Record<string, unknown>; materials: Record<string, unknown>[]; material_status: string; status: string; missing: string[] }> {
  return tx(async (executor) => {
    await execute(
      `INSERT INTO project_materials
        (project_id, item_key, required, status, note, checked_by, checked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (project_id, item_key) DO UPDATE SET
         required = EXCLUDED.required,
         status = EXCLUDED.status,
         note = EXCLUDED.note,
         checked_by = EXCLUDED.checked_by,
         checked_at = EXCLUDED.checked_at,
         updated_at = now()`,
      [projectId, itemKey, required, status, note, checkedBy, checkedAt],
      executor,
    );
    const materials = await query<Record<string, unknown>>(
      `SELECT project_id, item_key, required, status, note, checked_by, checked_at, updated_at
         FROM project_materials WHERE project_id = $1 ORDER BY item_key ASC`,
      [projectId],
      executor,
    );
    const current = await maybeOne<{ status: string }>(
      'SELECT status FROM project_pool WHERE id = $1 FOR UPDATE',
      [projectId],
      executor,
    );
    if (!current) throw new NotFoundError('project not found');
    const derived = getMaterialStatus(materials);
    const project = await one<Record<string, unknown>>(
      'UPDATE project_pool SET material_status = $1, updated_at = $2 WHERE id = $3 RETURNING *',
      [derived.value, checkedAt, projectId],
      executor,
    );
    await execute(
      `INSERT INTO project_status_history
        (project_id, event_type, from_status, to_status, operator_code, note)
       VALUES ($1, 'material_checked', $2, $2, $3, $4)`,
      [projectId, current.status, checkedBy, `${itemKey}: ${status}${note ? `；${note}` : ''}`],
      executor,
    );
    return { project, materials, material_status: derived.value, status: current.status, missing: derived.missing };
  }, connector);
}

export async function assignMeetingProjects(
  meetingId: string,
  projectIds: readonly string[],
  operatorCode: string,
  connector: Connector = pool,
): Promise<MeetingAssignmentResult> {
  return tx(async (executor) => {
    const meeting = await maybeOne<{ id: string; status: string; deleted_at: string | null }>(
      'SELECT id, status, deleted_at FROM meetings WHERE id = $1 FOR UPDATE',
      [meetingId],
      executor,
    );
    if (!meeting || meeting.deleted_at || ['archived', 'locked'].includes(meeting.status)) {
      return { assignments: [], errors: [{ project_id: '', error: '评审会不存在、已归档或已锁定' }] };
    }
    const ids = Array.from(projectIds);
    const projects = await query<Record<string, any>>(
      'SELECT * FROM project_pool WHERE id = ANY($1::uuid[])',
      [ids],
      executor,
    );
    const existing = await query<Record<string, any>>(
      'SELECT id, pool_project_id FROM projects WHERE meeting_id = $1 AND pool_project_id IS NOT NULL',
      [meetingId],
      executor,
    );
    const allReviewers = await query<{ code: string; name: string; role: string | null }>(
      'SELECT code, name, role FROM reviewers WHERE is_admin = false',
      [],
      executor,
    );
    const snapshot = await query<{ reviewer_code: string }>(
      'SELECT reviewer_code FROM meeting_reviewers WHERE meeting_id = $1',
      [meetingId],
      executor,
    );
    const snapshotCodes = new Set(snapshot.map((item) => String(item.reviewer_code).toLowerCase()));
    const missingReviewers = allReviewers.filter((reviewer) => !snapshotCodes.has(String(reviewer.code).toLowerCase()));
    if (missingReviewers.length) {
      const params: unknown[] = [];
      const values = missingReviewers.map((reviewer) => {
        const start = params.length + 1;
        params.push(meetingId, reviewer.code, reviewer.name || '', reviewer.role || '');
        return `($${start}, $${start + 1}, $${start + 2}, $${start + 3})`;
      });
      await execute(
        `INSERT INTO meeting_reviewers (meeting_id, reviewer_code, reviewer_name, reviewer_role)
         VALUES ${values.join(', ')}
         ON CONFLICT (meeting_id, reviewer_code) DO NOTHING`,
        params,
        executor,
      );
    }
    const byId = new Map(projects.map((project) => [String(project.id), project]));
    const assignments: Record<string, unknown>[] = [];
    const errors: { project_id: string; error: string }[] = [];
    for (const id of ids) {
      const project = byId.get(id);
      const projectRound = assignmentRoundForStatus(project?.status);
      const valid = project && !project.archived_at && !existing.some((item) => item.pool_project_id === id) && !assignments.some((item: any) => item.pool_project_id === id)
        ? validateAssignment(project, [...existing, ...assignments], projectRound)
        : { ok: false, error: project && !project.archived_at ? '同一项目不能重复加入同一评审会' : '项目不存在' };
      if (!valid.ok) { errors.push({ project_id: id, error: valid.error }); continue; }
      const assignment = await assignPoolProjectToMeeting(id, meetingId, projectRound, operatorCode, executor);
      assignments.push(assignment as unknown as Record<string, unknown>);
      existing.push({ id: assignment.id, pool_project_id: id });
    }
    return { assignments, errors };
  }, connector);
}

export async function reorderMeetingAssignments(
  meetingId: string,
  orderedAssignmentIds: readonly string[],
  connector: Connector = pool,
): Promise<void> {
  return tx(async (executor) => {
    const rows = await query<{ id: string }>(
      'SELECT id FROM projects WHERE meeting_id = $1 AND id = ANY($2::uuid[])',
      [meetingId, Array.from(orderedAssignmentIds)],
      executor,
    );
    if (rows.length !== orderedAssignmentIds.length) throw new ConflictError('评审项目已变更，请刷新后重试');
    await execute(
      `UPDATE projects AS project
          SET seq_no = ordering.seq_no
         FROM unnest($2::uuid[]) WITH ORDINALITY AS ordering(id, seq_no)
        WHERE project.id = ordering.id AND project.meeting_id = $1`,
      [meetingId, Array.from(orderedAssignmentIds)],
      executor,
    );
  }, connector);
}

export async function removeMeetingAssignment(
  assignmentId: string,
  operatorCode: string,
  connector: Connector = pool,
): Promise<{ error?: string; status?: number }> {
  return tx(async (executor) => {
    const assignment = await maybeOne<{ id: string; pool_project_id: string; round_no: number; score_count: number }>(
      `SELECT assignment.id, assignment.pool_project_id, assignment.round_no,
              (SELECT count(*)::int FROM scores AS score WHERE score.project_id = assignment.id) AS score_count
         FROM projects AS assignment
        WHERE assignment.id = $1
        FOR UPDATE`,
      [assignmentId],
      executor,
    );
    if (!assignment) return { error: '评审项目不存在', status: 404 };
    if (assignment.score_count) return { error: '已开始评分的项目不能移出评审会', status: 409 };
    await execute('DELETE FROM projects WHERE id = $1', [assignmentId], executor);
    const status = assignment.round_no === 1 ? 'ready_r1' : 'ready_r2';
    await execute('UPDATE project_pool SET status = $1, updated_at = $2 WHERE id = $3', [status, new Date().toISOString(), assignment.pool_project_id], executor);
    await execute(
      `INSERT INTO project_status_history
        (project_id, meeting_project_id, event_type, to_status, operator_code, note)
       VALUES ($1, $2, 'meeting_unscheduled', $3, $4, '从未开始的评审会移除')`,
      [assignment.pool_project_id, assignmentId, status, operatorCode],
      executor,
    );
    return {};
  }, connector);
}
