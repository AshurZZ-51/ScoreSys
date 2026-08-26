import { query } from '../client';
import type { Executor } from '../client';

export interface ReportSnapshotFilters {
  scopeType: string;
  scopeId: string;
  reportType: string;
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
