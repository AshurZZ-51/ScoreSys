import type { Executor, Connector } from '../client';
import { execute, maybeOne, one, query, tx } from '../client';
import { pool } from '../pool';
import type { ProjectPoolRow, ProjectRow } from '../types';

export type ProjectPoolMutationAction = 'status' | 'archive';

export interface ProjectPoolMutationRow {
  project_id: string;
  status: string;
  latest_verdict: string | null;
  archived_at: Date | null;
}

export interface PurgedProjectRow {
  project_id: string;
}

export interface ReviewerIdentity {
  code: string;
  is_admin: boolean;
}

export async function applyProjectPoolMutations(
  projectIds: readonly string[],
  action: ProjectPoolMutationAction,
  status: string | null,
  operatorCode: string,
  note = '',
  executor?: Executor,
): Promise<ProjectPoolMutationRow[]> {
  return query<ProjectPoolMutationRow>(
    'SELECT * FROM apply_project_pool_mutations($1::uuid[], $2::text, $3::text, $4::text, $5::text)',
    [Array.from(projectIds), action, status, operatorCode, note],
    executor,
  );
}

export async function purgeDueProjectDeletions(
  connector: Connector = pool,
): Promise<PurgedProjectRow[]> {
  return tx(async (executor) => {
    await execute("SET LOCAL statement_timeout = '120s'", [], executor);
    return query<PurgedProjectRow>('SELECT * FROM purge_due_project_deletions()', [], executor);
  }, connector);
}

export async function applyProjectRating(
  projectId: string,
  ratingType: string,
  rating: string,
  operatorCode: string,
  executor?: Executor,
): Promise<ProjectPoolRow> {
  return one<ProjectPoolRow>(
    'SELECT * FROM apply_project_rating($1::uuid, $2::text, $3::text, $4::text)',
    [projectId, ratingType, rating, operatorCode],
    executor,
  );
}

export async function assignPoolProjectToMeeting(
  projectId: string,
  meetingId: string,
  roundNo: number,
  operatorCode: string,
  executor?: Executor,
): Promise<ProjectRow> {
  return one<ProjectRow>(
    'SELECT * FROM assign_pool_project_to_meeting($1::uuid, $2::uuid, $3::smallint, $4::text)',
    [projectId, meetingId, roundNo, operatorCode],
    executor,
  );
}

export async function findReviewerByCode(
  code: string,
  executor?: Executor,
): Promise<ReviewerIdentity | null> {
  return maybeOne<ReviewerIdentity>(
    'SELECT code, is_admin FROM reviewers WHERE lower(code) = lower($1::text) LIMIT 1',
    [code],
    executor,
  );
}
