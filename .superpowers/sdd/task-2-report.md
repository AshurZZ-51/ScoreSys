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
