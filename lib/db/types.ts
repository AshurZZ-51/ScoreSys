export type DateString = string;
export type Numeric = number | string;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ReviewerRow {
  code: string;
  name: string;
  role: string | null;
  is_admin: boolean;
  password_hash: string;
  created_at: Date;
}

export interface ReviewerDimRow {
  id: string;
  reviewer_code: string;
  dim_name: string;
  max_score: number;
}

export interface MeetingRow {
  id: string;
  name: string;
  meeting_date: DateString;
  deadline: DateString | null;
  status: string;
  notes: string | null;
  is_current: boolean;
  deleted_at: Date | null;
  scheduled_purge_at: Date | null;
  created_at: Date;
  workflow_version: string;
}

export interface ProjectRow {
  id: string;
  meeting_id: string;
  seq_no: number;
  name: string;
  submitter: string;
  description: string | null;
  is_template: boolean;
  is_pending: boolean;
  problems: string[];
  actions: string[];
  created_at: Date;
  pool_project_id: string | null;
  round_no: number | null;
  attempt_no: number;
  scoring_version: string;
  assignment_status: string | null;
  migration_batch_id: string | null;
}

export interface ScoreRow {
  id: string;
  meeting_id: string;
  project_id: string;
  reviewer_code: string;
  dim_name: string;
  score: Numeric;
  comment: string | null;
  updated_at: Date;
}

export interface ProjectPoolRow {
  id: string;
  name: string;
  submitter: string;
  description: string;
  normalized_name: string;
  normalized_submitter: string;
  match_key: string;
  status: string;
  current_round: number | null;
  current_attempt: number;
  latest_verdict: string | null;
  material_status: string;
  material_note: string;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
  project_code: string | null;
  preliminary_rating: string | null;
  final_rating: string | null;
  rating_updated_at: Date | null;
  rating_updated_by: string | null;
  initiation_announcement: string | null;
  initiation_announcement_updated_at: Date | null;
  initiation_announcement_updated_by: string | null;
}

export interface ProjectMaterialRow {
  project_id: string;
  item_key: string;
  round_no: number;
  required: boolean;
  status: string;
  note: string;
  checked_by: string | null;
  checked_at: Date | null;
  updated_at: Date;
}

export interface ProjectStatusHistoryRow {
  id: string;
  project_id: string;
  meeting_project_id: string | null;
  meeting_id: string | null;
  event_type: string;
  from_status: string | null;
  to_status: string;
  operator_code: string;
  note: string;
  created_at: Date;
}

export interface MeetingReviewerRow {
  meeting_id: string;
  reviewer_code: string;
  reviewer_name: string;
  reviewer_role: string;
  created_at: Date;
}

export interface ProjectMigrationBatchRow {
  id: string;
  operator_code: string;
  status: string;
  dry_run: JsonValue;
  result: JsonValue;
  created_at: Date;
  completed_at: Date | null;
}

export interface ProjectMigrationMapRow {
  legacy_project_id: string;
  pool_project_id: string;
  batch_id: string;
  match_key: string;
  created_at: Date;
}

export interface ProjectDeletionRequestRow {
  project_id: string;
  requested_by: string;
  requested_at: Date;
  purge_after: Date;
  restored_at: Date | null;
  restored_by: string | null;
}

export interface ReportSnapshotRow {
  id: string;
  scope_type: string;
  scope_id: string;
  report_type: string;
  version: number;
  payload: JsonValue;
  generated_by: string;
  generated_at: Date;
}

export interface AccountAuditLogRow {
  id: string;
  actor_code: string;
  target_code: string;
  action: string;
  created_at: Date;
}

export interface ProjectRatingHistoryRow {
  id: string;
  project_id: string;
  rating_type: string;
  from_rating: string | null;
  to_rating: string;
  operator_code: string;
  created_at: Date;
}

export interface ProjectReviewerRatingRow {
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
