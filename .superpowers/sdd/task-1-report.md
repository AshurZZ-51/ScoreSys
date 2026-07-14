# Task 1 Implementation Report

## Scope

Implemented the confirmed Task 1 admin lifecycle foundations in commit `7d5d25d` (`feat: add admin lifecycle v3 foundations`). No account API or UI was added, and the Supabase migration was not executed.

## Changed Files

- `MIGRATION_ADMIN_LIFECYCLE_V3.sql`
  - Migrates legacy material statuses `approved` -> `submitted` and `needs_revision` -> `needs_completion`.
  - Constrains `project_materials.status` to `missing`, `needs_completion`, `submitted`, and `exempt`.
  - Adds `project_deletion_requests` and `report_snapshots` using the confirmed design schema.
  - Adds `account_audit_logs` with the Task 6 support schema.
  - Replaces `assign_pool_project_to_meeting` without the material-complete rejection while retaining project existence, round/attempt, capacity, and assignment validation.
- `lib/adminLifecycle.js`
  - Adds pure `isCompletedReview`, `sortMeetingsForAdmin`, and `deriveProjectDeletionState` helpers.
- `lib/adminLifecycle.test.cjs`
  - Covers Walker completion verdicts, non-mutating meeting ordering, and deletion lifecycle states.
- `lib/projectPoolWorkflow.js`
  - Treats required materials as complete only when every required item is `submitted` or `exempt`.
  - Counts both complete statuses in the existing progress result shape.
  - Removes only the material-complete assignment rejection.
- `lib/projectPoolWorkflow.test.cjs`
  - Updates material and assignment expectations and adds optional-material coverage.

## TDD Evidence

The first focused test run was intentionally RED:

- `adminLifecycle.test.cjs` failed because `lib/adminLifecycle.js` did not exist.
- Material completeness failed because production code still required `approved`.
- Material progress failed because `submitted` was not counted.
- Assignment validation failed because incomplete materials were still rejected.

After the minimal implementation, the focused run passed with `12` tests and `0` failures.

## Tests Run

Focused suite:

```text
node --test lib/adminLifecycle.test.cjs lib/projectPoolWorkflow.test.cjs
12 tests, 12 pass, 0 fail
```

Full required suite:

```text
$env:PATH='C:\Users\Ashur\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:PATH; pnpm test
29 tests, 29 pass, 0 fail
```

The runtime directory was prepended because `node` is not otherwise available on the shell PATH. `git diff --check` also completed without whitespace errors.

## Self-Review

- Confirmed only the four specified material statuses are accepted by the new constraint.
- Confirmed legacy status mappings occur before the new constraint is added.
- Confirmed optional materials are excluded from completeness decisions.
- Confirmed current meetings sort first and the input meeting array is not mutated.
- Confirmed deletion state precedence is restored -> `archived`, before purge deadline -> `purge_pending`, and at/after deadline -> `purged`.
- Confirmed the old `MIGRATION_PROJECT_POOL_V2.sql` file was not modified; the database function replacement is contained in the owned V3 migration.
- Confirmed no account API or UI files were changed.

## Concerns

- The migration was intentionally not run against Supabase, so SQL execution and compatibility with the live database remain deployment-time concerns.
- The repository shell environment does not expose `node` by default; test commands require the bundled runtime path shown above.
- The existing progress return property remains named `approved` for compatibility with current callers, although it counts `submitted` and `exempt` statuses.
