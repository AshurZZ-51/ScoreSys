-- ScoreSys 项目池与跨评审会工作流 v2
-- 在 Supabase Dashboard > SQL Editor 中执行。仅新增结构，不删除或重写历史数据。

CREATE TABLE IF NOT EXISTS project_pool (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  submitter TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  normalized_name TEXT NOT NULL,
  normalized_submitter TEXT NOT NULL,
  match_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  current_round SMALLINT,
  current_attempt SMALLINT NOT NULL DEFAULT 1 CHECK (current_attempt IN (1, 2)),
  latest_verdict TEXT CHECK (latest_verdict IN ('approved', 'recheck', 'rejected')),
  material_status TEXT NOT NULL DEFAULT 'unchecked',
  material_note TEXT NOT NULL DEFAULT '',
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_materials (
  project_id UUID NOT NULL REFERENCES project_pool(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  required BOOLEAN NOT NULL,
  status TEXT NOT NULL DEFAULT 'missing' CHECK (status IN ('missing', 'submitted', 'approved', 'needs_revision')),
  note TEXT NOT NULL DEFAULT '',
  checked_by TEXT,
  checked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, item_key)
);

CREATE TABLE IF NOT EXISTS project_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES project_pool(id) ON DELETE CASCADE,
  meeting_project_id UUID,
  meeting_id UUID,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  operator_code TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS meeting_reviewers (
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  reviewer_code TEXT NOT NULL,
  reviewer_name TEXT NOT NULL DEFAULT '',
  reviewer_role TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, reviewer_code)
);

CREATE TABLE IF NOT EXISTS project_migration_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  dry_run JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS project_migration_map (
  legacy_project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  pool_project_id UUID NOT NULL REFERENCES project_pool(id) ON DELETE CASCADE,
  batch_id UUID NOT NULL REFERENCES project_migration_batches(id) ON DELETE CASCADE,
  match_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE meetings ADD COLUMN IF NOT EXISTS workflow_version TEXT NOT NULL DEFAULT 'legacy_v1';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS pool_project_id UUID REFERENCES project_pool(id);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS round_no SMALLINT CHECK (round_no IN (1, 2));
ALTER TABLE projects ADD COLUMN IF NOT EXISTS attempt_no SMALLINT NOT NULL DEFAULT 1 CHECK (attempt_no IN (1, 2));
ALTER TABLE projects ADD COLUMN IF NOT EXISTS scoring_version TEXT NOT NULL DEFAULT 'legacy_v1';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS assignment_status TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS migration_batch_id UUID REFERENCES project_migration_batches(id);

CREATE INDEX IF NOT EXISTS idx_project_pool_status ON project_pool(status) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_projects_pool_project ON projects(pool_project_id) WHERE pool_project_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_meeting_pool_unique ON projects(meeting_id, pool_project_id) WHERE pool_project_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_pool_round_attempt_unique ON projects(pool_project_id, round_no, attempt_no) WHERE pool_project_id IS NOT NULL;

CREATE OR REPLACE FUNCTION assign_pool_project_to_meeting(
  p_project_id UUID,
  p_meeting_id UUID,
  p_round_no SMALLINT,
  p_operator_code TEXT
) RETURNS projects
LANGUAGE plpgsql
AS $$
DECLARE
  pool_row project_pool;
  assignment_count INTEGER;
  attempt SMALLINT;
  seq INTEGER;
  new_project projects;
BEGIN
  SELECT * INTO pool_row FROM project_pool WHERE id = p_project_id AND archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '项目不存在或已归档'; END IF;
  IF pool_row.material_status <> 'complete' THEN RAISE EXCEPTION '必填资料未通过，不能安排评审会'; END IF;
  IF p_round_no = 1 AND pool_row.status = 'ready_r1' THEN attempt := 1;
  ELSIF p_round_no = 1 AND pool_row.status = 'r1_recheck_ready' THEN attempt := 2;
  ELSIF p_round_no = 2 AND pool_row.status = 'ready_r2' THEN attempt := 1;
  ELSIF p_round_no = 2 AND pool_row.status = 'r2_recheck_ready' THEN attempt := 2;
  ELSE RAISE EXCEPTION '项目当前状态与评审轮次不匹配'; END IF;
  SELECT count(*) INTO assignment_count FROM projects WHERE meeting_id = p_meeting_id AND pool_project_id IS NOT NULL;
  IF assignment_count >= 12 THEN RAISE EXCEPTION '评审会已满（最多 12 个项目）'; END IF;
  SELECT coalesce(max(seq_no), 0) + 1 INTO seq FROM projects WHERE meeting_id = p_meeting_id;
  INSERT INTO projects (meeting_id, seq_no, name, submitter, description, problems, actions, is_template, pool_project_id, round_no, attempt_no, scoring_version, assignment_status)
  VALUES (p_meeting_id, seq, pool_row.name, pool_row.submitter, pool_row.description, '{}', '{}', false, p_project_id, p_round_no, attempt, 'two_round_v2', 'scheduled')
  RETURNING * INTO new_project;
  UPDATE project_pool SET status = CASE WHEN p_round_no = 1 THEN 'scheduled_r1' ELSE 'scheduled_r2' END,
    current_round = p_round_no, current_attempt = attempt, updated_at = now() WHERE id = p_project_id;
  INSERT INTO project_status_history(project_id, meeting_project_id, meeting_id, event_type, from_status, to_status, operator_code)
  VALUES (p_project_id, new_project.id, p_meeting_id, 'meeting_scheduled', pool_row.status,
    CASE WHEN p_round_no = 1 THEN 'scheduled_r1' ELSE 'scheduled_r2' END, p_operator_code);
  RETURN new_project;
END;
$$;
