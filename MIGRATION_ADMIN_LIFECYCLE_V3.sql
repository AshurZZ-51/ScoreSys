-- ScoreSys admin lifecycle migration v3.
-- Run manually in Supabase SQL Editor after reviewing the existing schema.

ALTER TABLE project_materials DROP CONSTRAINT IF EXISTS project_materials_status_check;

UPDATE project_materials
  SET status = 'submitted'
  WHERE status = 'approved';

UPDATE project_materials
  SET status = 'needs_completion'
  WHERE status = 'needs_revision';

ALTER TABLE project_materials
  ADD CONSTRAINT project_materials_status_check
  CHECK (status IN ('missing', 'needs_completion', 'submitted', 'exempt'));

CREATE TABLE IF NOT EXISTS project_deletion_requests (
  project_id UUID PRIMARY KEY REFERENCES project_pool(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  purge_after TIMESTAMPTZ NOT NULL,
  restored_at TIMESTAMPTZ,
  restored_by TEXT
);

CREATE TABLE IF NOT EXISTS report_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('meeting', 'project')),
  scope_id UUID NOT NULL,
  report_type TEXT NOT NULL CHECK (report_type IN ('round_1', 'round_2', 'initiation')),
  version INTEGER NOT NULL,
  payload JSONB NOT NULL,
  generated_by TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_code TEXT NOT NULL,
  target_code TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A project status mutation and its history row must commit together.
CREATE OR REPLACE FUNCTION apply_project_pool_mutations(
  p_project_ids UUID[],
  p_action TEXT,
  p_status TEXT,
  p_operator_code TEXT,
  p_note TEXT DEFAULT ''
) RETURNS TABLE (
  project_id UUID,
  status TEXT,
  latest_verdict TEXT,
  archived_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  found_count INTEGER;
BEGIN
  IF coalesce(array_length(p_project_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION '至少需要一个项目';
  END IF;
  IF p_action NOT IN ('status', 'archive') THEN
    RAISE EXCEPTION '无效项目操作';
  END IF;
  IF p_action = 'status' AND coalesce(trim(p_status), '') = '' THEN
    RAISE EXCEPTION '状态不能为空';
  END IF;
  IF coalesce(trim(p_operator_code), '') = '' THEN
    RAISE EXCEPTION '操作人不能为空';
  END IF;

  SELECT count(*) INTO found_count FROM project_pool WHERE id = ANY(p_project_ids);
  IF found_count <> cardinality(p_project_ids) THEN
    RAISE EXCEPTION '部分项目不存在';
  END IF;

  RETURN QUERY
  WITH locked AS MATERIALIZED (
    SELECT pool.id, pool.status AS from_status, pool.latest_verdict AS previous_verdict
    FROM project_pool AS pool
    WHERE pool.id = ANY(p_project_ids)
    FOR UPDATE
  ), updated AS (
    UPDATE project_pool AS pool
    SET status = CASE WHEN p_action = 'status' THEN p_status ELSE pool.status END,
        latest_verdict = CASE
          WHEN p_action <> 'status' THEN pool.latest_verdict
          WHEN p_status = 'rejected' THEN 'rejected'
          WHEN p_status IN ('initiation', 'ready_r2') THEN 'approved'
          WHEN p_status LIKE '%recheck%' THEN 'recheck'
          ELSE pool.latest_verdict
        END,
        archived_at = CASE WHEN p_action = 'archive' THEN now() ELSE pool.archived_at END,
        updated_at = now()
    FROM locked
    WHERE pool.id = locked.id
    RETURNING pool.id AS project_id, pool.status, pool.latest_verdict, pool.archived_at, locked.from_status
  ), audit AS (
    INSERT INTO project_status_history(project_id, event_type, from_status, to_status, operator_code, note)
    SELECT project_id,
      CASE WHEN p_action = 'archive' THEN 'project_archived' ELSE 'admin_adjustment' END,
      from_status,
      CASE WHEN p_action = 'archive' THEN 'archived' ELSE status END,
      p_operator_code,
      coalesce(p_note, '')
    FROM updated
    RETURNING project_id
  )
  SELECT updated.project_id, updated.status, updated.latest_verdict, updated.archived_at
  FROM updated
  INNER JOIN audit USING (project_id);
END;
$$;

-- Lock each due purge request and its project row before deleting dependent data.
-- SKIP LOCKED lets a concurrent restore win without a partial purge.
CREATE OR REPLACE FUNCTION purge_due_project_deletions()
RETURNS TABLE (project_id UUID)
LANGUAGE plpgsql
AS $$
DECLARE
  due_record RECORD;
BEGIN
  FOR due_record IN
    SELECT deletion_request.project_id, deletion_request.purge_after, deletion_request.restored_at
    FROM project_deletion_requests AS deletion_request
    INNER JOIN project_pool AS pool_row ON pool_row.id = deletion_request.project_id
    WHERE deletion_request.restored_at IS NULL
      AND deletion_request.purge_after <= now()
    FOR UPDATE OF deletion_request, pool_row SKIP LOCKED
  LOOP
    -- The locks remain held through the recheck and all dependent deletes.
    IF due_record.restored_at IS NULL AND due_record.purge_after <= now() THEN
    DELETE FROM scores
    USING projects AS assignment
    WHERE scores.project_id = assignment.id
        AND assignment.pool_project_id = due_record.project_id;

    DELETE FROM projects
    WHERE projects.pool_project_id = due_record.project_id;

    DELETE FROM report_snapshots
    WHERE report_snapshots.scope_type = 'project'
        AND report_snapshots.scope_id = due_record.project_id;

    DELETE FROM project_pool
    WHERE project_pool.id = due_record.project_id;

    IF FOUND THEN
      project_id := due_record.project_id;
      RETURN NEXT;
    END IF;
    END IF;
  END LOOP;
END;
$$;

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
  IF p_round_no = 1 AND pool_row.status = 'ready_r1' THEN attempt := 1;
  ELSIF p_round_no = 1 AND pool_row.status = 'r1_recheck_ready' THEN attempt := 2;
  ELSIF p_round_no = 2 AND pool_row.status = 'ready_r2' THEN attempt := 1;
  ELSIF p_round_no = 2 AND pool_row.status = 'r2_recheck_ready' THEN attempt := 2;
  ELSE RAISE EXCEPTION '项目当前状态与评审轮次不匹配'; END IF;
  PERFORM 1 FROM meetings WHERE id = p_meeting_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '评审会不存在'; END IF;
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
