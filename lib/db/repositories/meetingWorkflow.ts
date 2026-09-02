import type { Connector, Executor } from '../client';
import { execute, one, query, tx } from '../client';
import { pool } from '../pool';
import type { MeetingRow, ProjectPoolRow, ProjectRow } from '../types';

interface AssignableProject extends Pick<ProjectPoolRow, 'id' | 'name' | 'submitter' | 'description' | 'status' | 'archived_at'> {}

export interface ListMeetingsInput {
  meetingId?: string | null;
  includeDeleted?: boolean;
}

export interface MeetingMaterialInput {
  itemKey: string;
  roundNo: 1 | 2;
  required: boolean;
  status: string;
  checkedBy?: string | null;
  checkedAt?: string | null;
}

export interface QuickMeetingProjectInput {
  name: string;
  submitter: string;
  description: string;
  normalizedName: string;
  normalizedSubmitter: string;
  matchKey: string;
  roundNo: 1 | 2;
  materials: MeetingMaterialInput[];
}

export interface TemplateMeetingProjectInput {
  seq_no: number;
  name: string;
  submitter: string;
  description: string;
  is_template: boolean;
  problems: string[];
  actions: string[];
}

export interface CreateMeetingWorkflowInput {
  name: string;
  meetingDate: string;
  deadline: string | null;
  notes: string;
  projectPoolV2: boolean;
  poolProjectIds: string[];
  quickProjects: QuickMeetingProjectInput[];
  templateProjects: TemplateMeetingProjectInput[];
  operatorCode: string;
}

export type CreateMeetingWorkflowResult =
  | { ok: true; meeting: MeetingRow }
  | { ok: false; reason: 'invalid_pool_projects' };

export interface UpdateMeetingWorkflowInput {
  id: string;
  isCurrent?: boolean;
  name?: string;
  meetingDate?: string;
  deadline?: string | null;
  notes?: string;
}

function assignmentRound(status: string): 1 | 2 | null {
  if (status === 'ready_r2' || status === 'r2_recheck_ready') return 2;
  if (['draft', 'materials_pending', 'ready_r1', 'r1_recheck_ready'].includes(status)) return 1;
  return null;
}

export function listMeetings(
  input: ListMeetingsInput,
  executor?: Executor,
): Promise<MeetingRow[]> {
  const params: unknown[] = [];
  let where = '';
  if (input.meetingId) {
    params.push(input.meetingId);
    where = 'WHERE id = $1';
  } else if (!input.includeDeleted) {
    where = 'WHERE deleted_at IS NULL';
  }

  return query<MeetingRow>(
    `SELECT id, name, meeting_date, deadline, status, notes, workflow_version,
            is_current, deleted_at, scheduled_purge_at, created_at
       FROM meetings
       ${where}
      ORDER BY meeting_date DESC`,
    params,
    executor,
  );
}

