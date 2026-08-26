import type { Executor } from '../client';
import { query } from '../client';
import type { ProjectMaterialRow, ProjectPoolRow } from '../types';

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
