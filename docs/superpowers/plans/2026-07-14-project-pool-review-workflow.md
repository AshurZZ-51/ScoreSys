# ScoreSys 项目池与跨评审会工作流 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 ScoreSys 改造成以项目池为主档、由评审会承载单轮评审的两轮立项评审系统，并保留旧版会议与评分的只读兼容。

**Architecture:** 增加 `project_pool` 作为项目主档，现有 `projects` 保留为一次会议内的评审快照，通过 `pool_project_id` 关联。项目池、资料项、状态历史和会议评委快照由独立 API 提供；现有评分和汇总接口根据 `scoring_version` 选择旧版或两轮规则。新版后台以五个视图组织，功能开关开启后替换原会议中心入口。

**Tech Stack:** Next.js 14 App Router、React 18、TypeScript、Supabase PostgREST、Node test runner。

## Global Constraints

- 新版创新性档位固定为 `10/16/24/30/40`，评分时不接受旧档位写入。
- 每位评委每次评分、文本输入、加分和结论保存后必须显示成功或失败反馈。
- 第一轮仅显示游戏性、创新性；第二轮仅显示项目规划、技术&美术、风险预估；各轮独立满分 100。
- 两轮均有至多一次重评，第二次尝试只允许通过或驳回。
- 五名会议评委均参与当轮全部维度，会议容量最多 12 个有效项目。
- 历史 `legacy_v1` 数据不改写、不强制归轮、仍按 30/20/20/15/15 规则读取。
- `PROJECT_POOL_V2_ENABLED=true` 才切换项目池后台和新写入路径；关闭时旧后台仍可用。
- 不物理删除存在评审历史的项目；人工状态/结论更正必须追加历史。

---

## File Structure

- `MIGRATION_PROJECT_POOL_V2.sql`：仅新增表、字段、约束、索引和数据库函数。
- `lib/projectPoolWorkflow.js`：资料清单、标准化匹配、状态机、安排资格和结果池派生的纯业务规则。
- `lib/legacyScoring.js`：旧版评分键与五维评分兼容计算。
- `lib/projectPoolMigration.js`：从历史 `projects` 创建幂等主档映射的纯转换逻辑。
- `app/api/project-pool/**`：项目主档、资料项、历史和人工调整 API。
- `app/api/meeting-assignments/route.ts`：安全安排/移除 V2 评审记录。
- `app/api/results/route.ts`：项目池结果派生接口。
- `app/api/summary/route.ts`、`app/api/scores/route.ts`：V2/历史双读、结论流转与即时汇总。
- `app/admin/page.tsx`、`app/admin/components/*`：待评审、评审会、结论报告、已评审、结果池五个后台视图。
- `app/scoring/page.tsx`：按会议评审记录识别轮次，保留保存反馈并限制 Walker 结论。
- `scripts/migrate-project-pool.mjs`：可重复执行的历史映射迁移与校验报告。

### Task 1: 数据库结构与功能开关

**Files:**
- Create: `MIGRATION_PROJECT_POOL_V2.sql`
- Modify: `.env.example`
- Test: `lib/projectPoolWorkflow.test.cjs`

**Interfaces:**
- Produces tables `project_pool`, `project_materials`, `project_status_history`, `meeting_reviewers`, `project_migration_batches`, `project_migration_map`.
- Adds nullable `projects.pool_project_id`, `round_no`, `attempt_no`, `scoring_version`, `assignment_status`, `migration_batch_id`, and `meetings.workflow_version`.
- Produces SQL RPC `assign_pool_project_to_meeting(p_project_id uuid, p_meeting_id uuid, p_round_no smallint, p_operator_code text)`.

- [ ] **Step 1: Write failing workflow constants test**

```js
assert.equal(workflow.PROJECT_POOL_FEATURE_FLAG, 'PROJECT_POOL_V2_ENABLED');
assert.equal(workflow.MAX_MEETING_ASSIGNMENTS, 12);
assert.equal(workflow.MATERIAL_ITEMS.filter((item) => item.required).length, 5);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- --test-name-pattern="project pool constants"`
Expected: FAIL because `projectPoolWorkflow.js` does not exist.

- [ ] **Step 3: Write additive migration and minimum constants**

