-- ScoreSys legacy project pool backfill v1
-- Run after MIGRATION_PROJECT_POOL_V2.sql and MIGRATION_BLIND_RECOMMENDATION_V2.sql.
-- This migration is idempotent. It links legacy projects to project_pool without
-- deleting, rewriting, or recalculating legacy projects or scores.

DO $project_pool_backfill$
DECLARE
  backfill_batch_id UUID;
  candidate_count BIGINT;
  existing_link_count BIGINT;
  pool_table_count BIGINT;
  pool_count BIGINT;
  material_rows_created BIGINT;
BEGIN
  IF to_regclass('public.project_pool') IS NULL
     OR to_regclass('public.project_materials') IS NULL
     OR to_regclass('public.project_migration_batches') IS NULL
     OR to_regclass('public.project_migration_map') IS NULL
  THEN
    RAISE EXCEPTION 'project pool schema is incomplete; run MIGRATION_PROJECT_POOL_V2.sql first';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'public.project_materials'::regclass
      AND attname = 'round_no'
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'round-specific materials are not ready; run MIGRATION_BLIND_RECOMMENDATION_V2.sql first';
  END IF;

  -- Only legacy rows with real project information are eligible. Empty template
  -- slots are intentionally left for the current meeting editor to manage.
  CREATE TEMP TABLE legacy_pool_candidates ON COMMIT DROP AS
  SELECT
    legacy.id AS legacy_project_id,
    btrim(legacy.name) AS name,
    btrim(legacy.submitter) AS submitter,
    coalesce(legacy.description, '') AS description,
    lower(regexp_replace(btrim(legacy.name), '\s+', ' ', 'g')) AS normalized_name,
    lower(regexp_replace(btrim(legacy.submitter), '\s+', ' ', 'g')) AS normalized_submitter,
    lower(regexp_replace(btrim(legacy.name), '\s+', ' ', 'g'))
      || '::' ||
    lower(regexp_replace(btrim(legacy.submitter), '\s+', ' ', 'g')) AS match_key,
    coalesce(legacy.created_at, now()) AS created_at
  FROM projects AS legacy
  WHERE coalesce(btrim(legacy.name), '') <> ''
    AND coalesce(btrim(legacy.submitter), '') <> ''
    AND legacy.pool_project_id IS NULL;

  -- Older deployments may already have pool_project_id values but no migration
  -- map rows. Record those links as well so the migration audit is complete.
  CREATE TEMP TABLE existing_legacy_links ON COMMIT DROP AS
  SELECT
    legacy.id AS legacy_project_id,
    legacy.pool_project_id,
    lower(regexp_replace(btrim(legacy.name), '\s+', ' ', 'g'))
      || '::' ||
    lower(regexp_replace(btrim(legacy.submitter), '\s+', ' ', 'g')) AS match_key
  FROM projects AS legacy
  INNER JOIN project_pool AS pool ON pool.id = legacy.pool_project_id
  WHERE legacy.pool_project_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM project_migration_map AS map
      WHERE map.legacy_project_id = legacy.id
    );

  SELECT count(*) INTO candidate_count FROM legacy_pool_candidates;
  SELECT count(*) INTO existing_link_count FROM existing_legacy_links;
  SELECT count(*) INTO pool_table_count FROM project_pool;
  IF candidate_count = 0 AND existing_link_count = 0 AND pool_table_count = 0 THEN
    RAISE NOTICE 'project pool backfill: no unlinked legacy projects found';
    RETURN;
  END IF;

  INSERT INTO project_migration_batches (
    operator_code, status, dry_run, result, created_at
  )
  VALUES (
    'migration',
    'running',
    jsonb_build_object('source', 'legacy_projects', 'candidate_count', candidate_count),
    '{}'::jsonb,
    now()
  )
  RETURNING id INTO backfill_batch_id;

  -- Reuse an earlier migration target when a previous partial run already
  -- recorded the same match key. Otherwise create one deterministic new pool id.
  CREATE TEMP TABLE legacy_pool_targets ON COMMIT DROP AS
  SELECT
    candidate.match_key,
    coalesce(existing.pool_project_id, gen_random_uuid()) AS pool_project_id,
    (existing.pool_project_id IS NULL) AS is_new
  FROM (SELECT DISTINCT match_key FROM legacy_pool_candidates) AS candidate
  LEFT JOIN LATERAL (
    SELECT map.pool_project_id
    FROM project_migration_map AS map
    WHERE map.match_key = candidate.match_key
    ORDER BY map.created_at ASC, map.legacy_project_id ASC
    LIMIT 1
  ) AS existing ON true;

  CREATE TEMP TABLE legacy_pool_masters ON COMMIT DROP AS
  SELECT DISTINCT ON (candidate.match_key)
    candidate.match_key,
    candidate.name,
    candidate.submitter,
    candidate.description,
    candidate.normalized_name,
    candidate.normalized_submitter,
    candidate.created_at,
    target.pool_project_id
  FROM legacy_pool_candidates AS candidate
  INNER JOIN legacy_pool_targets AS target USING (match_key)
  ORDER BY candidate.match_key, candidate.created_at ASC, candidate.legacy_project_id ASC;

  INSERT INTO project_pool (
    id, name, submitter, description, normalized_name, normalized_submitter,
    match_key, status, material_status, created_at, updated_at
  )
  SELECT
    master.pool_project_id,
    master.name,
    master.submitter,
    master.description,
    master.normalized_name,
    master.normalized_submitter,
    master.match_key,
    'materials_pending',
    'incomplete',
    master.created_at,
    now()
  FROM legacy_pool_masters AS master
  INNER JOIN legacy_pool_targets AS target
    ON target.match_key = master.match_key
   AND target.is_new
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO project_migration_map (
    legacy_project_id, pool_project_id, batch_id, match_key
  )
  SELECT
    candidate.legacy_project_id,
    target.pool_project_id,
    backfill_batch_id,
    candidate.match_key
  FROM legacy_pool_candidates AS candidate
  INNER JOIN legacy_pool_targets AS target USING (match_key)
  ON CONFLICT (legacy_project_id) DO NOTHING;

  INSERT INTO project_migration_map (
    legacy_project_id, pool_project_id, batch_id, match_key
  )
  SELECT
    existing.legacy_project_id,
    existing.pool_project_id,
    backfill_batch_id,
    existing.match_key
  FROM existing_legacy_links AS existing
  ON CONFLICT (legacy_project_id) DO NOTHING;

  -- Link old meeting assignments in place. Scores continue to reference their
  -- original project ids, so no historical score or reviewer data is changed.
  UPDATE projects AS legacy
  SET pool_project_id = map.pool_project_id,
      migration_batch_id = backfill_batch_id
  FROM project_migration_map AS map
  WHERE legacy.id = map.legacy_project_id
    AND EXISTS (
      SELECT 1
      FROM legacy_pool_candidates AS candidate
      WHERE candidate.legacy_project_id = legacy.id
    );

  -- Populate both round checklists only when a row does not already exist.
  -- Existing submitted/exempt/missing notes and timestamps are preserved.
  INSERT INTO project_materials (
    project_id, item_key, round_no, required, status, note, updated_at
  )
  SELECT
    target.pool_project_id,
    material.item_key,
    material.round_no,
    material.required,
    'missing',
    '',
    now()
  FROM project_pool AS target
  CROSS JOIN (VALUES
    (1::smallint, 'basic_info', true),
    (1::smallint, 'positioning', true),
    (1::smallint, 'gameplay_plan', true),
    (1::smallint, 'mvp_plan', true),
    (1::smallint, 'competitors', false),
    (2::smallint, 'basic_info', true),
    (2::smallint, 'risk_statement', true),
    (2::smallint, 'mvp_version', true),
    (2::smallint, 'initial_plan', true),
    (2::smallint, 'mvp_description', true),
    (2::smallint, 'virtual_team', false),
    (2::smallint, 'business_model', false),
    (2::smallint, 'resource_needs', false),
    (2::smallint, 'competitors', false)
  ) AS material(round_no, item_key, required)
  ON CONFLICT (project_id, round_no, item_key) DO NOTHING;

  GET DIAGNOSTICS material_rows_created = ROW_COUNT;

  -- Keep the denormalized pool material status aligned with the canonical
  -- checklist for the project's current round.
  UPDATE project_pool AS pool
  SET material_status = CASE WHEN EXISTS (
    SELECT 1
    FROM project_materials AS material
    WHERE material.project_id = pool.id
      AND material.round_no = CASE WHEN pool.current_round = 2 THEN 2 ELSE 1 END
      AND (
        (coalesce(pool.current_round, 1) = 1
          AND material.item_key IN ('basic_info', 'positioning', 'gameplay_plan', 'mvp_plan'))
        OR
        (pool.current_round = 2
          AND material.item_key IN ('basic_info', 'risk_statement', 'mvp_version', 'initial_plan', 'mvp_description'))
      )
      AND material.status NOT IN ('submitted', 'exempt')
  ) THEN 'incomplete' ELSE 'complete' END,
      updated_at = now()
  WHERE pool.archived_at IS NULL;

  INSERT INTO project_status_history (
    project_id, event_type, from_status, to_status, operator_code, note
  )
  SELECT
    master.pool_project_id,
    'legacy_project_backfilled',
    NULL,
    'materials_pending',
    'migration',
    '从旧评审数据回填项目池'
  FROM legacy_pool_masters AS master
  INNER JOIN legacy_pool_targets AS target
    ON target.match_key = master.match_key
   AND target.is_new;

  SELECT count(*) FILTER (WHERE is_new) INTO pool_count FROM legacy_pool_targets;
  UPDATE project_migration_batches
  SET status = 'completed',
      result = jsonb_build_object(
        'legacy_projects_processed', candidate_count + existing_link_count,
        'pool_projects_created', pool_count,
        'material_rows_created', material_rows_created,
        'materials_preserved', true,
        'scores_preserved', true
      ),
      completed_at = now()
  WHERE id = backfill_batch_id;

  RAISE NOTICE 'project pool repair: processed % legacy projects, created % pool projects, added % material rows',
    candidate_count + existing_link_count,
    pool_count,
    material_rows_created;
END
$project_pool_backfill$;
