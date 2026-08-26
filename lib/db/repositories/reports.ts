import { one, query, tx } from '../client';
import type { Connector, Executor } from '../client';
import { pool } from '../pool';
import type { ReportSnapshotRow } from '../types';

export interface ReportSnapshotFilters {
  scopeType: string;
  scopeId: string;
  reportType: string;
}

export interface ProjectReportData {
  project: Record<string, unknown>;
  assignments: Record<string, unknown>[];
  timeline: Record<string, unknown>[];
}

export interface CreateReportSnapshotInput {
  scopeType: string;
  scopeId: string;
  reportType: string;
  payload: Record<string, unknown>;
  generatedBy: string;
}

export async function listReportSnapshots(filters: ReportSnapshotFilters, executor?: Executor): Promise<Record<string, unknown>[]> {
  return query<Record<string, unknown>>(
    `SELECT id, scope_type, scope_id, report_type, version, payload, generated_by, generated_at
       FROM report_snapshots
      WHERE scope_type = $1 AND scope_id = $2 AND report_type = $3
      ORDER BY version DESC`,
    [filters.scopeType, filters.scopeId, filters.reportType],
    executor,
  );
}

export const getReportSnapshots = listReportSnapshots;

/** Read all project-level report inputs in one parameterized query. */
export async function getProjectReportData(
  projectId: string,
  executor?: Executor,
): Promise<ProjectReportData> {
  const row = await one<{
    project: Record<string, unknown>;
    assignments: Record<string, unknown>[] | null;
    timeline: Record<string, unknown>[] | null;
  }>(
    `SELECT to_jsonb(pool) AS project,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object('meeting_id', assignment.meeting_id)
                               ORDER BY assignment.created_at ASC, assignment.id ASC)
                FROM projects AS assignment
               WHERE assignment.pool_project_id = pool.id
            ), '[]'::jsonb) AS assignments,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'event_type', event.event_type,
                'from_status', event.from_status,
                'to_status', event.to_status,
                'note', event.note,
                'created_at', event.created_at
              ) ORDER BY event.created_at ASC, event.id ASC)
                FROM project_status_history AS event
               WHERE event.project_id = pool.id
            ), '[]'::jsonb) AS timeline
       FROM project_pool AS pool
      WHERE pool.id = $1`,
    [projectId],
    executor,
  );

  return {
    project: row.project || {},
    assignments: Array.isArray(row.assignments) ? row.assignments : [],
    timeline: Array.isArray(row.timeline) ? row.timeline : [],
  };
}

/** Allocate and insert a snapshot while serializing the scope's version sequence. */
export async function createReportSnapshot(
  input: CreateReportSnapshotInput,
  connector: Connector = pool,
): Promise<ReportSnapshotRow> {
  return tx(async (executor) => {
    const lockKey = `${input.scopeType}:${input.scopeId}:${input.reportType}`;
    await query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [lockKey],
      executor,
    );
    const versions = await query<{ version: number }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS version
         FROM report_snapshots
        WHERE scope_type = $1 AND scope_id = $2 AND report_type = $3`,
      [input.scopeType, input.scopeId, input.reportType],
      executor,
    );
    const version = Number(versions[0]?.version || 1);
    return one<ReportSnapshotRow>(
      `INSERT INTO report_snapshots (
         scope_type, scope_id, report_type, version, payload, generated_by
       ) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, scope_type, scope_id, report_type, version,
                 payload, generated_by, generated_at`,
      [input.scopeType, input.scopeId, input.reportType, version, input.payload, input.generatedBy],
      executor,
    );
  }, connector);
}
