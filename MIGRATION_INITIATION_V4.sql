-- ScoreSys 立项资料、V4 评分配套迁移
-- 在 Supabase SQL Editor 执行。脚本可重复执行，不重算历史评分。

ALTER TABLE project_pool
  ADD COLUMN IF NOT EXISTS project_code TEXT,
  ADD COLUMN IF NOT EXISTS preliminary_rating TEXT,
  ADD COLUMN IF NOT EXISTS final_rating TEXT,
  ADD COLUMN IF NOT EXISTS rating_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rating_updated_by TEXT,
  ADD COLUMN IF NOT EXISTS initiation_announcement TEXT,
  ADD COLUMN IF NOT EXISTS initiation_announcement_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS initiation_announcement_updated_by TEXT;

ALTER TABLE project_pool
  DROP CONSTRAINT IF EXISTS project_pool_preliminary_rating_check,
  DROP CONSTRAINT IF EXISTS project_pool_final_rating_check;

ALTER TABLE project_pool
  ADD CONSTRAINT project_pool_preliminary_rating_check
    CHECK (preliminary_rating IS NULL OR preliminary_rating IN ('S', 'A', 'B', 'C')),
  ADD CONSTRAINT project_pool_final_rating_check
    CHECK (final_rating IS NULL OR final_rating IN ('S', 'A', 'B', 'C'));

CREATE UNIQUE INDEX IF NOT EXISTS project_pool_project_code_key
  ON project_pool(project_code)
  WHERE project_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS project_rating_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES project_pool(id) ON DELETE CASCADE,
  rating_type TEXT NOT NULL CHECK (rating_type IN ('preliminary', 'final')),
  from_rating TEXT,
  to_rating TEXT NOT NULL CHECK (to_rating IN ('S', 'A', 'B', 'C')),
  operator_code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_rating_history_project
  ON project_rating_history(project_id, created_at DESC);

ALTER TABLE project_materials DROP CONSTRAINT IF EXISTS project_materials_status_check;

UPDATE project_materials SET status = 'submitted' WHERE status = 'approved';
UPDATE project_materials SET status = 'needs_completion' WHERE status = 'needs_revision';

ALTER TABLE project_materials
  ADD CONSTRAINT project_materials_status_check
  CHECK (status IN ('missing', 'needs_completion', 'submitted', 'exempt'));

INSERT INTO project_materials (project_id, item_key, required, status)
SELECT pool.id, item.item_key, item.required, 'missing'
FROM project_pool AS pool
CROSS JOIN (VALUES
  ('operations_metrics', true),
  ('virtual_team', true)
) AS item(item_key, required)
ON CONFLICT (project_id, item_key) DO UPDATE
SET required = EXCLUDED.required,
    updated_at = now();

-- Existing rows keep their own completion status. Only missing metadata is filled.
UPDATE project_materials
SET required = CASE
  WHEN item_key IN ('basic_info', 'positioning', 'gameplay_plan', 'risk_statement', 'initial_plan', 'operations_metrics', 'virtual_team') THEN true
  ELSE false
END,
updated_at = now();

UPDATE project_pool AS pool
SET material_status = CASE WHEN EXISTS (
  SELECT 1 FROM project_materials AS material
  WHERE material.project_id = pool.id
    AND material.required = true
    AND material.status NOT IN ('submitted', 'exempt')
) THEN 'incomplete' ELSE 'complete' END,
updated_at = now();

-- New reviewer accounts. Initial passwords are ollie123 and simon123; reset them after first login.
INSERT INTO reviewers (code, name, role, is_admin, password_hash)
VALUES
  ('o', 'Ollie', '运营评委', false, 'ollie123'),
  ('si', 'Simon', '商务评委', false, 'simon123')
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    role = EXCLUDED.role,
    is_admin = false;

-- The new round uses meeting snapshots rather than reviewer_dims to grant every non-admin reviewer
-- all dimensions. These rows keep the accounts usable in older views that still read reviewer_dims.
INSERT INTO reviewer_dims (reviewer_code, dim_name, max_score)
SELECT reviewer.code, dimension.name, 10
FROM reviewers AS reviewer
CROSS JOIN (VALUES
  ('游戏性'), ('创新性'), ('项目规划'), ('技术&美术'), ('风险预估'), ('造价与预算')
) AS dimension(name)
WHERE reviewer.code IN ('o', 'si')
ON CONFLICT (reviewer_code, dim_name) DO NOTHING;

