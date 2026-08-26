import { query } from '../client';
import type { Executor } from '../client';

export async function listProjectMaterials(projectId: string, executor?: Executor): Promise<Record<string, unknown>[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT project_id, item_key, required, status, note, checked_by, checked_at, updated_at
       FROM project_materials
      WHERE project_id = $1
      ORDER BY item_key ASC`,
    [projectId],
    executor,
  );
  return rows;
}

export const getProjectMaterials = listProjectMaterials;
