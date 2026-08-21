# 评委盲评与维度平均分 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 ScoreSys 增加按评审记录保存的个人评级、个人结论盲评统计、阶段/次数标签和维度平均分，并修复资料状态持久化。

**Architecture:** 保留现有 `scores` 作为个人分数与结论的来源，新增独立 `project_reviewer_ratings` 表保存非数值的 S/A/B/C 个人评级。由 `/api/summary` 统一计算维度平均分、盲评分布和 Walker 官方结果，评委页、管理员结果页和报告只消费同一聚合结构。

**Tech Stack:** Next.js 14 App Router、React、TypeScript、Supabase PostgreSQL、Node `node:test`、Vercel CLI。

## Global Constraints

- 不重新计算或覆盖历史总分。
- 第一轮显示“创意阶段”，第二轮显示“立项阶段”；第一次黄色，第二次红色。
- 盲评统计排除 Walker 和管理员，空白记录不计入结果。
- 只有 Walker 结论推动流程状态，管理员可修改官方评级和官方结论。
- Vercel 项目必须保持公开访问，无需访问者登录 Vercel。

---

### Task 1: Add test-first aggregation and label helpers

**Files:**
- Create: `lib/reviewerBlindReview.js`
- Create: `lib/reviewerBlindReview.test.cjs`
- Modify: `lib/reviewWorkflow.js`
- Modify: `lib/reviewWorkflow.test.cjs`

**Interfaces:**
- `buildDimensionAverages({ rules, scores, reviewerCodes })` returns dimension rows with `averageScore`, `maxScore`, `submittedCount`, and `expectedCount`.
- `buildBlindChoiceStats(values, expectedCount)` returns counts, percentages, submitted count, and expected count.
- `roundBadge(roundId)` and `attemptBadge(attemptNo)` return confirmed labels and colors.

- [ ] **Step 1: Write failing tests** for dimension averages, blank exclusion, Walker/admin exclusion, choice percentages, and label colors.
- [ ] **Step 2: Run `node --test lib/reviewerBlindReview.test.cjs lib/reviewWorkflow.test.cjs` and confirm failure because the new helpers do not exist.
- [ ] **Step 3: Implement the minimal helpers and update round/attempt display constants without changing database status values.
- [ ] **Step 4: Run the focused tests and confirm they pass.
- [ ] **Step 5: Commit `test: define blind review and dimension average rules`.

### Task 2: Add personal rating storage and permissions

**Files:**
- Create: `MIGRATION_REVIEWER_BLIND_RATING_V1.sql`
- Create: `app/api/project-ratings/route.ts`
- Create: `lib/projectReviewerRating.test.cjs`
- Modify: `app/api/scores/route.ts`

**Interfaces:**
- `POST /api/project-ratings` accepts `meeting_id`, `project_id`, `rating`; it derives round/attempt from `projects`, validates S/A/B/C, and upserts only the authenticated reviewer’s row.
- `GET /api/project-ratings?meetingId=...` returns rows for summary aggregation.

- [ ] **Step 1: Write failing route/helper tests** for rating validation, reviewer identity enforcement, and one row per assignment/reviewer.
- [ ] **Step 2: Run the focused tests and confirm they fail before the migration/API implementation.
- [ ] **Step 3: Add the idempotent table, unique index, indexes, and API implementation.
- [ ] **Step 4: Remove the non-Walker restriction for `r1::__verdict__` and `r2::__verdict__`; retain Walker-only status transition.
- [ ] **Step 5: Run focused tests and the existing score tests.
- [ ] **Step 6: Commit `feat: store reviewer blind ratings`.

### Task 3: Extend summary aggregation with blind stats and dimension averages

**Files:**
- Modify: `app/api/summary/route.ts`
- Modify: `lib/reportSnapshots.js`
- Modify: `lib/summaryRoute.test.cjs`
- Modify: `lib/reportSnapshots.test.cjs`

**Interfaces:**
- Each `roundSummaries[roundId]` gains `dimensionAverages`, `blindRatingStats`, `blindVerdictStats`, `officialRating`, and `walkerVerdict`.
- Existing `totalScore`, `dimTotals`, `completionRate`, `reviewerProblems`, and `reviewerActions` remain unchanged.

