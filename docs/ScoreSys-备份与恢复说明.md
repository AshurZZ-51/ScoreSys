# ScoreSys 备份与恢复说明

**更新时间：** 2026-08-19

**代码分支：** `codex/project-pool-v2`

## 1. 本版本基线

- 远端仓库：`https://github.com/AshurZZ-51/ScoreSys.git`
- 当前版本包含项目池 V2、两轮评分（当前新建第二轮 V5 五维规则，兼容历史版本）、盲评推荐统计、报告快照、账号权限、分轮资料检查和评委评分指南。
- 正式地址：`https://scoresys.vercel.app`
- 正式访问要求：不经过 Vercel 外层网络验证，系统自身仍需要评委账号密码。

## 2. 源码备份内容

源码归档应至少包含：

- `app/`：登录、评委评分、管理员后台、报告和 API。
- `lib/`：评分规则、项目池状态机、汇总、报告、权限和测试。
- `scripts/`：项目池迁移和校验脚本。
- `MIGRATION*.sql`：数据库迁移脚本，执行前需确认目标数据库和当前版本。
- `docs/`：PRD、开发计划、系统说明、评委评分指南和本恢复说明。
- `package.json`、`pnpm-lock.yaml`、`package-lock.json`、`next.config.js`、`tsconfig.json`、`vercel.json`、`Dockerfile`、`cloudbaserc.json`、`.env.example`。
- 根目录的 `README.md`、`DEVELOPER_GUIDE.md`、`交付说明.md`。

不应放入源码归档：

- `.env`、`.env.local`、Supabase service role key、`ADMIN_SESSION_SECRET` 等真实密钥。
- `node_modules/`、`.next/`、`.vercel/` 等可重新生成目录。
- 未跟踪的临时开发过程文件。

## 3. 恢复步骤

1. 解压源码归档到 D 盘工作目录。
2. 安装 Node.js 和 pnpm，执行 `pnpm install`。
3. 根据 `.env.example` 恢复本地环境变量；真实生产密钥从密码管理工具或 Vercel 项目环境变量中取得，不从源码归档恢复。
4. 在 Supabase 目标项目中按版本顺序检查并执行需要的 `MIGRATION*.sql`，不要盲目重复执行未经确认的迁移。
5. 执行 `pnpm test` 和 `NEXT_STANDALONE=false pnpm build`。
6. 登录系统后检查项目池、评审会、评委评分、汇总和报告。
7. 部署后必须检查正式地址的 `/`、`/admin`、`/scoring`、`/report`，确认未登录访问不会跳转到 Vercel 验证页。

## 4. 数据恢复边界

- 源码归档不等于 Supabase 数据库备份。
- 项目评分、问题、改进动作、评审会和报告快照需要单独保留数据库备份或 JSON 导出。
- 仓库中的 `scoresys-pre-restore-*.json` 是历史恢复前数据快照，只作为历史参考，不代表当前数据库完整备份。
- 恢复数据库前应先复制现有数据并记录时间、目标环境和操作者。

## 5. 版本确认

恢复后先执行：

```bash
git branch --show-current
git log -1 --oneline
git remote -v
pnpm test
```

当前文档对应的最新功能版本以 Git 分支 `codex/project-pool-v2` 的最新远端提交为准。