```sql
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS workflow_version TEXT NOT NULL DEFAULT 'legacy_v1';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS pool_project_id UUID REFERENCES project_pool(id);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS round_no SMALLINT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS attempt_no SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS scoring_version TEXT NOT NULL DEFAULT 'legacy_v1';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS assignment_status TEXT;
```

Create all new tables before foreign-key additions, add partial unique indexes for meeting/project and project/round/attempt, and make the SQL function reject missing materials, invalid status, duplicates, and a thirteenth assignment.

- [ ] **Step 4: Run unit tests**

Run: `pnpm test`
Expected: PASS including project pool constants.

- [ ] **Step 5: Commit**

```bash
git add MIGRATION_PROJECT_POOL_V2.sql .env.example lib/projectPoolWorkflow.*
git commit -m "feat: add project pool schema"
```

### Task 2: 可测试的项目池领域规则

**Files:**
- Create: `lib/projectPoolWorkflow.js`
- Create: `lib/projectPoolWorkflow.test.cjs`
- Create: `lib/projectPoolMigration.js`
- Create: `lib/projectPoolMigration.test.cjs`

**Interfaces:**
- Produces `normalizeProjectPart(value)`, `makeMatchKey(name, submitter)`, `getMaterialStatus(materials)`, `getAssignmentRequest(project)`, `validateAssignment(project, meetingAssignments, roundNo)`, `transitionForVerdict(roundNo, attemptNo, verdict)`, and `resultBucket(project)`.
- Produces `groupLegacyProjects(rows)` returning `{ masters, mappings, mergedGroupCount }`.

- [ ] **Step 1: Write failing state-machine tests**

```js
assert.deepEqual(workflow.validateAssignment(readyR1, [], 1), { ok: true, attemptNo: 1 });
assert.match(workflow.validateAssignment(incomplete, [], 1).error, /必填资料/);
assert.deepEqual(workflow.transitionForVerdict(1, 1, 'recheck'), {
  status: 'r1_recheck_ready', currentRound: 1, currentAttempt: 2, verdict: 'recheck'
});
assert.equal(workflow.transitionForVerdict(2, 2, 'recheck').ok, false);
```

- [ ] **Step 2: Run focused tests to verify failure**

Run: `pnpm test -- --test-name-pattern="assignment|verdict|legacy grouping"`
Expected: FAIL because exports are missing.

- [ ] **Step 3: Implement the pure rules**

Use explicit statuses `draft`, `materials_pending`, `ready_r1`, `scheduled_r1`, `r1_scoring`, `r1_recheck_ready`, `ready_r2`, `scheduled_r2`, `r2_scoring`, `r2_recheck_ready`, `initiation`, `rejected`. Require all five required material statuses to equal `approved`. Normalize name and submitter with NFKC, trim, collapse whitespace and lowercase. Group legacy records only by exact `match_key`.

- [ ] **Step 4: Add migration idempotence tests**

```js
const first = migration.groupLegacyProjects(rows);
const second = migration.groupLegacyProjects(rows);
assert.equal(first.masters.length, second.masters.length);
assert.equal(first.mappings.length, rows.length);
assert.equal(first.mergedGroupCount, 1);
```

- [ ] **Step 5: Run all unit tests**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/projectPoolWorkflow.* lib/projectPoolMigration.*
git commit -m "feat: add project pool workflow rules"
```

### Task 3: 历史评分兼容与会议评分汇总

**Files:**
- Create: `lib/legacyScoring.js`
- Create: `lib/legacyScoring.test.cjs`
- Modify: `lib/scoringRules.js`
- Modify: `app/api/summary/route.ts`

**Interfaces:**
- Produces `computeLegacyProjectScore(scores)` returning `{ dimTotals, baseScore, totalScore, totalMaxScore: 100 }`.
- Produces `computeSummaryForProject(project, scores, reviewers)` selecting legacy or V2 by `project.scoring_version`.

- [ ] **Step 1: Write failing legacy precedence test**

```js
const result = legacy.computeLegacyProjectScore([
  { dim_name: '可玩性::core_gameplay', score: 10 },
  { dim_name: '可玩性', score: 30 }
]);
assert.equal(result.dimTotals['可玩性'].score, 7.5);
assert.equal(result.totalMaxScore, 100);
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm test -- --test-name-pattern="legacy precedence"`
Expected: FAIL because the compatibility module does not exist.

- [ ] **Step 3: Implement legacy rules and summary selector**

Keep old innovation levels `4/6/10/14/20` in `legacyScoring.js`; do not use the new 40-point level mapping for `legacy_v1`. Where old subitems exist, compute their average times the old dimension multiplier; otherwise use the old dimension total. Do not sum both.

- [ ] **Step 4: Add V2 regression tests**

```js
assert.equal(rules.computeRoundProjectScore('r1', r1Scores).totalMaxScore, 100);
assert.equal(rules.isValidScoreValue('r1::创新性::level', 16), true);
assert.equal(rules.isValidScoreValue('r1::创新性::level', 12), false);
```

- [ ] **Step 5: Run all unit tests**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/legacyScoring.* lib/scoringRules.js app/api/summary/route.ts
git commit -m "feat: preserve legacy scoring in summaries"
```