CREATE OR REPLACE FUNCTION apply_project_rating(
  p_project_id UUID,
  p_rating_type TEXT,
  p_rating TEXT,
  p_operator_code TEXT
) RETURNS project_pool
LANGUAGE plpgsql
AS $$
DECLARE
  current_row project_pool;
  updated_row project_pool;
  old_rating TEXT;
BEGIN
  IF p_rating_type NOT IN ('preliminary', 'final') THEN RAISE EXCEPTION '无效评级类型'; END IF;
  IF p_rating NOT IN ('S', 'A', 'B', 'C') THEN RAISE EXCEPTION '评级必须为 S/A/B/C'; END IF;
  SELECT * INTO current_row FROM project_pool WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '项目不存在'; END IF;
  old_rating := CASE WHEN p_rating_type = 'final' THEN current_row.final_rating ELSE current_row.preliminary_rating END;

  IF p_rating_type = 'final' THEN
    UPDATE project_pool SET final_rating = p_rating, rating_updated_at = now(), rating_updated_by = p_operator_code, updated_at = now() WHERE id = p_project_id;
  ELSE
    UPDATE project_pool SET preliminary_rating = p_rating, rating_updated_at = now(), rating_updated_by = p_operator_code, updated_at = now() WHERE id = p_project_id;
  END IF;

  INSERT INTO project_rating_history(project_id, rating_type, from_rating, to_rating, operator_code)
  VALUES (p_project_id, p_rating_type, old_rating, p_rating, p_operator_code);
  SELECT * INTO updated_row FROM project_pool WHERE id = p_project_id;
  RETURN updated_row;
END;
$$;

-- New assignments use two_round_v4 for round two. Existing assignments are untouched.
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
  SELECT * INTO pool_row FROM project_pool
  WHERE id = p_project_id AND archived_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '项目不存在或已归档'; END IF;

  IF p_round_no = 1 AND pool_row.status IN ('draft', 'materials_pending', 'ready_r1') THEN attempt := 1;
  ELSIF p_round_no = 1 AND pool_row.status = 'r1_recheck_ready' THEN attempt := 2;
  ELSIF p_round_no = 2 AND pool_row.status = 'ready_r2' THEN attempt := 1;
  ELSIF p_round_no = 2 AND pool_row.status = 'r2_recheck_ready' THEN attempt := 2;
  ELSE RAISE EXCEPTION '项目当前状态与评审轮次不匹配'; END IF;

  PERFORM 1 FROM meetings WHERE id = p_meeting_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '评审会不存在'; END IF;
  SELECT count(*) INTO assignment_count FROM projects
  WHERE meeting_id = p_meeting_id AND pool_project_id IS NOT NULL;
  IF assignment_count >= 12 THEN RAISE EXCEPTION '评审会已满（最多 12 个项目）'; END IF;
  SELECT coalesce(max(seq_no), 0) + 1 INTO seq FROM projects WHERE meeting_id = p_meeting_id;

  INSERT INTO projects (
    meeting_id, seq_no, name, submitter, description, problems, actions,
    is_template, pool_project_id, round_no, attempt_no, scoring_version, assignment_status
  ) VALUES (
    p_meeting_id, seq, pool_row.name, pool_row.submitter, pool_row.description, '{}', '{}',
    false, p_project_id, p_round_no, attempt,
    CASE WHEN p_round_no = 2 THEN 'two_round_v4' ELSE 'two_round_v2' END,
    'scheduled'
  ) RETURNING * INTO new_project;

  UPDATE project_pool
  SET status = CASE WHEN p_round_no = 1 THEN 'scheduled_r1' ELSE 'scheduled_r2' END,
      current_round = p_round_no,
      current_attempt = attempt,
      updated_at = now()
  WHERE id = p_project_id;

  INSERT INTO project_status_history(project_id, meeting_project_id, meeting_id, event_type, from_status, to_status, operator_code)
  VALUES (
    p_project_id, new_project.id, p_meeting_id, 'meeting_scheduled', pool_row.status,
    CASE WHEN p_round_no = 1 THEN 'scheduled_r1' ELSE 'scheduled_r2' END, p_operator_code
  );
  RETURN new_project;
END;
$$;
