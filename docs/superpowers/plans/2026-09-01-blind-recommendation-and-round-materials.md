# 盲评推荐结论与分轮资料清单实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在当前验收版本中实现全员盲评、推荐结论、管理员覆盖、特别推荐票和两轮资料检查，并将同一套能力适配到 PostgreSQL 直连主线。

**Architecture:** 继续以 `scores` 保存个人评分、个人结论和新的特殊记录，以 `project_reviewer_ratings` 保存个人项目评级。服务端在 `/api/summary` 统一计算推荐结论、盲评统计和特别推荐票；评委页、管理员实时汇总和打印报告只消费这套聚合结果。`project_materials` 增加 `round_no`，资料定义和完整度按评审项目轮次读取。

**Tech Stack:** Next.js App Router, React 18, TypeScript, PostgreSQL direct access, PostgreSQL-compatible SQL migrations, Node.js built-in test runner.

## Global Constraints

- 功能基线来自 `codex/project-pool-v2`；最终实现保留 PostgreSQL 仓储、事务和部署结构。
- 评委名单只使用现有 `reviewers`/`meeting_reviewers` 中的非管理员账号，保持实际已有 7 名评委；不得新增 Nadia 或其他账号。
- 项目评分完成度继续使用现有正常评分项的分子、分母和四舍五入规则。
- Walker 只保留加分权限，不再显示或提交最终结论、最终评级。
- 个人评级、个人结论和特别推荐票不计入评分完成度。
- 资料状态只允许 `missing`、`needs_completion`、`submitted`、`exempt`。
- 报告快照必须从最新汇总生成；管理员覆盖值优先于推荐结论。
- 所有数据库迁移必须可重复执行并兼容旧资料记录，不能假设 `project_materials.id` 存在。

---

### Task 1: 推荐结论、特别推荐票和分轮资料纯函数

**Files:**
- Modify: `lib/reviewerBlindReview.js`
- Modify: `lib/reviewerBlindReview.test.cjs`
- Modify: `lib/projectPoolWorkflow.js`
- Modify: `lib/projectPoolWorkflow.test.cjs`
- Modify: `lib/reviewerRoster.js`
- Modify: `lib/reviewerRoster.test.cjs`

**Interfaces:**
- Produces `recommendBlindVerdict(values)` returning `{ verdict, submittedCount, counts, percentages }`.
- Produces `getMaterialItemsForRound(roundNo)` and `getMaterialProgressForRound(materials, roundNo)`.
- Produces `SPECIAL_VOTE_DIMENSION = '__special_vote__'` and `ADMIN_VERDICT_DIMENSION = '__admin_verdict__'` constants or equivalent exported names.
- `buildMeetingReviewerSnapshot` remains the source of meeting reviewer membership and never creates a reviewer.

- [ ] **Step 1: Write failing tests for recommendation rules.**

```js
test('recommends from submitted verdicts and ignores absent reviewers', () => {
  assert.equal(recommendBlindVerdict(['approved', 'approved', 'recheck', '']).verdict, 'approved');
  assert.equal(recommendBlindVerdict(['approved', 'recheck']).verdict, 'recheck');
  assert.equal(recommendBlindVerdict(['approved', 'rejected']).verdict, 'rejected');
  assert.equal(recommendBlindVerdict(['recheck', 'rejected', '']).verdict, 'recheck');
  assert.equal(recommendBlindVerdict([]).verdict, null);
});

test('recommendation percentages use only submitted verdicts', () => {
  assert.deepEqual(recommendBlindVerdict(['approved', 'rejected', '']).percentages, {
    approved: 50, recheck: 0, rejected: 50
  });
});
```

- [ ] **Step 2: Run the focused test and confirm it fails because the helper is absent.**

Run: `node --test lib/reviewerBlindReview.test.cjs`

Expected: FAIL with an assertion or missing export for `recommendBlindVerdict`.

- [ ] **Step 3: Write failing tests for the two material checklists and reviewer roster behavior.**