### Task 4: 项目池与资料 API

**Files:**
- Create: `app/api/project-pool/route.ts`
- Create: `app/api/project-pool/[id]/materials/route.ts`
- Create: `app/api/project-pool/[id]/history/route.ts`
- Create: `app/api/project-pool/[id]/status/route.ts`
- Modify: `lib/supabase.ts`

**Interfaces:**
- `GET /api/project-pool?scope=pending|reviewed` returns `{ projects }` with materials and assignments.
- `POST /api/project-pool` accepts `{ name, submitter, description, operator_code }` and seeds eight material rows.
- `PATCH /api/project-pool/:id/materials` accepts `{ item_key, status, note, operator_code }` and recalculates `material_status`.
- `POST /api/project-pool/:id/status` accepts `{ status, note, operator_code, confirmed }`; requires `confirmed=true` for manual changes.

- [ ] **Step 1: Write route helper tests first**

```js
assert.equal(workflow.getMaterialStatus(requiredApproved).value, 'complete');
assert.equal(workflow.getMaterialStatus(oneRequiredMissing).value, 'incomplete');
```

- [ ] **Step 2: Run targeted tests**

Run: `pnpm test -- --test-name-pattern="material status"`
Expected: PASS after Task 2; use it as a regression gate before API wiring.

- [ ] **Step 3: Implement feature-flag and admin checks**

Add `isProjectPoolV2Enabled()` in `lib/supabase.ts` and return `404` from V2 write routes when it is false. Query `reviewers.is_admin` by `operator_code` before every pool/material/status write. Insert a `project_status_history` row in the same ordered mutation flow for every create, material recalculation, or manual status change.

- [ ] **Step 4: Verify via build and route typecheck**

Run: `NEXT_STANDALONE=false pnpm run build`
Expected: compilation and type checking complete with exit code 0.

- [ ] **Step 5: Commit**

```bash
git add app/api/project-pool lib/supabase.ts
git commit -m "feat: add project pool APIs"
```

### Task 5: 安排入会、评委快照与 Walker 结论流转

**Files:**
- Create: `app/api/meeting-assignments/route.ts`
- Create: `app/api/results/route.ts`
- Modify: `app/api/meetings/route.ts`
- Modify: `app/api/projects/route.ts`
- Modify: `app/api/scores/route.ts`

**Interfaces:**
- `POST /api/meeting-assignments` accepts `{ meeting_id, pool_project_id, round_no, operator_code }` and returns `{ assignment }`.
- `DELETE /api/meeting-assignments?id=&operator_code=` removes only an unscored V2 assignment.
- `GET /api/results?bucket=approved|recheck|rejected` returns derived projects.
- `POST /api/scores` writes a verdict and then updates the assigned project, pool project and status history.

- [ ] **Step 1: Write failing workflow tests for capacity and retry**

```js
assert.match(workflow.validateAssignment(readyR1, Array(12).fill({}), 1).error, /已满/);
assert.match(workflow.validateAssignment(r1Approved, [], 1).error, /轮次/);
assert.equal(workflow.validateAssignment(r1RecheckReady, [], 1).attemptNo, 2);
```

- [ ] **Step 2: Run focused tests**

