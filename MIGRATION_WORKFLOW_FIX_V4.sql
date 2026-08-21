-- ScoreSys workflow repair v4.
-- Run this once in Supabase SQL Editor after MIGRATION_ADMIN_LIFECYCLE_V3.sql.
-- It aligns persisted workflow rules with the admin UI:
-- 1) material status does not block first-round scheduling;
-- 2) manual status changes no longer fail on an ambiguous SQL output column.

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
    RAISE EXCEPTION 'At least one project is required';
  END IF;
  IF p_action NOT IN ('status', 'archive') THEN
    RAISE EXCEPTION 'Invalid project operation';
  END IF;
  IF p_action = 'status' AND p_status NOT IN ('draft', 'materials_pending', 'ready_r1', 'r1_recheck_ready', 'ready_r2', 'r2_recheck_ready', 'initiation', 'rejected') THEN
    RAISE EXCEPTION 'Invalid project status';
  END IF;
  IF coalesce(trim(p_operator_code), '') = '' THEN
    RAISE EXCEPTION 'Operator is required';
  END IF;

  SELECT count(*) INTO found_count FROM project_pool WHERE id = ANY(p_project_ids);
  IF found_count <> cardinality(p_project_ids) THEN
    RAISE EXCEPTION 'Some projects do not exist';
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
    SELECT updated.project_id,
      CASE WHEN p_action = 'archive' THEN 'project_archived' ELSE 'admin_adjustment' END,
      updated.from_status,
      CASE WHEN p_action = 'archive' THEN 'archived' ELSE updated.status END,
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
  IF NOT FOUND THEN RAISE EXCEPTION 'Project does not exist or is archived'; END IF;
  IF p_round_no = 1 AND pool_row.status IN ('draft', 'materials_pending', 'ready_r1') THEN attempt := 1;
  ELSIF p_round_no = 1 AND pool_row.status = 'r1_recheck_ready' THEN attempt := 2;
  ELSIF p_round_no = 2 AND pool_row.status = 'ready_r2' THEN attempt := 1;
  ELSIF p_round_no = 2 AND pool_row.status = 'r2_recheck_ready' THEN attempt := 2;
  ELSE RAISE EXCEPTION 'Project status does not match review round'; END IF;
  PERFORM 1 FROM meetings WHERE id = p_meeting_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Meeting does not exist'; END IF;
  SELECT count(*) INTO assignment_count FROM projects WHERE meeting_id = p_meeting_id AND pool_project_id IS NOT NULL;
  IF assignment_count >= 12 THEN RAISE EXCEPTION 'Meeting is full (maximum 12 projects)'; END IF;
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