```js
test('round one and round two use different material definitions', () => {
  assert.deepEqual(getMaterialItemsForRound(1).filter((item) => item.required).map((item) => item.item_key), [
    'basic_info', 'positioning', 'gameplay_plan', 'mvp_plan'
  ]);
  assert.deepEqual(getMaterialItemsForRound(2).filter((item) => item.required).map((item) => item.item_key), [
    'basic_info', 'risk_statement', 'mvp_version', 'initial_plan', 'mvp_description'
  ]);
});

test('meeting snapshot preserves database reviewers without injecting Nadia', () => {
  const rows = buildMeetingReviewerSnapshot([
    { code: 'W', name: 'Walker', is_admin: false },
    { code: 'J', name: 'Jarvis', is_admin: false },
    { code: 'G', name: 'Gouki', is_admin: false },
    { code: 'o', name: 'Ollie', is_admin: false },
    { code: 'si', name: 'Simon', is_admin: false },
    { code: 'R4', name: 'Existing Reviewer 4', is_admin: false },
    { code: 'R5', name: 'Existing Reviewer 5', is_admin: false },
    { code: 'admin51', name: 'Admin', is_admin: true }
  ]);
  assert.equal(rows.length, 7);
  assert.equal(rows.some((row) => row.reviewer_name === 'Nadia'), false);
});
```

- [ ] **Step 4: Run the focused tests and confirm the material assertions fail against the current single checklist.**

Run: `node --test lib/projectPoolWorkflow.test.cjs lib/reviewerRoster.test.cjs`

Expected: FAIL on the new round-specific material and no-Nadia assertions.

- [ ] **Step 5: Implement the minimal helpers.**

Use the submitted values only for the verdict denominator:

```js
function recommendBlindVerdict(values) {
  const submitted = (values || []).filter((value) => ['approved', 'recheck', 'rejected'].includes(value));
  const counts = { approved: 0, recheck: 0, rejected: 0 };
  submitted.forEach((value) => { counts[value] += 1; });
  const percentages = Object.fromEntries(Object.entries(counts).map(([key, count]) => [
    key, submitted.length ? Math.round(count / submitted.length * 100) : 0
  ]));
  let verdict = null;
  if (submitted.length && counts.approved > submitted.length / 2) verdict = 'approved';
  else if (submitted.length) verdict = counts.recheck >= (counts.recheck + counts.rejected) / 2 ? 'recheck' : 'rejected';
  return { verdict, submittedCount: submitted.length, counts, percentages };
}
```

Use the exact attachment-derived definitions in `getMaterialItemsForRound`, and calculate required completion only against the selected round. Keep legacy `project_materials` rows readable but do not display them as new checklist entries.

- [ ] **Step 6: Run the focused tests and confirm they pass.**

Run: `node --test lib/reviewerBlindReview.test.cjs lib/projectPoolWorkflow.test.cjs lib/reviewerRoster.test.cjs`

Expected: PASS, including all existing completion and roster tests that remain valid.

- [ ] **Step 7: Commit the pure-function changes.**

```bash
git add lib/reviewerBlindReview.js lib/reviewerBlindReview.test.cjs lib/projectPoolWorkflow.js lib/projectPoolWorkflow.test.cjs lib/reviewerRoster.js lib/reviewerRoster.test.cjs
git commit -m "feat: add blind verdict recommendations and round materials"
```

### Task 2: Scoring API, project ratings and summary aggregation

**Files:**
- Modify: `lib/scoringRules.js`
- Modify: `lib/scoringRules.test.cjs`
- Modify: `app/api/scores/route.ts`
- Modify: `app/api/project-ratings/route.ts`
- Modify: `app/api/summary/route.ts`
- Modify: `lib/summaryRoute.test.cjs`
- Modify: `lib/reportSnapshots.js`
- Modify: `lib/reportSnapshots.test.cjs`

**Interfaces:**
- `POST /api/scores` accepts current reviewer personal verdicts and `r{1,2}::__special_vote__` values `0` or `1`.
- `POST /api/scores` accepts `r{1,2}::__admin_verdict__` only for an authenticated administrator; an empty comment clears the override.
- Summary projects expose `recommendedVerdict`, `adminVerdict`, `verdict`, `blindVerdictStats`, `specialVotes`, and existing completion fields.
- `reportProject` exposes the resolved `verdict`, blind stats, and special vote details without a Walker-only verdict field.

- [ ] **Step 1: Add failing tests for special score validation and the new summary contract.**

```js
test('special recommendation vote accepts only zero or one', () => {
  assert.equal(rules.getScoreMax('r1::__special_vote__'), 1);
  assert.equal(rules.isValidScoreValue('r1::__special_vote__', 0), true);
  assert.equal(rules.isValidScoreValue('r1::__special_vote__', 1), true);
  assert.equal(rules.isValidScoreValue('r1::__special_vote__', 2), false);
});

test('summary includes Walker in blind verdict statistics without changing completion', async () => {
  // Use the existing summary route harness with W, J and a partial set of r1 scores.
  // Assert blindVerdictStats counts W and J submissions while completionRate remains
  // calculated from normal score keys only.
});
```

