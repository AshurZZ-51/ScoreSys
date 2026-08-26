import type { Executor } from '../client';
import { query } from '../client';
import type { Numeric } from '../types';

export interface ScoreRecord {
  id: string;
  meeting_id: string;
  project_id: string;
  reviewer_code: string;
  dim_name: string;
  score: Numeric;
  comment: string | null;
  updated_at: Date;
}

export interface ProjectRatingRecord {
  id: string;
  meeting_id: string;
  project_id: string;
  reviewer_code: string;
  round_no: number;
  attempt_no: number;
  rating: string;
  created_at: Date;
  updated_at: Date;
}

export interface ListScoresInput {
  meetingId: string;
  reviewerCode?: string | null;
  projectId?: string | null;
}

export interface ListProjectRatingsInput {
  meetingId: string;
  reviewerCode: string;
  projectId?: string | null;
}

export type SummaryProjectRating = Omit<ProjectRatingRecord, 'id' | 'created_at'>;

export function listScores(input: ListScoresInput, executor?: Executor): Promise<ScoreRecord[]> {
  const params: unknown[] = [input.meetingId];
  const filters = ['meeting_id = $1'];
  if (input.reviewerCode) {
    params.push(input.reviewerCode);
    filters.push(`reviewer_code = $${params.length}`);
  }
  if (input.projectId) {
    params.push(input.projectId);
    filters.push(`project_id = $${params.length}`);
  }

  return query<ScoreRecord>(
    `SELECT id, meeting_id, project_id, reviewer_code, dim_name, score, comment, updated_at
       FROM scores
      WHERE ${filters.join(' AND ')}`,
    params,
    executor,
  );
}

export function listProjectRatings(
  input: ListProjectRatingsInput,
  executor?: Executor,
): Promise<ProjectRatingRecord[]> {
  const params: unknown[] = [input.meetingId, input.reviewerCode];
  const filters = ['meeting_id = $1', 'reviewer_code = $2'];
  if (input.projectId) {
    params.push(input.projectId);
    filters.push(`project_id = $${params.length}`);
  }

  return query<ProjectRatingRecord>(
    `SELECT id, meeting_id, project_id, reviewer_code, round_no, attempt_no,
            rating, created_at, updated_at
       FROM project_reviewer_ratings
      WHERE ${filters.join(' AND ')}`,
    params,
    executor,
  );
}

export function listMeetingScores(meetingId: string, executor?: Executor): Promise<ScoreRecord[]> {
  return listScores({ meetingId }, executor);
}

export function listMeetingProjectRatings(
  meetingId: string,
  executor?: Executor,
): Promise<SummaryProjectRating[]> {
  return query<SummaryProjectRating>(
    `SELECT meeting_id, project_id, reviewer_code, round_no, attempt_no, rating, updated_at
       FROM project_reviewer_ratings
      WHERE meeting_id = $1`,
    [meetingId],
    executor,
  );
}
