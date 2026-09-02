import type { Connector, Executor } from '../client';
import { execute, maybeOne, one, tx } from '../client';
import { pool } from '../pool';
import type { ScoreRow } from '../types';

export interface ScoringMeeting {
  deadline: string | null;
  status: string;
}

export interface ScoringAssignment {
  id: string;
  pool_project_id: string | null;
  round_no: number | null;
  attempt_no: number;
  scoring_version: string;
  assignment_status: string | null;
}

export interface ScoringReviewer {
  is_admin: boolean;
}

export interface ScoreWriteInput {
  meetingId: string;
  projectId: string;
  reviewerCode: string;
  dimName: string;
  score: number;
  comment: string | null;
  updatedAt: string;
}

export type ScoreFollowUp =
  | { type: 'none' }
  | {
      type: 'project_pool_verdict';
      assignmentId: string;
      poolProjectId: string;
      status: string;
      currentRound: number;
      currentAttempt: number;
      verdict: string;
      meetingId: string;
      operatorCode: string;
      note: string;
    }
  | {
      type: 'legacy_verdict';
      trackingScores: ScoreWriteInput[];
    };

export interface SubmitScoreWorkflowInput {
  score: ScoreWriteInput;
  followUp: ScoreFollowUp;
}

export interface DeleteScoresInput {
  meetingId: string;
  reviewerCode?: string | null;
  projectId?: string | null;
  dimName?: string | null;
}

export function getScoringMeeting(
  meetingId: string,
  executor?: Executor,
): Promise<ScoringMeeting | null> {
  return maybeOne<ScoringMeeting>(
    'SELECT deadline, status FROM meetings WHERE id = $1',
    [meetingId],
    executor,
  );
}

export function getScoringAssignment(
  meetingId: string,
  projectId: string,
  executor?: Executor,
): Promise<ScoringAssignment | null> {
  return maybeOne<ScoringAssignment>(
    `SELECT id, pool_project_id, round_no, attempt_no, scoring_version, assignment_status
       FROM projects
      WHERE id = $1
        AND meeting_id = $2`,
    [projectId, meetingId],
    executor,
  );
}

export function getScoringReviewer(
  reviewerCode: string,
  executor?: Executor,
): Promise<ScoringReviewer | null> {
  return maybeOne<ScoringReviewer>(
    'SELECT is_admin FROM reviewers WHERE code = $1',
    [reviewerCode],
    executor,
  );
}

export async function isMeetingReviewer(
  meetingId: string,
  reviewerCode: string,
  executor?: Executor,
): Promise<boolean> {
  const row = await maybeOne<{ found: boolean }>(
    `SELECT true AS found
       FROM meeting_reviewers
      WHERE meeting_id = $1
        AND reviewer_code = $2`,
    [meetingId, reviewerCode],
    executor,
  );
  return Boolean(row?.found);
}

export async function hasReviewerDimension(
  reviewerCode: string,
  dimensionNames: string[],
  executor?: Executor,
): Promise<boolean> {
  const row = await maybeOne<{ found: boolean }>(
    `SELECT true AS found
       FROM reviewer_dims
      WHERE reviewer_code = $1
        AND dim_name = ANY($2::text[])
      LIMIT 1`,
    [reviewerCode, dimensionNames],
    executor,
  );
  return Boolean(row?.found);
}

async function upsertScore(input: ScoreWriteInput, executor: Executor): Promise<ScoreRow> {
  return one<ScoreRow>(
    `INSERT INTO scores (
       meeting_id, project_id, reviewer_code, dim_name, score, comment, updated_at
     )
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::timestamptz)
     ON CONFLICT (meeting_id, project_id, reviewer_code, dim_name) DO UPDATE
       SET score = EXCLUDED.score,
           comment = EXCLUDED.comment,
           updated_at = EXCLUDED.updated_at
     RETURNING id, meeting_id, project_id, reviewer_code, dim_name, score, comment, updated_at`,
    [
      input.meetingId,
      input.projectId,
      input.reviewerCode,
      input.dimName,
      input.score,
      input.comment,
      input.updatedAt,
    ],
    executor,
  );
}

async function upsertTrackingScores(
  scores: ScoreWriteInput[],
  executor: Executor,
): Promise<void> {
  if (scores.length === 0) return;
  const rows = scores.map((score) => ({
    meeting_id: score.meetingId,
    project_id: score.projectId,
    reviewer_code: score.reviewerCode,
    dim_name: score.dimName,
    score: score.score,
    comment: score.comment,
    updated_at: score.updatedAt,
  }));
  await execute(
    `INSERT INTO scores (
       meeting_id, project_id, reviewer_code, dim_name, score, comment, updated_at
     )
     SELECT score.meeting_id, score.project_id, score.reviewer_code, score.dim_name,
            score.score, score.comment, score.updated_at
       FROM jsonb_to_recordset($1::jsonb) AS score(
         meeting_id uuid,
         project_id uuid,
         reviewer_code text,
         dim_name text,
         score integer,
         comment text,
         updated_at timestamptz
       )
     ON CONFLICT (meeting_id, project_id, reviewer_code, dim_name) DO UPDATE
       SET score = EXCLUDED.score,
           comment = EXCLUDED.comment,
           updated_at = EXCLUDED.updated_at`,
    [JSON.stringify(rows)],
    executor,
  );
}

export async function submitScoreWorkflow(
  input: SubmitScoreWorkflowInput,
  connector: Connector = pool,
): Promise<ScoreRow> {
  return tx(async (transaction) => {
    const savedScore = await upsertScore(input.score, transaction);

    if (input.followUp.type === 'project_pool_verdict') {
      const verdict = input.followUp;
      await execute(
        'UPDATE projects SET assignment_status = $1 WHERE id = $2::uuid',
        ['completed', verdict.assignmentId],
        transaction,
      );
      await execute(
        `UPDATE project_pool
            SET status = $1,
                current_round = $2,
                current_attempt = $3,
                latest_verdict = $4,
                updated_at = now()
          WHERE id = $5::uuid`,
        [verdict.status, verdict.currentRound, verdict.currentAttempt, verdict.verdict, verdict.poolProjectId],
        transaction,
      );
      await execute(
        `INSERT INTO project_status_history (
           project_id, meeting_project_id, meeting_id, event_type,
           to_status, operator_code, note
         )
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)`,
        [
          verdict.poolProjectId,
          verdict.assignmentId,
          verdict.meetingId,
          'walker_verdict',
          verdict.status,
          verdict.operatorCode,
          verdict.note,
        ],
        transaction,
      );
    } else if (input.followUp.type === 'legacy_verdict') {
      await upsertTrackingScores(input.followUp.trackingScores, transaction);
    }

    return savedScore;
  }, connector);
}

export function deleteScores(input: DeleteScoresInput, executor?: Executor): Promise<number> {
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
  if (input.dimName) {
    params.push(input.dimName);
    filters.push(`dim_name = $${params.length}`);
  }
  return execute(`DELETE FROM scores WHERE ${filters.join(' AND ')}`, params, executor);
}