Run: `pnpm test -- --test-name-pattern="capacity|retry"`
Expected: PASS after extending Task 2 rules.

- [ ] **Step 3: Implement V2 meeting creation and assignment**

When the feature flag is enabled, create meetings with `workflow_version='two_round_v2'`, do not create template projects, snapshot all non-admin reviewers to `meeting_reviewers`, and allocate the lowest unused `seq_no`. For legacy meetings retain existing template behavior. Prefer `assign_pool_project_to_meeting` RPC; map database error text to Chinese business errors.

- [ ] **Step 4: Implement verdict safeguards**

Only Walker may set a V2 verdict. Verify the reviewer is in `meeting_reviewers`, derive the assignment's `round_no` and `attempt_no` from `projects`, reject `recheck` for attempt 2, then append the pool status history after updating assignment and pool status. Do not let admin overwrite a Walker verdict through `/api/scores`; admin corrections use the confirmed project-pool status endpoint.

- [ ] **Step 5: Run tests and build**

Run: `pnpm test; $env:NEXT_STANDALONE='false'; pnpm run build`
Expected: all tests pass and build exits 0.

- [ ] **Step 6: Commit**

```bash
git add app/api/meeting-assignments app/api/results app/api/meetings/route.ts app/api/projects/route.ts app/api/scores/route.ts
git commit -m "feat: schedule project pool reviews"
```

### Task 6: 后台五个项目池视图

**Files:**
- Create: `app/admin/components/ProjectPoolView.tsx`
- Create: `app/admin/components/MeetingManagementView.tsx`
- Create: `app/admin/components/ReportsView.tsx`
- Create: `app/admin/components/ReviewedProjectsView.tsx`
- Create: `app/admin/components/ResultsPoolView.tsx`
- Modify: `app/admin/page.tsx`
- Modify: `app/report/ReportClient.tsx`

**Interfaces:**
- `ProjectPoolView` receives `onRefresh()` and lists only `draft/materials_pending/ready_r1/r1_recheck_ready/ready_r2/r2_recheck_ready` projects.
- `MeetingManagementView` manages V2 meetings and calls `/api/meeting-assignments`.
- `ReportsView` selects a meeting and renders separate round rankings, score percentages, verdict, problems and actions.
- `ReviewedProjectsView` renders each pool project once with chronological assignments/history.
- `ResultsPoolView` has approved/recheck/rejected tabs and links back to project detail.

- [ ] **Step 1: Add a V2 view selection testable helper**

```js
assert.deepEqual(workflow.getAdminViews(), [
  'pending', 'meetings', 'reports', 'reviewed', 'results'
]);
```

- [ ] **Step 2: Run unit test**

Run: `pnpm test -- --test-name-pattern="admin views"`
Expected: FAIL until the helper is added, then PASS.

- [ ] **Step 3: Build components with scoped responsibilities**

Make the project pool the default V2 tab. In the pool view, permit project creation, editing, required-material approval and schedule selection only when complete. In meetings, show `已安排 X/12`, the round and attempt per assignment, and prohibit removal once normal scores exist. In reviewed projects show original reviewer problems/actions read-only plus administrator consolidated notes editable per assignment. In reports, remove inaccurate “几人评” wording and show only the percentage plus actual score/max score.

- [ ] **Step 4: Wire feature-flag fallback**

Keep the current administrative meeting dashboard available only if `NEXT_PUBLIC_PROJECT_POOL_V2_ENABLED` is not true. With it true, render the five-tab V2 interface; do not fetch V2 routes before the flag is enabled.

- [ ] **Step 5: Run build**

Run: `NEXT_STANDALONE=false pnpm run build`
Expected: all app routes compile successfully.

- [ ] **Step 6: Commit**

```bash
git add app/admin app/report lib/projectPoolWorkflow.*
git commit -m "feat: add project pool admin workspace"
```

### Task 7: 评委评分页与保存反馈

**Files:**
- Modify: `app/scoring/page.tsx`
- Modify: `lib/saveFeedback.js`
- Modify: `lib/saveFeedback.test.cjs`

**Interfaces:**
- `saveScore()` invokes `showSaveFeedback('saving', label)`, persists, then shows success/error for every scoring input, text field, bonus and verdict.
- V2 project cards consume `round_no`, `attempt_no`, `scoring_version` and render only current-round dimensions.

