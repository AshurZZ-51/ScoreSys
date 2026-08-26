import { query } from '../client';
import type { Executor } from '../client';
import { ValidationError } from '../errors';

const PROJECT_SCOPES = new Set(['active', 'archived', 'purge_pending', 'pending', 'reviewed']);

export interface ProjectPoolListOptions {
  scope?: string;
  monthStart?: string | null;
  monthEnd?: string | null;
  limit?: number;
  offset?: number;
}

function assertScope(scope: string): void {
  if (!PROJECT_SCOPES.has(scope)) throw new ValidationError('Invalid project scope');
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) throw new ValidationError(`${name} must be a non-negative integer`);
  return value;
}

export async function listProjectPool(
  options: ProjectPoolListOptions = {},
  executor?: Executor,
): Promise<Record<string, unknown>[]> {
  const scope = options.scope || 'active';
  assertScope(scope);

  const params: unknown[] = [];
  const filters: string[] = [];
  if (scope === 'active' || scope === 'pending' || scope === 'reviewed') filters.push('p.archived_at IS NULL');
  else filters.push('p.archived_at IS NOT NULL');
  if (options.monthStart !== undefined && options.monthStart !== null) {
    params.push(options.monthStart);
    filters.push(`p.created_at >= $${params.length}`);
  }
  if (options.monthEnd !== undefined && options.monthEnd !== null) {
    params.push(options.monthEnd);
    filters.push(`p.created_at < $${params.length}`);
  }

  let pagination = '';
  if (options.limit !== undefined) {
    params.push(positiveInteger(options.limit, 'limit'));
    pagination += ` LIMIT $${params.length}`;
  }
  if (options.offset !== undefined) {
    params.push(positiveInteger(options.offset, 'offset'));
    pagination += ` OFFSET $${params.length}`;
  }

  const text = `
    SELECT
      to_jsonb(p)
      || jsonb_build_object(
        'project_materials', COALESCE(materials.items, '[]'::jsonb),
        'project_deletion_requests', COALESCE(deletions.items, '[]'::jsonb),
        'projects', COALESCE(assignments.items, '[]'::jsonb)
      ) AS project
    FROM project_pool AS p
    LEFT JOIN LATERAL (
      SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.item_key ASC), '[]'::jsonb) AS items
      FROM project_materials AS m
      WHERE m.project_id = p.id
    ) AS materials ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.requested_at DESC), '[]'::jsonb) AS items
      FROM project_deletion_requests AS d
      WHERE d.project_id = p.id
    ) AS deletions ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'id', a.id,
          'meeting_id', a.meeting_id,
          'seq_no', a.seq_no,
          'round_no', a.round_no,
          'attempt_no', a.attempt_no,
          'scoring_version', a.scoring_version,
          'assignment_status', a.assignment_status,
          'meetings', CASE WHEN meeting.id IS NULL THEN NULL ELSE jsonb_build_object(
            'id', meeting.id,
            'name', meeting.name,
            'meeting_date', meeting.meeting_date,
            'status', meeting.status
          ) END,
          'scores', COALESCE(scores.items, '[]'::jsonb)
        ) ORDER BY a.created_at ASC
      ), '[]'::jsonb) AS items
      FROM projects AS a
      LEFT JOIN meetings AS meeting ON meeting.id = a.meeting_id
      LEFT JOIN LATERAL (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'reviewer_code', s.reviewer_code,
          'dim_name', s.dim_name,
          'comment', s.comment
        ) ORDER BY s.updated_at ASC, s.id ASC), '[]'::jsonb) AS items
        FROM scores AS s
        WHERE s.project_id = a.id
      ) AS scores ON true
      WHERE a.pool_project_id = p.id
    ) AS assignments ON true
    WHERE ${filters.join(' AND ')}
    ORDER BY p.updated_at DESC${pagination}
  `;

  const rows = await query<{ project: Record<string, unknown> }>(text, params, executor);
  return rows.map((row) => ({
    ...row.project,
    project_materials: Array.isArray(row.project?.project_materials) ? row.project.project_materials : [],
    project_deletion_requests: Array.isArray(row.project?.project_deletion_requests) ? row.project.project_deletion_requests : [],
    projects: Array.isArray(row.project?.projects) ? row.project.projects : [],
  }));
}

export const getProjectPool = listProjectPool;
