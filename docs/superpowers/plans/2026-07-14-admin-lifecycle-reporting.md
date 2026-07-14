# ScoreSys 后台生命周期与报告 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付可批量管理项目和评审会、可恢复项目删除、可生成报告快照、仅超管可管理账号的后台，同时保持两轮和旧版评分可读取。

**Architecture:** 保留 `project_pool` 为项目主档、`projects` 为单场评审记录；按项目、评审会、报告、账号拆分 API 和 React 管理组件。管理页每次写入成功后重取服务端汇总，避免分数、完成度、问题建议显示过期。

**Tech Stack:** Next.js 14 App Router、React、TypeScript、Supabase PostgreSQL、Node `node:test`、Vercel。

## Global Constraints

- 使用 `PROJECT_POOL_V2_ENABLED`；旧 `legacy_v1` 评分与意见持续可读。
- 资料状态仅为 `missing`、`needs_completion`、`submitted`、`exempt`；资料齐全不阻塞排会。
- 只有 Walker 结论为 `approved`、`recheck`、`rejected` 的记录计入项目评审历史。
- `admin51` 为唯一超管；普通管理员不具备账号管理接口或界面权限。
- 项目完全删除进入 15 天待清除区；会议删除只进入回收站，保留历史。
- 每场会议最多 12 个有效项目；拖拽排序必须持久化。

---

### Task 1: 迁移与生命周期规则

**Files:**
- Create: `MIGRATION_ADMIN_LIFECYCLE_V3.sql`
- Create: `lib/adminLifecycle.js`
- Create: `lib/adminLifecycle.test.cjs`
- Modify: `lib/projectPoolWorkflow.js`
- Modify: `lib/projectPoolWorkflow.test.cjs`

**Interfaces:**
- `getMaterialProgress(materials)` 以 `submitted` 和 `exempt` 计入必填完成数。
- `isCompletedReview(assignment)` 仅检查 Walker 结论。
- `sortMeetingsForAdmin(meetings)` 当前会议置顶，其余按 `meeting_date` 倒序。
- `deriveProjectDeletionState(request, now)` 返回 `archived`、`purge_pending` 或 `purged`。

- [ ] **Step 1: 写失败测试**

```js
test('submitted and exempt required material is complete', () => {
  const materials = required.map((item, index) => ({ item_key: item.item_key, status: index ? 'exempt' : 'submitted' }));
  assert.deepEqual(getMaterialProgress(materials), { approved: 5, total: 5, complete: true });
});

test('only Walker verdict counts as review history', () => {
  assert.equal(isCompletedReview({ verdict: null }), false);
  assert.equal(isCompletedReview({ verdict: 'approved' }), true);
});
```

- [ ] **Step 2: 验证测试失败**

Run: `pnpm test`

Expected: 新的生命周期函数未定义或资料状态断言失败。

- [ ] **Step 3: 实现 SQL 和纯函数**

```sql
ALTER TABLE project_materials DROP CONSTRAINT IF EXISTS project_materials_status_check;
UPDATE project_materials SET status = 'submitted' WHERE status = 'approved';
UPDATE project_materials SET status = 'needs_completion' WHERE status = 'needs_revision';
ALTER TABLE project_materials ADD CONSTRAINT project_materials_status_check
  CHECK (status IN ('missing', 'needs_completion', 'submitted', 'exempt'));

CREATE TABLE IF NOT EXISTS project_deletion_requests (
  project_id UUID PRIMARY KEY REFERENCES project_pool(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  purge_after TIMESTAMPTZ NOT NULL,
  restored_at TIMESTAMPTZ,
  restored_by TEXT
);

CREATE TABLE IF NOT EXISTS report_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('meeting', 'project')),
  scope_id UUID NOT NULL,
  report_type TEXT NOT NULL CHECK (report_type IN ('round_1', 'round_2', 'initiation')),
  version INTEGER NOT NULL,
  payload JSONB NOT NULL,
  generated_by TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(scope_type, scope_id, report_type, version)
);
```

Remove the `material_status <> 'complete'` check from `assign_pool_project_to_meeting` while retaining its 12-slot, round and attempt validation.

- [ ] **Step 4: 验证通过**

Run: `pnpm test`

Expected: 全部测试通过。

- [ ] **Step 5: 提交**

