\set ON_ERROR_STOP on

CREATE TEMP TABLE IF NOT EXISTS snapshot_counts (
  table_name TEXT PRIMARY KEY,
  expected_count BIGINT NOT NULL
);
TRUNCATE snapshot_counts;
INSERT INTO snapshot_counts (table_name, expected_count) VALUES
  ('reviewers', 9),
  ('reviewer_dims', 29),
  ('meetings', 15),
  ('projects', 139),
  ('scores', 2653),
  ('project_pool', 67),
  ('project_materials', 662),
  ('project_status_history', 372),
  ('meeting_reviewers', 41),
  ('project_migration_batches', 1),
  ('project_migration_map', 42),
  ('project_deletion_requests', 19),
  ('report_snapshots', 2),
  ('account_audit_logs', 11),
  ('project_rating_history', 0),
  ('project_reviewer_ratings', 84);

DO $gate_g1$
DECLARE
  mismatch TEXT;
  total_count BIGINT;
BEGIN
  WITH actual(table_name, actual_count) AS (
    SELECT 'reviewers', count(*) FROM reviewers UNION ALL
    SELECT 'reviewer_dims', count(*) FROM reviewer_dims UNION ALL
    SELECT 'meetings', count(*) FROM meetings UNION ALL
    SELECT 'projects', count(*) FROM projects UNION ALL
    SELECT 'scores', count(*) FROM scores UNION ALL
    SELECT 'project_pool', count(*) FROM project_pool UNION ALL
    SELECT 'project_materials', count(*) FROM project_materials UNION ALL
    SELECT 'project_status_history', count(*) FROM project_status_history UNION ALL
    SELECT 'meeting_reviewers', count(*) FROM meeting_reviewers UNION ALL
    SELECT 'project_migration_batches', count(*) FROM project_migration_batches UNION ALL
    SELECT 'project_migration_map', count(*) FROM project_migration_map UNION ALL
    SELECT 'project_deletion_requests', count(*) FROM project_deletion_requests UNION ALL
    SELECT 'report_snapshots', count(*) FROM report_snapshots UNION ALL
    SELECT 'account_audit_logs', count(*) FROM account_audit_logs UNION ALL
    SELECT 'project_rating_history', count(*) FROM project_rating_history UNION ALL
    SELECT 'project_reviewer_ratings', count(*) FROM project_reviewer_ratings
  )
  SELECT string_agg(
    format('%s expected %s got %s', expected.table_name, expected.expected_count, actual.actual_count),
    '; ' ORDER BY expected.table_name
  )
  INTO mismatch
  FROM snapshot_counts AS expected
  JOIN actual USING (table_name)
  WHERE expected.expected_count <> actual.actual_count;

  SELECT sum(expected_count) INTO total_count FROM snapshot_counts;
  IF mismatch IS NOT NULL OR total_count <> 4146 THEN
    RAISE EXCEPTION 'G1 row count mismatch: %', coalesce(mismatch, format('total expected 4146 got %s', total_count));
  END IF;
END
$gate_g1$;
SELECT 'G1' AS gate, 'ok' AS result, 4146 AS row_count;

DO $gate_g2$
DECLARE
  invalid_count BIGINT;