export async function createMeetingWorkflow(
  input: CreateMeetingWorkflowInput,
  connector: Connector = pool,
): Promise<CreateMeetingWorkflowResult> {
  return tx(async (transaction) => {
    let selectedProjects: AssignableProject[] = [];
    if (input.projectPoolV2 && input.poolProjectIds.length > 0) {
      selectedProjects = await query<AssignableProject>(
        `SELECT id, name, submitter, description, status, archived_at
           FROM project_pool
          WHERE id = ANY($1::uuid[])
          ORDER BY array_position($1::uuid[], id)
          FOR UPDATE`,
        [input.poolProjectIds],
        transaction,
      );
      if (
        selectedProjects.length !== input.poolProjectIds.length
        || selectedProjects.some((project) => project.archived_at || assignmentRound(project.status) === null)
      ) {
        return { ok: false, reason: 'invalid_pool_projects' };
      }
    }

    const meeting = await one<MeetingRow>(
      `INSERT INTO meetings (name, meeting_date, deadline, notes, status, workflow_version)
       VALUES ($1, $2::date, $3::date, $4, $5, $6)
       RETURNING *`,
      [
        input.name,
        input.meetingDate,
        input.deadline,
        input.notes,
        'active',
        input.projectPoolV2 ? 'project_pool_v4' : 'legacy_v1',
      ],
      transaction,
    );

    if (input.projectPoolV2) {
      await execute(
        `INSERT INTO meeting_reviewers (
           meeting_id, reviewer_code, reviewer_name, reviewer_role
         )
         SELECT $1::uuid, code, COALESCE(name, ''), COALESCE(role, '')
           FROM reviewers
          WHERE is_admin = false`,
        [meeting.id],
        transaction,
      );

      for (const quick of input.quickProjects) {
        const status = quick.roundNo === 2 ? 'ready_r2' : 'ready_r1';
        const project = await one<AssignableProject>(
          `INSERT INTO project_pool (
             name, submitter, description, normalized_name, normalized_submitter,
             match_key, status, material_status
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, name, submitter, description, status, archived_at`,
          [
            quick.name,
            quick.submitter,
            quick.description,
            quick.normalizedName,
            quick.normalizedSubmitter,
            quick.matchKey,
            status,
            'incomplete',
          ],
          transaction,
        );

        const materials = quick.materials.map((material) => ({
          item_key: material.itemKey,
          round_no: material.roundNo,
          required: material.required,
          status: material.status,
          checked_by: material.checkedBy ?? null,
          checked_at: material.checkedAt ?? null,
        }));
        if (materials.length > 0) {
          await execute(
            `INSERT INTO project_materials (
               project_id, item_key, round_no, required, status, checked_by, checked_at
             )
             SELECT $1::uuid, material.item_key, material.round_no, material.required, material.status,
                    material.checked_by, material.checked_at
               FROM jsonb_to_recordset($2::jsonb) AS material(
                 item_key text,
                 round_no smallint,
                 required boolean,
                 status text,
                 checked_by text,
                 checked_at timestamptz
               )`,
            [project.id, JSON.stringify(materials)],
            transaction,
          );
        }

        await execute(
          `INSERT INTO project_status_history (
             project_id, event_type, to_status, operator_code, note
           )
           VALUES ($1::uuid, $2, $3, $4, $5)`,
          [project.id, 'project_created', project.status, input.operatorCode, '在创建评审会时快速创建'],
          transaction,
        );
        selectedProjects.push(project);
      }

      for (const [index, project] of selectedProjects.entries()) {
        const roundNo = assignmentRound(project.status);
        if (roundNo === null) return { ok: false, reason: 'invalid_pool_projects' };
        const attemptNo = project.status.includes('recheck') ? 2 : 1;
        const assignment = await one<ProjectRow>(
          `INSERT INTO projects (
             meeting_id, seq_no, name, submitter, description, problems, actions,
             is_template, pool_project_id, round_no, attempt_no, scoring_version,
             assignment_status
           )
           VALUES (
             $1::uuid, $2, $3, $4, $5, $6::text[], $7::text[], $8,
             $9::uuid, $10, $11, $12, $13
           )
           RETURNING *`,
          [
            meeting.id,
            index + 1,
            project.name,
            project.submitter,
            project.description || '',
            [],
            [],
            false,
            project.id,
            roundNo,
            attemptNo,
            roundNo === 2 ? 'two_round_v5' : 'two_round_v2',
            'scheduled',
          ],
          transaction,
        );
        const nextStatus = roundNo === 1 ? 'scheduled_r1' : 'scheduled_r2';
        await execute(
          `UPDATE project_pool
              SET status = $1, current_round = $2, current_attempt = $3, updated_at = now()
            WHERE id = $4::uuid`,
          [nextStatus, roundNo, attemptNo, project.id],
          transaction,
        );
        await execute(
          `INSERT INTO project_status_history (
             project_id, meeting_project_id, meeting_id, event_type,
             from_status, to_status, operator_code
           )
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)`,
          [project.id, assignment.id, meeting.id, 'meeting_scheduled', project.status, nextStatus, input.operatorCode],
          transaction,
        );
      }
    } else if (input.templateProjects.length > 0) {
      const templates = input.templateProjects.map((template) => ({
        seq_no: template.seq_no,
        name: template.name,
        submitter: template.submitter,
        description: template.description,
        is_template: template.is_template,
        problems: template.problems,
        actions: template.actions,
      }));
      await execute(
        `INSERT INTO projects (
           meeting_id, seq_no, name, submitter, description, is_template, problems, actions
         )
         SELECT $1::uuid, template.seq_no, template.name, template.submitter,
                template.description, template.is_template, template.problems, template.actions
           FROM jsonb_to_recordset($2::jsonb) AS template(
             seq_no integer,
             name text,
             submitter text,
             description text,
             is_template boolean,
             problems text[],
             actions text[]
           )`,
        [meeting.id, JSON.stringify(templates)],
        transaction,
      );
    }

    return { ok: true, meeting };
  }, connector);
}

export async function updateMeetingWorkflow(
  input: UpdateMeetingWorkflowInput,
  connector: Connector = pool,
): Promise<MeetingRow> {
  return tx(async (transaction) => {
    if (input.isCurrent === true) {
      await execute('LOCK TABLE meetings IN SHARE ROW EXCLUSIVE MODE', [], transaction);
      await execute('UPDATE meetings SET is_current = false WHERE is_current = true', [], transaction);
    }

    return one<MeetingRow>(
      `UPDATE meetings
          SET is_current = CASE WHEN $2::boolean THEN $3::boolean ELSE is_current END,
              name = CASE WHEN $4::boolean THEN $5::text ELSE name END,
              meeting_date = CASE WHEN $6::boolean THEN $7::date ELSE meeting_date END,
              deadline = CASE WHEN $8::boolean THEN $9::date ELSE deadline END,
              notes = CASE WHEN $10::boolean THEN $11::text ELSE notes END
        WHERE id = $1::uuid
          AND deleted_at IS NULL
        RETURNING *`,
      [
        input.id,
        input.isCurrent !== undefined,
        input.isCurrent ?? false,
        input.name !== undefined,
        input.name ?? null,
        input.meetingDate !== undefined,
        input.meetingDate ?? null,
        input.deadline !== undefined,
        input.deadline ?? null,
        input.notes !== undefined,
        input.notes ?? null,
      ],
      transaction,
    );
  }, connector);
}