```bash
git add MIGRATION_ADMIN_LIFECYCLE_V3.sql lib/adminLifecycle.js lib/adminLifecycle.test.cjs lib/projectPoolWorkflow.js lib/projectPoolWorkflow.test.cjs
git commit -m "feat: add admin lifecycle data model"
```

### Task 2: 项目池、归档和待清除 API

**Files:**
- Modify: `app/api/project-pool/route.ts`
- Modify: `app/api/project-pool/[id]/history/route.ts`
- Modify: `app/api/project-pool/[id]/materials/route.ts`
- Modify: `app/api/project-pool/[id]/status/route.ts`
- Create: `app/api/project-pool/batch/route.ts`
- Create: `app/api/project-pool/archive/route.ts`
- Create: `app/api/project-pool/purge/route.ts`
- Test: `lib/adminLifecycle.test.cjs`

**Interfaces:**
- `GET /api/project-pool?scope=active|archived|purge_pending&month=YYYY-MM`。
- `POST /api/project-pool/batch` body 为 `{ ids, action: 'status' | 'archive', status?, operator_code }`。
- `POST /api/project-pool/archive` body 为 `{ id, action: 'restore' | 'request_purge' | 'restore_purge', operator_code }`。

- [ ] **Step 1: 写失败测试**

```js
test('purge request remains restorable for fifteen days', () => {
  const request = { purge_after: '2026-07-29T00:00:00.000Z', restored_at: null };
  assert.equal(deriveProjectDeletionState(request, new Date('2026-07-20')), 'purge_pending');
});
```

- [ ] **Step 2: 验证测试失败**

Run: `pnpm test`

Expected: 待清除状态函数尚未实现。

- [ ] **Step 3: 实现项目 API**

```ts
const purgeAfter = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();
await supabaseAdmin.from('project_deletion_requests').upsert({
  project_id: id, requested_by: operator_code, purge_after: purgeAfter, restored_at: null, restored_by: null
});
```

批量状态更新逐条写入 `project_status_history`。`history` 返回 `completed_reviews` 时过滤无 Walker 结论记录，但仍返回进行中记录给会议工作区。受控清理函数仅删除到期且未恢复项目，并按 `scores -> projects -> project_pool` 删除关联数据。

- [ ] **Step 4: 验证通过**

Run: `pnpm test && pnpm run build`

Expected: 测试与类型构建通过。

- [ ] **Step 5: 提交**

```bash
git add app/api/project-pool lib/adminLifecycle.js lib/adminLifecycle.test.cjs
git commit -m "feat: add project lifecycle APIs"
```

### Task 3: 项目池与评委资料提示 UI

**Files:**
- Create: `app/admin/components/ProjectPoolTable.tsx`
- Create: `app/admin/components/ProjectDrawer.tsx`
- Create: `app/admin/components/ProjectArchivePanel.tsx`
- Modify: `app/admin/V2AdminPage.tsx`
- Modify: `app/scoring/page.tsx`

**Interfaces:**
- `ProjectPoolTable` 接收 `{ projects, meetings, scope, month, onRefresh, onOpenProject }`。
- `ProjectDrawer` 接收 `{ project, onDismiss, onSaved }`，仅遮罩层可触发 `onDismiss`。

- [ ] **Step 1: 写失败测试**

```js
test('project drawer overlay dismisses only direct overlay clicks', () => {
  assert.equal(shouldDismissProjectDrawer({ target: 'overlay', currentTarget: 'overlay' }), true);
  assert.equal(shouldDismissProjectDrawer({ target: 'drawer', currentTarget: 'overlay' }), false);
});
```

- [ ] **Step 2: 验证测试失败**

Run: `pnpm test`

Expected: `shouldDismissProjectDrawer` 未定义。

- [ ] **Step 3: 实现界面**

```tsx
<div style={styles.overlay} onMouseDown={(event) => event.target === event.currentTarget && onDismiss()}>
  <aside style={styles.drawer} onMouseDown={(event) => event.stopPropagation()}><ProjectDetails /></aside>
</div>
```

表格提供月份筛选、全选、批量状态、批量入会和批量归档。抽屉保存后显示成功或失败提示，先更新本地行并调用 `onRefresh()`。归档页分为归档与待清除两个区块；完全删除与恢复均使用确认对话框。评分页项目标题上固定显示“资料齐全”或“待补充 N/5”。