BEGIN
  SELECT sum(orphan_count) INTO invalid_count
  FROM (
    SELECT count(*) AS orphan_count FROM reviewer_dims c LEFT JOIN reviewers p ON p.code = c.reviewer_code WHERE c.reviewer_code IS NOT NULL AND p.code IS NULL
    UNION ALL SELECT count(*) FROM projects c LEFT JOIN meetings p ON p.id = c.meeting_id WHERE c.meeting_id IS NOT NULL AND p.id IS NULL
    UNION ALL SELECT count(*) FROM projects c LEFT JOIN project_pool p ON p.id = c.pool_project_id WHERE c.pool_project_id IS NOT NULL AND p.id IS NULL
    UNION ALL SELECT count(*) FROM projects c LEFT JOIN project_migration_batches p ON p.id = c.migration_batch_id WHERE c.migration_batch_id IS NOT NULL AND p.id IS NULL
    UNION ALL SELECT count(*) FROM scores c LEFT JOIN meetings p ON p.id = c.meeting_id WHERE c.meeting_id IS NOT NULL AND p.id IS NULL
    UNION ALL SELECT count(*) FROM scores c LEFT JOIN projects p ON p.id = c.project_id WHERE c.project_id IS NOT NULL AND p.id IS NULL
    UNION ALL SELECT count(*) FROM scores c LEFT JOIN reviewers p ON p.code = c.reviewer_code WHERE c.reviewer_code IS NOT NULL AND p.code IS NULL
    UNION ALL SELECT count(*) FROM project_materials c LEFT JOIN project_pool p ON p.id = c.project_id WHERE c.project_id IS NOT NULL AND p.id IS NULL
    UNION ALL SELECT count(*) FROM project_status_history c LEFT JOIN project_pool p ON p.id = c.project_id WHERE c.project_id IS NOT NULL AND p.id IS NULL
    UNION ALL SELECT count(*) FROM meeting_reviewers c LEFT JOIN meetings p ON p.id = c.meeting_id WHERE c.meeting_id IS NOT NULL AND p.id IS NULL
    UNION ALL SELECT count(*) FROM project_migration_map c LEFT JOIN projects p ON p.id = c.legacy_project_id WHERE c.legacy_project_id IS NOT NULL AND p.id IS NULL
    UNION ALL SELECT count(*) FROM project_migration_map c LEFT JOIN project_pool p ON p.id = c.pool_project_id WHERE c.pool_project_id IS NOT NULL AND p.id IS NULL
    UNION ALL SELECT count(*) FROM project_migration_map c LEFT JOIN project_migration_batches p ON p.id = c.batch_id WHERE c.batch_id IS NOT NULL AND p.id IS NULL
    UNION ALL SELECT count(*) FROM project_deletion_requests c LEFT JOIN project_pool p ON p.id = c.project_id WHERE c.project_id IS NOT NULL AND p.id IS NULL
    UNION ALL SELECT count(*) FROM project_rating_history c LEFT JOIN project_pool p ON p.id = c.project_id WHERE c.project_id IS NOT NULL AND p.id IS NULL
    UNION ALL SELECT count(*) FROM project_reviewer_ratings c LEFT JOIN meetings p ON p.id = c.meeting_id WHERE c.meeting_id IS NOT NULL AND p.id IS NULL
    UNION ALL SELECT count(*) FROM project_reviewer_ratings c LEFT JOIN projects p ON p.id = c.project_id WHERE c.project_id IS NOT NULL AND p.id IS NULL
  ) AS fk_checks;
  IF invalid_count <> 0 THEN
    RAISE EXCEPTION 'G2 foreign key orphan count: %', invalid_count;
  END IF;
END
$gate_g2$;
SELECT 'G2' AS gate, 'ok' AS result, 0 AS orphan_count;

