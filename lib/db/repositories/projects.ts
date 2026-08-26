import type { Executor } from '../client';
import { execute, one, query } from '../client';
import { buildUpdateSet, PROJECT_UPDATABLE } from '../sql';
import type { ProjectMaterialRow, ProjectPoolRow, ProjectRow } from '../types';

export interface MeetingProject {
  id: string;
  meeting_id: string;
  seq_no: number;
  name: string;
  submitter: string;
  description: string | null;
  problems: string[];
  actions: string[];
  is_pending: boolean;
  is_template: boolean;
  created_at: Date;
  pool_project_id: string | null;
  round_no: number | null;
  attempt_no: number;
  scoring_version: string;
  assignment_status: string | null;
}

export interface ListMeetingProjectsInput {
  meetingId: string;
  reviewerOnly?: boolean;
}

export interface ListResultProjectsInput {
  bucket: string | null;
}

export type SummaryProject = Omit<MeetingProject, 'is_template' | 'created_at'>;
export type ResultProject = ProjectPoolRow & { project_materials: ProjectMaterialRow[] };

export interface CreateProjectInput {
  meeting_id: string;
  seq_no: number;
  name: string;
  submitter: string;
  description: string;
  is_pending: boolean;
  problems: string[];
  actions: string[];
}

export async function createProject(input: CreateProjectInput, executor?: Executor): Promise<ProjectRow> {
  return one<ProjectRow>(
    `INSERT INTO projects (
       meeting_id, seq_no, name, submitter, description, is_pending, is_template, problems, actions
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [input.meeting_id, input.seq_no, input.name, input.submitter, input.description, input.is_pending, false, input.problems, input.actions],
    executor,
  );
}

export async function updateProject(
  projectId: string,
  patch: Record<string, unknown>,
  executor?: Executor,
): Promise<ProjectRow> {
  const update = buildUpdateSet(patch, PROJECT_UPDATABLE);
  const idIndex = update.params.length + 1;
  return one<ProjectRow>(
    `UPDATE projects
        SET ${update.clause}
      WHERE id = $${idIndex}
      RETURNING *`,
    [...update.params, projectId],
    executor,
  );
}

export function deleteProject(projectId: string, executor?: Executor): Promise<number> {
  return execute('DELETE FROM projects WHERE id = $1', [projectId], executor);
}

export function listMeetingProjects(
  input: ListMeetingProjectsInput,
  executor?: Executor,
): Promise<MeetingProject[]> {
  const reviewerFilter = input.reviewerOnly ? ` AND name <> '' AND submitter <> ''` : '';
  return query<MeetingProject>(
    `SELECT id, meeting_id, seq_no, name, submitter, description, problems, actions,
            is_pending, is_template, created_at, pool_project_id, round_no, attempt_no,
            scoring_version, assignment_status
       FROM projects
      WHERE meeting_id = $1${reviewerFilter}
      ORDER BY seq_no`,
    [input.meetingId],
    executor,
  );
}

export function listSummaryProjects(
  meetingId: string,
  executor?: Executor,
): Promise<SummaryProject[]> {
  return query<SummaryProject>(
    `SELECT id, meeting_id, seq_no, name, submitter, description, problems, actions,
            is_pending, pool_project_id, round_no, attempt_no, scoring_version, assignment_status
       FROM projects
      WHERE meeting_id = $1
      ORDER BY seq_no`,
    [meetingId],
    executor,
  );
}

export function listResultProjects(
  input: ListResultProjectsInput,
  executor?: Executor,
): Promise<ResultProject[]> {
  const filterByBucket = ['approved', 'recheck', 'rejected'].includes(input.bucket ?? '');
  const bucketClause = filterByBucket ? ' AND project.latest_verdict = $1' : '';
  const params = filterByBucket ? [input.bucket] : [];

  return query<ResultProject>(
    `SELECT project.*,
            COALESCE(
              jsonb_agg(to_jsonb(material)) FILTER (WHERE material.project_id IS NOT NULL),
              '[]'::jsonb
            ) AS project_materials
       FROM project_pool AS project
       LEFT JOIN project_materials AS material ON material.project_id = project.id
      WHERE project.archived_at IS NULL${bucketClause}
      GROUP BY project.id
      ORDER BY project.updated_at DESC`,
    params,
    executor,
  );
}
