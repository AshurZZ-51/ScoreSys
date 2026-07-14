# Task 2 Report: Project Pool, Archive, and Purge APIs

## Status

Completed and committed after the verification steps listed below. No Supabase migration was executed.

## Implemented Scope

- Extended `GET /api/project-pool` with `active`, `archived`, and `purge_pending` scopes plus optional `month=YYYY-MM` filtering.
  - Active projects exclude soft-archived rows.
  - Archived projects exclude non-restored deletion requests.
  - Purge-pending projects are archived, unrestored, and have `purge_after` in the future.
  - Each returned project includes `material_progress` and `completed_review_count`.
- Walker-only review completion derives from Walker (`W`) `__verdict__` scores and accepts only `approved`, `recheck`, and `rejected`.
- Extended project history responses with `completed_reviews`, while retaining all assignments for the meeting workspace.
- Added `POST /api/project-pool/batch` for admin-only batch status changes and soft archives.
  - Status and archive writes create one `project_status_history` record per project.
  - Optional `reason` is recorded as the audit note.
- Added `POST /api/project-pool/archive`.
  - Administrators can restore an archived project when it has no active purge request.
  - Only `admin51` can request or restore a purge request.
  - Purge requests require an archived project and use an exact 15-day recovery window.
- Added protected `POST /api/project-pool/purge` cleanup.
  - Only `admin51` can invoke it.
  - It selects only due, unrestored purge requests and deletes linked `scores`, then linked `projects`, then `project_pool` master rows.
  - It does not delete meetings.
- Kept the existing single-project archive operation as a soft archive and made its status-history insert fail loudly on audit-write errors.
- Removed an unreachable duplicate block from the existing single-project archive route.

## TDD Evidence

1. Added tests for an exact 15-day purge window and Walker-only completion counting.
2. Ran `node --test lib/adminLifecycle.test.cjs` before implementation.
   - Expected red result observed: `getPurgeAfter is not a function` and `countCompletedReviews is not a function`.
3. Implemented the minimal lifecycle helpers and reran the lifecycle suite green.
4. The final full suite passed with 33 tests.

## Verification

- `git diff --check` passed.
- `node --test` across all `lib/*.test.cjs`: 33 passed, 0 failed.
- `next build` completed successfully with type checking.

## Concerns

- The repository has no route-level Supabase mock/test harness, so API behavior was type-checked and exercised through the new pure lifecycle tests rather than an integration database.
- The local environment had no Node or npm on PATH. Verification used an official temporary Node 20.20.2 runtime outside the repository. The build emitted the existing Supabase warning that Node 20 will be deprecated by the SDK; it did not affect this build, but future CI/runtime should use Node 22 or later.
- The Task 1 migration was intentionally not run against Supabase, per the task requirement. These APIs therefore require the already-planned `project_deletion_requests` table when deployed.

## Review-Fix Wave: Session Authorization and Atomic Lifecycle Writes

### Fixes

- Added a signed, HttpOnly `scoresys_admin_session` cookie for authenticated administrator logins. Project-pool lifecycle writers now derive `operator_code` from that verified server-side session and ignore request-body/query operator values.
- Limited purge request, purge restoration, and due-purge cleanup to the authenticated `admin51` session.
- Added `apply_project_pool_mutations` in `MIGRATION_ADMIN_LIFECYCLE_V3.sql`. Batch status/archive writes, the single status endpoint, and the single-project archive endpoint use this transactional RPC so the project change and its `project_status_history` audit row commit together or roll back together.
- Replaced the purge endpoint's multi-request delete chain with `purge_due_project_deletions`. The RPC locks due deletion requests and their project rows with `FOR UPDATE ... SKIP LOCKED`, deletes only related scores/projects/project reports/master rows, and never deletes meetings.

### Focused Tests and Results

- `node --test lib/adminSession.test.cjs lib/adminLifecycleSqlContract.test.cjs`: 4 passed, 0 failed. Covers token tampering/expiry/non-admin rejection, `admin51` authorization, and required SQL RPC/lock/delete contract.
- Full Node suite: 37 passed, 1 failed in a concurrently added `project drawer overlay` test because its target component is not present in this worktree. This change does not include that test or component.
- `next build` compiled source but stopped in type checking at concurrent `app/admin/components/ProjectPoolTable.tsx` Set iteration code. This security wave does not modify that UI file.

### Migration Requirement

`MIGRATION_ADMIN_LIFECYCLE_V3.sql` was not executed against Supabase. Deploy the migration manually before deploying these API changes, and configure a strong `ADMIN_SESSION_SECRET` in the deployment environment.