- [ ] **Step 2: Run focused tests and confirm failure.**

Run: `node --test lib/scoringRules.test.cjs lib/summaryRoute.test.cjs lib/reportSnapshots.test.cjs`

Expected: FAIL on the missing special vote max and new blind aggregation fields.

- [ ] **Step 3: Implement score-key validation and authorization.**

Add `__special_vote__` and `__admin_verdict__` to special-key handling. Keep normal score validation unchanged. For personal verdicts, require a non-admin reviewer in the meeting snapshot; do not call `transitionForVerdict` and do not mutate the project pool. For administrator verdicts, require an admin session and only accept `approved`, `recheck`, `rejected`, or null.

- [ ] **Step 4: Implement summary aggregation using all non-admin snapshot reviewers.**

Change `blindReviewerCodes` to include Walker and every non-admin reviewer in the meeting snapshot. Keep `expectedInputCountForRound` and the existing normal-score completion numerator/denominator untouched. For each round:

```ts
const blindVerdictStats = recommendBlindVerdict(roundVerdictScores.map((score) => score.comment));
const adminVerdict = latestSpecialComment(specialScoreKey(round.id, '__admin_verdict__')) || null;
const recommendedVerdict = blindVerdictStats.verdict;
const verdict = adminVerdict || recommendedVerdict;
```

Collect active special votes where `dim_name` matches the round key and `Number(score) === 1`, resolving reviewer names from the existing reviewer/snapshot data.

- [ ] **Step 5: Update report payloads to use resolved recommendation/override.**

`reportProject` must set `verdict` from `project.verdict`, include `recommendedVerdict`, `adminVerdict`, `blindVerdictStats`, and `specialVotes`, and stop exporting a Walker-only result. Keep legacy fields only when needed for backward-compatible parsing, but do not render them in new reports.

- [ ] **Step 6: Run all focused tests and fix regressions.**

Run: `node --test lib/scoringRules.test.cjs lib/summaryRoute.test.cjs lib/reportSnapshots.test.cjs`

Expected: PASS; existing tests for normal scoring completion and weighted totals remain green.

- [ ] **Step 7: Commit API and aggregation changes.**

```bash
git add lib/scoringRules.js lib/scoringRules.test.cjs app/api/scores/route.ts app/api/project-ratings/route.ts app/api/summary/route.ts lib/summaryRoute.test.cjs lib/reportSnapshots.js lib/reportSnapshots.test.cjs
git commit -m "feat: aggregate blind verdict recommendations"
```

### Task 3: Round-specific material API and project creation

**Files:**
- Modify: `app/api/project-pool/[id]/materials/route.ts`
- Modify: `app/api/project-pool/route.ts`
- Modify: `app/api/meetings/route.ts`
- Create: `MIGRATION_BLIND_RECOMMENDATION_V2.sql`
- Modify: `lib/projectPoolWorkflow.js`
- Modify: `lib/projectPoolWorkflow.test.cjs`

**Interfaces:**
- `GET /api/project-pool/:id/materials?round_no=1|2` returns the selected checklist and actual saved statuses.
- `PATCH /api/project-pool/:id/materials` accepts `round_no`, `item_key`, `status`, and optional note.
- Project creation initializes both round rows safely, using supplied initial statuses for round one and missing defaults for round two.
- Existing records and old material statuses remain queryable.

- [ ] **Step 1: Add failing route/source contract tests.**

Assert the route reads `round_no`, calls `getMaterialItemsForRound`, writes `round_no` in its upsert payload, and never selects or updates `project_materials.id`. Assert project creation seeds round-aware rows.

- [ ] **Step 2: Run the focused tests and confirm failure.**

Run: `node --test lib/projectPoolWorkflow.test.cjs lib/initiationMigration.test.cjs`

Expected: FAIL because the current route imports one checklist and upserts only `project_id,item_key`.

- [ ] **Step 3: Add an idempotent migration.**

The migration must:

```sql
ALTER TABLE project_materials ADD COLUMN IF NOT EXISTS round_no SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE project_materials DROP CONSTRAINT IF EXISTS project_materials_project_id_item_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS project_materials_project_round_item_key
  ON project_materials(project_id, round_no, item_key);
```

