import { maybeOne } from '../client';
import { NotFoundError } from '../errors';
import type { Executor } from '../client';

export interface ProjectHistoryRead {
  project: Record<string, unknown>;
  history: Record<string, unknown>[];
  assignments: Record<string, unknown>[];
}

interface ProjectHistoryRow {
  project: Record<string, unknown> | null;
  history: Record<string, unknown>[] | null;
  assignments: Record<string, unknown>[] | null;
  rating_history: Record<string, unknown>[] | null;
}

export async function getProjectHistory(projectId: string, executor?: Executor): Promise<ProjectHistoryRead & { rating_history: Record<string, unknown>[] }> {
  const row = await maybeOne<ProjectHistoryRow>(
    `
      SELECT
        to_jsonb(pool)
        || jsonb_build_object(
          'project_materials', COALESCE(materials.items, '[]'::jsonb),
          'rating_history', COALESCE(ratings.items, '[]'::jsonb)
        ) AS project,
        COALESCE(history.items, '[]'::jsonb) AS history,
        COALESCE(assignments.items, '[]'::jsonb) AS assignments,
        COALESCE(ratings.items, '[]'::jsonb) AS rating_history
      FROM project_pool AS pool
      LEFT JOIN LATERAL (
        SELECT COALESCE(jsonb_agg(to_jsonb(material) ORDER BY material.item_key ASC), '[]'::jsonb) AS items
        FROM project_materials AS material
        WHERE material.project_id = pool.id
      ) AS materials ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(jsonb_agg(to_jsonb(event) ORDER BY event.created_at DESC, event.id DESC), '[]'::jsonb) AS items
        FROM project_status_history AS event
        WHERE event.project_id = pool.id
      ) AS history ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(jsonb_agg(
          to_jsonb(assignment) || jsonb_build_object(
            'meetings', CASE WHEN meeting.id IS NULL THEN NULL ELSE jsonb_build_object(
              'id', meeting.id,
              'name', meeting.name,
              'meeting_date', meeting.meeting_date,
              'status', meeting.status
            ) END,
            'scores', COALESCE(scores.items, '[]'::jsonb)
          ) ORDER BY assignment.created_at ASC, assignment.id ASC
        ), '[]'::jsonb) AS items
        FROM projects AS assignment
        LEFT JOIN meetings AS meeting ON meeting.id = assignment.meeting_id
        LEFT JOIN LATERAL (
          SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'reviewer_code', score.reviewer_code,
            'dim_name', score.dim_name,
            'score', score.score,
            'comment', score.comment,
            'updated_at', score.updated_at
          ) ORDER BY score.updated_at ASC, score.id ASC), '[]'::jsonb) AS items
          FROM scores AS score
          WHERE score.project_id = assignment.id
        ) AS scores ON true
        WHERE assignment.pool_project_id = pool.id
      ) AS assignments ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(jsonb_agg(to_jsonb(rating) ORDER BY rating.created_at DESC, rating.id DESC), '[]'::jsonb) AS items
        FROM project_rating_history AS rating
        WHERE rating.project_id = pool.id
      ) AS ratings ON true
      WHERE pool.id = $1
    `,
    [projectId],
    executor,
  );
  if (!row?.project) throw new NotFoundError('project not found');
  return {
    project: {
      ...row.project,
      project_materials: Array.isArray(row.project.project_materials) ? row.project.project_materials : [],
      rating_history: Array.isArray(row.project.rating_history) ? row.project.rating_history : [],
    },
    history: Array.isArray(row.history) ? row.history : [],
    assignments: Array.isArray(row.assignments) ? row.assignments : [],
    rating_history: Array.isArray(row.rating_history) ? row.rating_history : [],
  };
}

export const readProjectHistory = getProjectHistory;