- [ ] **Step 1: Extend failing save-feedback test**

```js
assert.deepEqual(createSaveFeedback('success', '存在问题'), {
  tone: 'success', text: '存在问题已保存'
});
```

- [ ] **Step 2: Run test to verify present behavior**

Run: `pnpm test -- --test-name-pattern="save feedback"`
Expected: PASS for generic labels; add a rendering test/helper only if the UI call path is not covered.

- [ ] **Step 3: Make V2 scoring assignment-aware**

Use the meeting assignment's `round_no` rather than global meeting state. Hide unrelated dimensions, restrict innovation to `10/16/24/30/40`, render `重评` only for attempt 1, and retain Walker bonus/verdict at the bottom. For numeric fields retain empty draft text while editing; parse and save on blur/change without coercing an empty input to a maximum score.

- [ ] **Step 4: Verify unit tests and build**

Run: `pnpm test; $env:NEXT_STANDALONE='false'; pnpm run build`
Expected: PASS and exit code 0.

- [ ] **Step 5: Commit**

```bash
git add app/scoring/page.tsx lib/saveFeedback.*
git commit -m "feat: score scheduled review rounds"
```

### Task 8: 历史迁移、部署与验收

**Files:**
- Create: `scripts/migrate-project-pool.mjs`
- Create: `scripts/verify-project-pool-migration.mjs`
- Modify: `README.md`

**Interfaces:**
- `node scripts/migrate-project-pool.mjs --dry-run` prints `{ legacyProjects, masters, mappings, mergedGroups, orphanScores }`.
- `node scripts/migrate-project-pool.mjs --apply --operator=walker` creates one batch and is idempotent.
- `node scripts/verify-project-pool-migration.mjs` verifies counts, mapping uniqueness and zero orphan scores.

- [ ] **Step 1: Write dry-run grouping tests**

```js
assert.equal(groupLegacyProjects(fixtureRows).masters.length, 35);
assert.equal(groupLegacyProjects(fixtureRows).mappings.length, 42);
```

- [ ] **Step 2: Run migration unit tests**

Run: `pnpm test -- --test-name-pattern="legacy grouping"`
Expected: PASS.

- [ ] **Step 3: Implement scripts and run dry-run**

Use the service key from `.env.local`, never print it, and reject `--apply` unless the expected counts match the dry-run. Create a timestamped JSON report under `D:/PM-Daily/ScoreSys-backups/` before any apply.

- [ ] **Step 4: Apply production migration in staged order**

1. Back up database rows to `D:/PM-Daily/ScoreSys-backups/` and compute SHA256.
2. Run `MIGRATION_PROJECT_POOL_V2.sql` through Supabase SQL access.
3. Deploy code with flags disabled and run `--dry-run`.
4. Run `--apply`, then verification.
5. Set `PROJECT_POOL_V2_ENABLED=true` and `NEXT_PUBLIC_PROJECT_POOL_V2_ENABLED=true` for Vercel Preview, deploy, and test one R1/R2 flow.
6. Promote flags to Production only after the preview walkthrough succeeds.

- [ ] **Step 5: Run final verification**

Run: `pnpm test; $env:NEXT_STANDALONE='false'; pnpm run build; node scripts/verify-project-pool-migration.mjs`
Expected: test suite passes, build exits 0, migration report has no orphan scores and expected mapping counts.

- [ ] **Step 6: Commit and publish**

```bash
git add scripts README.md
git commit -m "feat: migrate project pool workflow"
git push origin codex/score-feedback-preview
```

## Self-Review

- Spec coverage: Tasks 1-2 cover schema, materials, status machine, migration matching and retry rules; Task 3 protects legacy scoring; Tasks 4-5 implement server-side operations; Tasks 6-7 implement all admin/reviewer views and feedback; Task 8 covers migration, feature flags, deploy and rollback-safe verification.
- Placeholder scan: no implementation step delegates unspecified behavior; database access is named explicitly and each workflow condition is defined.
- Type consistency: `pool_project_id`, `round_no`, `attempt_no`, `scoring_version`, `assignment_status`, `operator_code`, and `PROJECT_POOL_V2_ENABLED` are used consistently across tasks.