Copy existing rows to the appropriate round-one definitions and create missing round-two rows with `missing`; do not delete old rows. Update `required` based on the two attachment-derived definitions. Keep the four allowed status values and use `ON CONFLICT (project_id, round_no, item_key)` where available.

- [ ] **Step 4: Implement round-aware GET/PATCH and creation initialization.**

For PATCH, validate the selected item against the selected round and derive material completeness from that round only. Return the selected round's rows and progress. In creation, insert rows with explicit `round_no` and preserve the existing status update/history behavior.

- [ ] **Step 5: Run tests and SQL contract checks.**

Run: `node --test lib/projectPoolWorkflow.test.cjs lib/initiationMigration.test.cjs`

Expected: PASS.

- [ ] **Step 6: Commit material API and migration.**

```bash
git add app/api/project-pool/[id]/materials/route.ts app/api/project-pool/route.ts app/api/meetings/route.ts MIGRATION_BLIND_RECOMMENDATION_V2.sql lib/projectPoolWorkflow.js lib/projectPoolWorkflow.test.cjs lib/initiationMigration.test.cjs
git commit -m "feat: add round-specific material checks"
```

### Task 4: Reviewer UI and special recommendation vote

**Files:**
- Modify: `app/scoring/page.tsx`
- Modify: `lib/projectDetailWorkflow.js`
- Modify: `lib/projectDetailWorkflow.test.cjs`

**Interfaces:**
- All non-admin reviewers see the same personal rating and verdict controls.
- Walker sees only the existing bonus panel as an extra control.
- All reviewers see the red special recommendation checkbox at the bottom; toggling it persists `0/1` and shows the existing save feedback.
- Material summary on the scoring page uses the current project round.

- [ ] **Step 1: Add a source contract test for Walker controls.**

Assert the scoring page contains no Walker final verdict or final rating selector and contains a special-vote control with the “半年只有一票” text. Assert the existing completion helper still uses only normal score keys.

- [ ] **Step 2: Run the test and confirm failure against current JSX.**

Run: `node --test lib/projectDetailWorkflow.test.cjs`

Expected: FAIL because the current JSX renders Walker final rating and labels his verdict as final.

- [ ] **Step 3: Update scoring state loading and persistence.**

Load personal verdicts for the logged-in reviewer as before, load special vote state by round, and post `r{round}::__special_vote__` with `score: 1` or `0`. Keep all existing save feedback and debounced numeric score behavior. Do not change `getProjectCompletion` or its expected-count calculation.

- [ ] **Step 4: Replace the bottom verdict section.**

Render a shared `本轮个人评审结论（盲评参考）` section for Walker and all reviewers. Remove the final rating selector and Walker final conclusion wording. Keep Walker bonus immediately before the shared bottom area. Add a prominent red checkbox with an adjacent note “半年只有一票”。

- [ ] **Step 5: Use round-specific materials in the reviewer page.**

Call the materials API with the current `round_no`, use `getMaterialItemsForRound`, and calculate progress using the current round. Do not affect scoring completion.

- [ ] **Step 6: Run tests and build.**

Run: `node --test lib/projectDetailWorkflow.test.cjs lib/projectPoolWorkflow.test.cjs`; `npm run build`

Expected: PASS and a successful Next.js production build.

- [ ] **Step 7: Commit reviewer UI changes.**

```bash
git add app/scoring/page.tsx lib/projectDetailWorkflow.js lib/projectDetailWorkflow.test.cjs
git commit -m "feat: make Walker a blind reviewer and add special vote"
```

### Task 5: Admin recommendation controls, reports and materials UI

**Files:**
- Modify: `app/admin/components/LiveReportPanel.tsx`
- Modify: `app/admin/components/MeetingWorkspace.tsx`
- Modify: `app/admin/V2AdminPage.tsx`
- Modify: `app/admin/components/ProjectDrawer.tsx`
- Modify: `app/report/components/RoundOneReport.tsx`
- Modify: `app/report/components/RoundTwoReport.tsx`
- Modify: `app/report/components/InitiationProjectReport.tsx`
- Modify: `app/report/ReportClient.tsx`

