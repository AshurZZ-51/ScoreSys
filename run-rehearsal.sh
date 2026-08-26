#!/usr/bin/env bash
set -euo pipefail
cfg=/tmp/docker-config-scoringsys-t9; mkdir -p "$cfg"; printf '%s' '{"auths":{}}' > "$cfg/config.json"; export DOCKER_CONFIG="$cfg"
name=scoringsys-t9-pg; img=docker.m.daocloud.io/library/postgres:16-alpine
cleanup(){ docker rm -f "$name" >/dev/null 2>&1 || true; rm -f /tmp/t9-import.sql /tmp/t9-refuse.sql; }
trap cleanup EXIT
docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" -e POSTGRES_PASSWORD=testpass -e POSTGRES_DB=postgres -v "$PWD:/workspace:ro" "$img" >/dev/null
for i in $(seq 1 60); do docker exec "$name" pg_isready -U postgres -d postgres >/dev/null 2>&1 && break; sleep 1; done
docker exec "$name" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -v migrator_pw=migratepass -v app_pw=apppass -v database_name=scoringsys -f /workspace/scripts/db/bootstrap.sql
docker exec "$name" sh -lc 'for f in /workspace/db/migrations/0000_baseline_schema.sql /workspace/MIGRATION.sql /workspace/MIGRATION_PROJECT_POOL_V2.sql /workspace/MIGRATION_ADMIN_LIFECYCLE_V3.sql /workspace/MIGRATION_WORKFLOW_FIX_V4.sql /workspace/MIGRATION_INITIATION_V4.sql /workspace/MIGRATION_REVIEWER_BLIND_RATING_V1.sql /workspace/db/migrations/0007_grants.sql; do echo migrate:$f; PGPASSWORD=migratepass psql -X -v ON_ERROR_STOP=1 --single-transaction -U scoringsys_migrator -d scoringsys -f "$f"; done'
node --input-type=module - <<'JS' > /tmp/t9-import.sql
import fs from 'node:fs'; import {buildImportSql} from './scripts/db/import-snapshot.mjs';
const base='/home/zoey/agent-work/scoringsys-data-2026-08-25_17-21-43/';
process.stdout.write(buildImportSql(JSON.parse(fs.readFileSync(base+'supabase-data-snapshot.json')),JSON.parse(fs.readFileSync(base+'manifest.json')),{force:true}));
JS
docker exec -i "$name" sh -lc 'PGPASSWORD=migratepass psql -X -v ON_ERROR_STOP=1 -U scoringsys_migrator -d scoringsys' < /tmp/t9-import.sql
docker exec "$name" psql -U postgres -d scoringsys -Atqc "select count(*) from information_schema.tables where table_schema='public'; select sum(n) from (select count(*) n from reviewers union all select count(*) from reviewer_dims union all select count(*) from meetings union all select count(*) from projects union all select count(*) from scores union all select count(*) from project_pool union all select count(*) from project_materials union all select count(*) from project_status_history union all select count(*) from meeting_reviewers union all select count(*) from project_migration_batches union all select count(*) from project_migration_map union all select count(*) from project_deletion_requests union all select count(*) from report_snapshots union all select count(*) from account_audit_logs union all select count(*) from project_rating_history union all select count(*) from project_reviewer_ratings) x;"
docker exec "$name" pg_dump -U postgres -Fc -d scoringsys -f /tmp/scoringsys.dump
docker exec "$name" createdb -U postgres scoringsys_verify
docker exec "$name" pg_restore -U postgres -d scoringsys_verify /tmp/scoringsys.dump
docker exec "$name" psql -U postgres -d scoringsys_verify -Atqc 'select count(*) from scores; select count(*) from reviewers;'
node --input-type=module - <<'JS' > /tmp/t9-refuse.sql
import fs from 'node:fs'; import {buildImportSql} from './scripts/db/import-snapshot.mjs'; const base='/home/zoey/agent-work/scoringsys-data-2026-08-25_17-21-43/'; process.stdout.write(buildImportSql(JSON.parse(fs.readFileSync(base+'supabase-data-snapshot.json')),JSON.parse(fs.readFileSync(base+'manifest.json'))));
JS
set +e
docker exec -i "$name" psql -X -v ON_ERROR_STOP=1 -U postgres -d scoringsys < /tmp/t9-refuse.sql >/tmp/t9-refuse.out 2>&1; rc=$?
set -e
printf 'nonempty_refusal_rc=%s\n' "$rc"; [ "$rc" -ne 0 ]
docker exec "$name" psql -U postgres -d scoringsys -Atqc 'select count(*) from scores'