- [ ] **Step 4: 验证通过**

Run: `pnpm test && pnpm run build`

Expected: 构建通过；手工验收抽屉外关闭、资料统计置顶和列表即时更新。

- [ ] **Step 5: 提交**

```bash
git add app/admin/components app/admin/V2AdminPage.tsx app/scoring/page.tsx lib/adminLifecycle.test.cjs
git commit -m "feat: improve project pool management UI"
```

### Task 4: 评审会列表、回收站、创建和拖拽编排

**Files:**
- Modify: `app/api/meetings/route.ts`
- Modify: `app/api/meetings/delete/route.ts`
- Modify: `app/api/meeting-assignments/route.ts`
- Create: `app/api/meetings/batch/route.ts`
- Create: `app/admin/components/MeetingList.tsx`
- Create: `app/admin/components/MeetingRecycleBin.tsx`
- Create: `app/admin/components/MeetingWorkspace.tsx`
- Modify: `app/admin/V2AdminPage.tsx`
- Test: `lib/adminLifecycle.test.cjs`

**Interfaces:**
- `POST /api/meetings` accepts `{ name, meeting_date, deadline, notes, pool_project_ids, create_projects }`。
- `PATCH /api/meeting-assignments` accepts `{ meeting_id, ordered_assignment_ids, operator_code }`。

- [ ] **Step 1: 写失败测试**

```js
test('current meeting stays before newer non-current meetings', () => {
  assert.deepEqual(sortMeetingsForAdmin([{ id: 'new', is_current: false, meeting_date: '2026-07-14' }, { id: 'current', is_current: true, meeting_date: '2026-07-01' }]).map((item) => item.id), ['current', 'new']);
});
```

- [ ] **Step 2: 验证测试失败**

Run: `pnpm test`

Expected: 当前会议排序断言失败。

- [ ] **Step 3: 实现会议域**

```tsx
function onDrop(event: React.DragEvent, targetId: string) {
  event.preventDefault();
  const sourceId = event.dataTransfer.getData('text/plain');
  const next = reorderAssignments(assignments, sourceId, targetId);
  setAssignments(next);
  persistOrder(next.map((item) => item.id));
}
```

会议删除只设置 `deleted_at`、`status = 'archived'` 与 `is_current = false`，取消现有 3 天清理。创建会议先建会议，再新建快速项目并调用排会 RPC；任一步失败时删除刚建会议。工作区保存来源 `meetings` 或 `reports`，返回按钮回到原入口。

- [ ] **Step 4: 验证通过**

Run: `pnpm test && pnpm run build`

Expected: 当前会议置顶，会议批量回收和恢复成功，新会议带项目创建成功，刷新后拖拽排序不变。

- [ ] **Step 5: 提交**

```bash
git add app/api/meetings app/api/meeting-assignments app/admin/components app/admin/V2AdminPage.tsx lib/adminLifecycle.js lib/adminLifecycle.test.cjs
git commit -m "feat: add meeting workspace management"
```

### Task 5: 实时汇总、报告快照和三种打印报告

**Files:**
- Modify: `app/api/summary/route.ts`
- Create: `app/api/reports/route.ts`
- Create: `app/api/reports/[id]/route.ts`
- Create: `lib/reportSnapshots.js`
- Create: `lib/reportSnapshots.test.cjs`
- Create: `app/admin/components/ReportSelector.tsx`
- Modify: `app/admin/V2AdminPage.tsx`
- Modify: `app/report/page.tsx`
- Create: `app/report/components/RoundOneReport.tsx`
- Create: `app/report/components/RoundTwoReport.tsx`
- Create: `app/report/components/InitiationProjectReport.tsx`

**Interfaces:**
- `buildMeetingReportPayload(summary, meeting)` returns report data only for completed reviews.
- `nextSnapshotVersion(snapshots)` returns the next immutable report version.
- `POST /api/reports` accepts `{ scope_type, scope_id, report_type, operator_code }`.

- [ ] **Step 1: 写失败测试**