DO $gate_g3$
BEGIN
  IF EXISTS (
    SELECT 1 FROM scores
    GROUP BY meeting_id, project_id, reviewer_code, dim_name
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'G3 duplicate score key';
  END IF;
END
$gate_g3$;
SELECT 'G3' AS gate, 'ok' AS result;

DO $gate_g4$
BEGIN
  IF (SELECT count(*) FROM meetings WHERE is_current) <> 1 THEN
    RAISE EXCEPTION 'G4 expected exactly one current meeting';
  END IF;
END
$gate_g4$;
SELECT 'G4' AS gate, 'ok' AS result;

DO $gate_g5$
BEGIN
  IF EXISTS (
    SELECT 1 FROM project_reviewer_ratings
    GROUP BY meeting_id, project_id, reviewer_code, round_no, attempt_no
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'G5 duplicate reviewer rating assignment key';
  END IF;
END
$gate_g5$;
SELECT 'G5' AS gate, 'ok' AS result;

DO $gate_g6$
BEGIN
  IF EXISTS (
    SELECT 1 FROM project_materials
    WHERE status NOT IN ('missing', 'needs_completion', 'submitted', 'exempt')
  ) THEN
    RAISE EXCEPTION 'G6 invalid project material status';
  END IF;
END
$gate_g6$;
SELECT 'G6' AS gate, 'ok' AS result;

DO $gate_g7$
BEGIN
  IF EXISTS (
    SELECT 1 FROM reviewer_dims
    GROUP BY reviewer_code, dim_name
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'G7 duplicate reviewer dimension key';
  END IF;
END
$gate_g7$;
SELECT 'G7' AS gate, 'ok' AS result;

DO $gate_g8$
DECLARE
  invalid_count BIGINT;
BEGIN
  SELECT count(*) INTO invalid_count
  FROM projects
  WHERE problems IS NULL OR actions IS NULL;

  IF invalid_count <> 0
     OR (SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a WHERE a.attrelid = 'projects'::regclass AND a.attname = 'problems') <> 'text[]'
     OR (SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a WHERE a.attrelid = 'projects'::regclass AND a.attname = 'actions') <> 'text[]'
     OR EXISTS (
       SELECT 1 FROM projects
       WHERE id IN (
         '8bae49cd-1d66-46ea-84d0-5a811c4f8a4a',
         'e6d898a4-116d-461a-ac8f-c14439423b69',
         '49b56a15-6aa5-4b9b-abc9-b4066f3d4c96',
         '39803100-0f1c-422d-a0ba-093ac9b6f4d0',
         'a43838dc-9866-4902-b5b5-2be4f0396018'
       )
       AND (cardinality(problems) <> 0 OR cardinality(actions) <> 0)
     )
  THEN
    RAISE EXCEPTION 'G8 project array normalization failed';
  END IF;
END
$gate_g8$;
SELECT 'G8' AS gate, 'ok' AS result;

DO $gate_g9$
DECLARE
  date_hash TEXT;
BEGIN
  SELECT md5(string_agg(
    id::text || '|' || meeting_date::text || '|' || coalesce(deadline::text, '<NULL>'),
    ',' ORDER BY id
  )) INTO date_hash
  FROM meetings;

  IF date_hash <> '914398f0474dfff3a1c02bb7f418628f'
     OR (SELECT count(*) FROM meetings WHERE deadline IS NULL) <> 3
     OR (SELECT count(*) FROM meetings WHERE notes = '') <> 13
     OR (SELECT count(*) FROM projects WHERE name = '') <> 60
     OR (SELECT count(*) FROM projects WHERE description IS NULL) <> 11
     OR (SELECT count(*) FROM projects WHERE description = '') <> 127
     OR (SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a WHERE a.attrelid = 'scores'::regclass AND a.attname = 'score') <> 'integer'
  THEN
    RAISE EXCEPTION 'G9 date/null/empty-string/integer fidelity failed';
  END IF;
END
$gate_g9$;
SELECT 'G9' AS gate, 'ok' AS result;

DO $gate_g10$
DECLARE
  function_count INTEGER;
BEGIN
  SELECT count(*) INTO function_count
  FROM pg_proc AS procedure
  JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname = 'public'
    AND procedure.proname IN (
      'apply_project_pool_mutations',
      'purge_due_project_deletions',
      'assign_pool_project_to_meeting',
      'apply_project_rating'
    )
    AND procedure.prokind = 'f'
    AND NOT procedure.prosecdef
    AND oidvectortypes(procedure.proargtypes) = CASE procedure.proname
      WHEN 'apply_project_pool_mutations' THEN 'uuid[], text, text, text, text'
      WHEN 'purge_due_project_deletions' THEN ''
      WHEN 'assign_pool_project_to_meeting' THEN 'uuid, uuid, smallint, text'
      WHEN 'apply_project_rating' THEN 'uuid, text, text, text'
    END
    AND has_function_privilege('scoringsys_app', procedure.oid, 'EXECUTE');

  IF function_count <> 4 THEN
    RAISE EXCEPTION 'G10 expected four invoker functions executable by scoringsys_app, got %', function_count;
  END IF;

  IF EXISTS (
       SELECT 1 FROM pg_roles
       WHERE rolname = 'scoringsys_app'
         AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit)
     )
     OR has_schema_privilege('scoringsys_app', 'public', 'CREATE')
     OR EXISTS (
       SELECT 1 FROM pg_class
       WHERE relnamespace = 'public'::regnamespace
         AND relowner = 'scoringsys_app'::regrole
     )
  THEN
    RAISE EXCEPTION 'G10 scoringsys_app has elevated role, DDL, or ownership privileges';
  END IF;

  BEGIN
    PERFORM apply_project_pool_mutations(ARRAY[]::UUID[], 'status', 'draft', 'gate', '');
  EXCEPTION WHEN raise_exception THEN
    NULL;
  END;
END
$gate_g10$;
SELECT 'G10' AS gate, 'ok' AS result, 4 AS function_count;