**Interfaces:**
- Admin report/summary UI displays recommendation by default, blind counts/percentages, and special vote names.
- Admin can select “跟随推荐” or manually override a project's current-round verdict.
- Snapshot generation uses the newest resolved verdict.
- New reports do not show Walker conclusion headings or values.
- Project drawer displays the correct round's material checklist and real persisted status.

- [ ] **Step 1: Add failing source contract tests for report labels and admin override.**

Assert the report components no longer contain `Walker 结论`/`Walker 最终评审结论` display labels and contain recommendation wording, while `LiveReportPanel` contains an override control and renders special vote names.

- [ ] **Step 2: Run focused tests and confirm failure.**

Run: `node --test lib/reportSnapshots.test.cjs lib/reportTableLayout.test.cjs`

Expected: FAIL on the current Walker-specific labels/fields.

- [ ] **Step 3: Implement live report recommendation rendering.**

Use `project.verdict` for the displayed resolved result, add `project.recommendedVerdict`, show “推荐结论” and the blind counts/percentages, and add a compact special-vote marker/list. Keep the existing dimension averages, completion, issue and action fields.

- [ ] **Step 4: Implement administrator override.**

On selection, post to `/api/scores` with the current round `__admin_verdict__`, the current admin code, score `0`, and the selected comment. For “跟随推荐”, send an empty comment or delete the scoped override using the existing authenticated route behavior. Refresh the summary after saving and show save feedback.

- [ ] **Step 5: Update both printable round reports and project report.**

Replace Walker headings with “推荐结论”，keep blind rating/verdict distributions, add special-vote labels and names, and preserve total score, dimension averages, completion, ranking, issues and actions. Ensure snapshot report data is used when a snapshot is selected.

- [ ] **Step 6: Update project drawer material sections.**

Display separate round sections or a round selector. Fetch and save statuses with `round_no`, initialize the local state from returned materials, and retain existing status history behavior.

- [ ] **Step 7: Run tests and build.**

Run: `node --test lib/*.test.cjs`; `npm run build`

Expected: all tests pass and build exits with code 0.

- [ ] **Step 8: Commit admin/report changes.**

```bash
git add app/admin app/report
git commit -m "feat: show blind recommendations in admin and reports"
```

### Task 6: Integration verification and preview deployment

**Files:**
- Modify: `docs/立项评审系统说明.md`
- Modify: `docs/评委评分指南.md`
- Create: `docs/2026-09-01-盲评推荐与分轮资料更新说明.md`

- [ ] **Step 1: Run the complete automated verification.**

Run: `npm test`

Expected: all Node tests pass with zero failures.

- [ ] **Step 2: Run a clean production build.**

Run: `npm run build`

Expected: Next.js build completes successfully with no TypeScript errors.

- [ ] **Step 3: Start a local production server on an unused port and smoke test routes.**

Run: `npm run start -- -p 3100`

Check `GET /`, `/scoring`, `/admin`, and `/report` return HTTP 200. Confirm no Vercel login wall is introduced by the application.

- [ ] **Step 4: Update reviewer/admin documentation.**

Document the seven-reviewer source rule, personal blind verdicts, recommendation formula, admin override behavior, special vote wording, and Gate 1/Gate 2 material lists. Do not document Nadia or Walker as an official verdict owner.

- [ ] **Step 5: Deploy the verified branch to a preview URL.**

Use the existing project linkage or the repository's configured deployment command. Deploy only after the local build passes, and record the preview URL. The production branch must retain the PostgreSQL direct-access implementation.

- [ ] **Step 6: Perform browser acceptance checks.**

Check:

- Walker and another existing reviewer see identical personal rating/verdict controls.
- Walker sees the bonus panel but no final verdict/final rating selector.
- Special vote can be checked and unchecked with save feedback.
- A partial set of personal verdicts produces a recommendation using only submitted votes.
- Admin default follows the recommendation; manual override persists and changes the report preview.
- Both material checklists show the correct round and persist status after reload.
- Existing completion percentage is unchanged by personal verdict/rating/special vote.
- Report snapshot reflects the latest resolved verdict and contains no Walker conclusion label.

- [ ] **Step 7: Commit documentation and final verification metadata.**

```bash
git add docs/立项评审系统说明.md docs/评委评分指南.md docs/2026-09-01-盲评推荐与分轮资料更新说明.md
git commit -m "docs: update blind review guidance"
```

- [ ] **Step 8: Push only after acceptance.**

Push the verified result to the GitHub and company GitLab `main` branches after confirming the PostgreSQL migration is ready for the company deployment target.
