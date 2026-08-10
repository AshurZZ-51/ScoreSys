# ScoreSys 立项规则 V4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将附件确认的立项资料、评委、六维第二轮评分、评级和立项公示能力安全加入 ScoreSys，并保留所有历史评分版本。

**Architecture:** 使用 `two_round_v4` 作为新第二轮 assignment 的显式评分版本；评分规则集中在 `lib/scoringRules.js`，API、评委页、汇总和报告通过 assignment 的 `scoring_version` 选择规则。项目池增加资料、评级和立项公示字段，迁移脚本采用幂等 SQL。

**Tech Stack:** Next.js 14 App Router, TypeScript/JavaScript, Supabase PostgreSQL, pnpm tests.

## Global Constraints

- 第一轮规则不变：游戏性 60 + 创新性 40。
- 第二轮 V4 为 25/20/15/15/15/10，总分 100。
- 历史 `legacy_v1`、`two_round_v2`、`two_round_v3` 不重算。
- 运营指标和虚拟团队只做资料完整性检查，不进入评分。
- 资料 10 项，7 项必填；`submitted`/`exempt` 视为齐全。
- 新评委账号为 Ollie=`o`、Simon=`si`，旧账号密码不改。
- 普通管理员不能进行账号管理；Walker 与管理员可维护评级。

---

### Task 1: V4 评分规则与测试

**Files:**
- Modify: `lib/scoringRules.js`
- Test: `lib/scoringRules.test.cjs`

- [ ] 写失败测试：V4 第二轮包含六维、权重总和为 100、造价与预算三个分项参与计算、创新性档位为 8/10/12/14/20。
- [ ] 运行 `pnpm test -- lib/scoringRules.test.cjs`，确认因 `two_round_v4` 不存在而失败。
- [ ] 添加 V4 规则集、轮次定义、分项解析和版本解析，保留 V2/V3 结果。
- [ ] 运行同一测试文件，确认新测试和既有评分测试通过。

### Task 2: 新 assignment 与服务端版本传递

**Files:**
- Modify: `app/api/meetings/route.ts`
- Modify: `app/api/meeting-assignments/route.ts`
- Modify: `app/api/scores/route.ts`
- Modify: `app/api/summary/route.ts`
- Test: `lib/summaryRoute.test.cjs`

- [ ] 写失败测试：第二轮排会生成 `two_round_v4`，汇总包含六维和造价与预算，V3 历史仍使用旧维度。
- [ ] 运行目标测试确认失败。
- [ ] 修改排会、评分验证、汇总和评委贡献度统计，统一按 assignment 版本读取规则。
- [ ] 运行目标测试和 `pnpm test`，确认旧版本隔离。

### Task 3: 资料清单迁移与界面

**Files:**
- Modify: `lib/projectPoolWorkflow.ts`
- Modify: `app/scoring/page.tsx`
- Modify: `app/admin/components/ProjectDrawer.tsx`
- Modify: `app/admin/V2AdminPage.tsx`
- Create: `MIGRATION_INITIATION_V4.sql`
- Test: `lib/projectPoolWorkflow.test.cjs`

- [ ] 写失败测试：资料初始化为 10 项，必填数为 7，资料齐全统计按 7 项计算。
- [ ] 运行目标测试确认失败。
- [ ] 更新资料常量、初始化、状态标签、列表与评委页展示。
- [ ] 编写幂等迁移，给已有项目补齐两项新资料，不改既有状态。
- [ ] 运行资料测试并检查迁移 SQL 的重复执行安全性。

### Task 4: Ollie/Simon 账号与评委快照

**Files:**
- Modify: `app/api/meetings/route.ts`
- Create: `MIGRATION_INITIATION_V4.sql`
- Test: `lib/reviewerRoster.test.cjs`

- [ ] 写失败测试：会议快照包含 `o` 和 `si`，账号代码大小写和显示名正确。
- [ ] 运行目标测试确认失败。
- [ ] 在迁移中幂等 upsert 两个评委账号和角色，排会读取全部非管理员评委。
- [ ] 保持普通管理员不能访问账号管理接口。
- [ ] 运行账号/快照测试。

### Task 5: 评级、历史与立项公示

**Files:**
- Create: `lib/initiationWorkflow.js`
- Modify: `app/api/project-pool/route.ts`
- Modify: `app/api/project-pool/[id]/status/route.ts`
- Modify: `app/admin/components/ProjectDrawer.tsx`
- Modify: `app/admin/V2AdminPage.tsx`
- Modify: `app/report/ReportClient.tsx`
- Test: `lib/initiationWorkflow.test.cjs`

- [ ] 写失败测试：评级只接受 S/A/B/C，管理员和 Walker 都可修改，修改记录包含操作者和时间，公示草稿包含确认字段。
- [ ] 运行目标测试确认失败。
- [ ] 增加评级与初评/最终评级历史字段或兼容存储。
- [ ] 增加项目详情、结果和报告中的评级展示及公示草稿复制入口。
- [ ] 运行目标测试。

### Task 6: 报告、PRD、迁移和全量验证

**Files:**
- Modify: `app/report/components/RoundTwoReport.tsx`
- Modify: `docs/立项评审系统说明.md`
- Modify: `MIGRATION_INITIATION_V4.sql`
- Test: `lib/roundTwoReport.test.cjs`, `lib/reportSnapshots.test.cjs`

- [ ] 更新第二轮报告为 V4 六维，并继续按版本区分历史 V3。
- [ ] 更新系统说明和验收清单。
- [ ] 运行 `pnpm test`，确认全量通过。
- [ ] 运行 `pnpm run build`，确认生产构建通过；Windows standalone symlink 权限问题单独记录，不改源代码绕过。
- [ ] 检查 `git diff --check`、迁移文件和工作树范围。