- [ ] **Step 1: Add failing tests** covering one project with two blind ratings, three verdict choices, a blank vote, and per-dimension scores from multiple reviewers.
- [ ] **Step 2: Run `node --test lib/summaryRoute.test.cjs lib/reportSnapshots.test.cjs` and confirm the new assertions fail.
- [ ] **Step 3: Load personal ratings in summary and use the shared helpers to derive current-round, current-attempt statistics.
- [ ] **Step 4: Add dimension average rows to snapshots while preserving legacy report payloads.
- [ ] **Step 5: Run focused tests and all existing tests.
- [ ] **Step 6: Commit `feat: expose blind review and dimension averages`.

### Task 4: Update reviewer UI for stage, attempt, rating, and verdict

**Files:**
- Modify: `app/scoring/page.tsx`
- Modify: `lib/projectPoolWorkflow.js`
- Modify: `lib/projectPoolWorkflow.test.cjs`

- [ ] **Step 1: Add failing UI/helper assertions** for phase/attempt labels and the visibility rule for personal versus official controls.
- [ ] **Step 2: Run focused tests and confirm failure.
- [ ] **Step 3: Add the two colored badges, personal S/A/B/C selector, and personal verdict buttons for all non-admin reviewers; keep Walker official controls separate.
- [ ] **Step 4: Save personal ratings through the new API and preserve existing save feedback.
- [ ] **Step 5: Reload a project and confirm personal values are restored for the logged-in reviewer.
- [ ] **Step 6: Run TypeScript checks and focused tests.
- [ ] **Step 7: Commit `feat: add reviewer personal rating and verdict controls`.

### Task 5: Update admin results and reports with dimension averages and blind stats

**Files:**
- Modify: `app/admin/V2AdminPage.tsx`
- Modify: `app/admin/page.tsx`
- Modify: `app/report/components/InitiationProjectReport.tsx`
- Modify: `app/report/components/RoundOneReport.tsx`
- Modify: `app/report/components/RoundTwoReport.tsx`
- Modify: `lib/reportSnapshots.test.cjs`
- Modify: `lib/roundTwoReport.test.cjs`

- [ ] **Step 1: Add failing rendering/data assertions** for dimension average columns and blind stats.
- [ ] **Step 2: Run focused tests and confirm failure.
- [ ] **Step 3: Render a stable dimension comparison table with aligned headers, average score/max score, and completion count.
- [ ] **Step 4: Render blind rating and verdict distributions next to the existing Walker official result.
- [ ] **Step 5: Keep legacy report sections and print layout compatible.
- [ ] **Step 6: Run tests and TypeScript checks.
- [ ] **Step 7: Commit `feat: show dimension averages in admin results and reports`.

### Task 6: Fix project material state persistence

**Files:**
- Modify: `app/admin/V2AdminPage.tsx`
- Modify: `app/api/project-pool/[id]/materials/route.ts`
- Modify: `app/api/project-pool/route.ts`
- Modify: `lib/projectPoolWorkflow.test.cjs`

- [ ] **Step 1: Add a failing regression test** proving a saved `submitted`/`exempt` material remains unchanged after reopening a project.
- [ ] **Step 2: Run the regression test and confirm failure.
- [ ] **Step 3: Initialize detail state only after the server response, update both detail and list state from the mutation response, and remove `missing` fallback after load.
- [ ] **Step 4: Run focused tests and all tests.
- [ ] **Step 5: Commit `fix: preserve project material statuses in admin detail`.

### Task 7: Verify, deploy, and publish the public acceptance link

**Files:**
- Modify: `docs/立项评审系统说明.md` if the public verification note needs updating.

- [ ] **Step 1: Run `node --test lib/*.test.cjs`.
- [ ] **Step 2: Run TypeScript validation with `node node_modules/typescript/bin/tsc --noEmit --incremental false`.
- [ ] **Step 3: Deploy the current worktree with the existing Vercel CLI and wait for `READY`.
- [ ] **Step 4: Open the deployment without Vercel credentials and verify the login page, reviewer page, admin results, and report routes.
- [ ] **Step 5: Confirm the Vercel project-level “Require Log In” setting remains disabled.
- [ ] **Step 6: Push the final branch and report the public acceptance URL, tests, deployment ID, and any manual SQL migration step.