```js
test('snapshot version increments without replacing payload', () => {
  assert.equal(nextSnapshotVersion([{ version: 1 }, { version: 2 }]), 3);
});
test('report ranking excludes projects without Walker verdict', () => {
  assert.deepEqual(buildMeetingReportPayload({ projects: [{ id: 'a', verdict: null }, { id: 'b', verdict: 'approved' }] }, {}).projects.map((item) => item.id), ['b']);
});
```

- [ ] **Step 2: 验证测试失败**

Run: `pnpm test`

Expected: 报告构建模块未定义。

- [ ] **Step 3: 实现汇总与报告**

```ts
const version = nextSnapshotVersion(existingSnapshots);
await supabaseAdmin.from('report_snapshots').insert({ scope_type, scope_id, report_type, version, payload, generated_by: operator_code });
```

`/api/summary` 只从 `scores`、`meeting_reviewers`、意见字段和 Walker 结论计算。报告选择页以会议下拉框代替会议列表。第一轮模板显示游戏性/创新性，第二轮显示项目规划/技术与美术/风险评估，立项项目模板显示两轮通过历史、时间线和得分。

- [ ] **Step 4: 验证通过**

Run: `pnpm test && pnpm run build`

Expected: 同一范围连续生成报告得到 v1、v2；三类打印报告均显示正确轮次和数据。

- [ ] **Step 5: 提交**

```bash
git add app/api/summary app/api/reports app/admin/components/ReportSelector.tsx app/report lib/reportSnapshots.js lib/reportSnapshots.test.cjs
git commit -m "feat: add versioned review reports"
```

### Task 6: 超管账号管理与发布验收

**Files:**
- Create: `lib/adminAuth.js`
- Create: `lib/adminAuth.test.cjs`
- Create: `app/api/accounts/route.ts`
- Create: `app/api/accounts/[code]/route.ts`
- Create: `app/admin/components/AccountManagement.tsx`
- Modify: `app/admin/V2AdminPage.tsx`
- Test: all `lib/*.test.cjs`

**Interfaces:**
- `isSuperAdmin(code)` 仅对 `admin51`（忽略大小写）返回 true。
- `GET /api/accounts?operator_code=...`、`POST /api/accounts`、`PATCH /api/accounts/[code]` 都只允许超管。

- [ ] **Step 1: 写失败测试**

```js
test('only admin51 is the super administrator', () => {
  assert.equal(isSuperAdmin('ADMIN51'), true);
  assert.equal(isSuperAdmin('walker'), false);
});
```

- [ ] **Step 2: 验证测试失败**

Run: `pnpm test`

Expected: `adminAuth` 模块未定义。

- [ ] **Step 3: 实现账号权限与发布验证**

```ts
if (!isSuperAdmin(operator_code)) return NextResponse.json({ error: '仅超管可管理账号' }, { status: 403 });
await supabaseAdmin.from('account_audit_logs').insert({ actor_code: operator_code, target_code: code, action: 'password_reset' });
```

账号列表不返回密码字段；普通管理员不显示入口且直接调用接口返回 403。新增账号、重置密码、管理员开关全部写审计记录，不允许降级或删除 `admin51`。在 Supabase SQL Editor 执行 Task 1 迁移后运行完整测试和构建，部署 Vercel Preview，覆盖超管、普通管理员、评委和 Walker 四类验收。

- [ ] **Step 4: 验证通过并部署预览**

Run: `git diff --check && pnpm test && pnpm run build`

Expected: 无格式错误、测试通过、构建成功；Vercel Preview 状态 `Ready`，旧项目总分与意见仍可读取。

- [ ] **Step 5: 提交和推送**

```bash
git add lib/adminAuth.js lib/adminAuth.test.cjs app/api/accounts app/admin/components/AccountManagement.tsx app/admin/V2AdminPage.tsx
git commit -m "feat: add superadmin account management"
git push origin codex/project-pool-v2
```

## 覆盖自检

- 项目批量、资料状态、归档和 15 天恢复：Tasks 1-3。
- Walker 历史门槛、实时分数/完成度/问题建议：Tasks 2、5。
- 会议置顶、回收站、新建带项目、拖拽和 12 槽位：Task 4。
- 下拉选择会议、轮次报告、立项报告、快照重生成：Task 5。
- `admin51` 独占账号管理：Task 6。
- 旧评分兼容、数据库迁移、构建和 Vercel 验收：Tasks 1、6。
