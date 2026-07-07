# 立项评审在线打分系统 — 完整开发文档

> 最后更新: 2026-07-02  
> 本文档面向任何接手开发的人或 AI，涵盖架构、数据库、API、前端、部署的全部细节。

---

## 一、项目概述

游戏公司内部使用的**立项评审会议在线打分系统**，支持多评审会管理、多评委多维度打分、实时汇总、报告生成与导出。

**核心功能：**
- 管理员创建/管理评审会，编辑项目信息
- 评委按自己负责的维度打分，提交问题备注和改进意见
- 管理员查看汇总得分、评委贡献度、设定评审结论
- 自动生成可打印的评审报告（含结论统计）
- 数据导出（CSV / JSON）

---

## 二、技术栈

| 层 | 技术 | 版本 |
|---|---|---|
| 框架 | Next.js (App Router) | 14.2.5 |
| 语言 | TypeScript | 5.4.5 |
| UI | React (纯 inline style, 无 CSS 框架) | 18.3.1 |
| 数据库 | Supabase (PostgreSQL) | 云服务 |
| 部署 | 腾讯云 CloudBase 容器 (Docker) | node:20-alpine |
| 构建输出 | standalone 模式 | - |

**无外部 UI 库**——所有样式用 React inline style 编写。

---

## 三、项目结构

```
scoring-system/
├── .env.local                  # 本地环境变量（Supabase URL + Keys）
├── next.config.js              # Next.js 配置（standalone 输出 + @ alias）
├── package.json                # 依赖（next, react, @supabase/supabase-js）
├── tsconfig.json               # TypeScript 配置
├── MIGRATION.sql               # 数据库迁移脚本
├── cloudbaserc.json            # 腾讯云 CloudBase 配置（参考用）
│
├── lib/
│   └── supabase.ts             # Supabase 客户端（service_role + anon）
│
├── app/
│   ├── globals.css             # 全局样式（极简）
│   ├── layout.tsx              # 根布局（<html lang="zh-CN">）
│   ├── page.tsx                # 登录页 /
│   │
│   ├── scoring/
│   │   └── page.tsx            # 评委打分页 /scoring（~810行）
│   │
│   ├── admin/
│   │   └── page.tsx            # 管理员看板 /admin（~1030行）
│   │
│   ├── report/
│   │   ├── page.tsx            # 报告入口（Suspense 包裹）
│   │   └── ReportClient.tsx    # 报告主体 /report?meetingId=xxx（~735行）
│   │
│   └── api/
│       ├── auth/login/route.ts       # POST 登录验证
│       ├── meetings/route.ts         # GET/POST/PATCH 评审会 CRUD
│       ├── meetings/delete/route.ts  # POST 软删除/恢复/彻底删除
│       ├── projects/route.ts         # GET/POST/PATCH/DELETE 项目 CRUD
│       ├── scores/route.ts           # GET/POST/DELETE 评分 CRUD
│       └── summary/route.ts          # GET 汇总数据（含维度均分计算）
│
# 部署目录（D:\GitHub\ScoreSys）
├── Dockerfile                  # Docker 镜像定义
├── start.sh                    # 启动脚本
├── .env                        # 生产环境变量
└── server.js                   # Next.js standalone 入口（构建自动生成）
```

---

## 四、数据库设计 (Supabase PostgreSQL)

### 4.1 表结构

#### `reviewers` — 评委表
| 字段 | 类型 | 说明 |
|---|---|---|
| code | text PK | 评委代号（如 W, N, S, J, G） |
| name | text | 评委姓名 |
| role | text | 角色描述（如"制作人"） |
| is_admin | boolean | 是否管理员 |
| password_hash | text | 密码（明文存储，如 W123） |

#### `reviewer_dims` — 评委维度权限表
| 字段 | 类型 | 说明 |
|---|---|---|
| reviewer_code | text FK → reviewers.code | 评委代号 |
| dim_name | text | 维度名（如 可玩性、创新性、项目规划、技术&美术、风险性） |
| max_score | integer | 该评委在该维度的满分（如 20） |

**一个评委可以负责多个维度，每个维度可以有不同的满分值。**  
**维度名必须完全匹配前端硬编码的5个维度名之一。**

#### `meetings` — 评审会表
| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | 自动生成 |
| name | text | 评审会名称 |
| meeting_date | date | 会议日期 |
| deadline | date | 打分截止日期（可选） |
| status | text | active / locked / archived / pending_delete |
| notes | text | 备注 |
| is_current | boolean | 是否为当前评审会（全局唯一 true） |
| deleted_at | timestamptz | 软删除时间 |
| scheduled_purge_at | timestamptz | 计划清理时间（deleted_at + 3天） |
| created_at | timestamptz | 创建时间 |

#### `projects` — 项目表
| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | 自动生成 |
| meeting_id | uuid FK → meetings.id | 所属评审会 |
| seq_no | integer | 序号（1-8） |
| name | text | 项目名（空=未填写，评委不可见） |
| submitter | text | 提报人 |
| description | text | 项目简介 |
| is_template | boolean | 是否模板（空模板） |
| is_pending | boolean | 是否待补评 |
| problems | text[] | (历史遗留字段，已弃用，改用 scores 表存储) |
| actions | text[] | (历史遗留字段，已弃用，改用 scores 表存储) |

#### `scores` — 评分表（核心）
| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | 自动生成 |
| meeting_id | uuid FK | 评审会 ID |
| project_id | uuid FK | 项目 ID |
| reviewer_code | text FK | 评委代号 |
| dim_name | text | 维度名 或 特殊标识（见下方） |
| score | numeric | 分数 |
| comment | text | 备注/内容 |
| updated_at | timestamptz | 最后更新时间 |

**唯一约束：** `UNIQUE(meeting_id, project_id, reviewer_code, dim_name)`  
使用 upsert + onConflict 实现"存在则更新，不存在则插入"。

### 4.2 特殊 dim_name 值

scores 表复用 dim_name 字段存储非评分数据：

| dim_name | score | comment | 用途 | 谁可以写 |
|---|---|---|---|---|
| `可玩性` / `创新性` / `项目规划` / `技术&美术` / `风险性` | 0~满分 | 可选备注 | 正常维度评分 | 有权限的评委 |
| `__bonus__` | 1~5 | 加分原因 | Walker 额外加分项 | 仅 W |
| `__problems__` | 0 | 问题文本(换行分隔) | 评委提出的存在问题 | 所有评委 |
| `__actions__` | 0 | 意见文本(换行分隔) | 评委提出的改进动作 | 所有评委 |
| `__verdict__` | 0 | approved/needs_rework/needs_review/null | 管理员设定的评审结论 | 管理员 |

### 4.3 分数计算逻辑

```
每个维度得分 = 该维度所有评委打分的 AVG（平均值）
基础分 baseScore = 各维度平均分之和
总分 totalScore = baseScore + bonusScore（Walker 加分）
总满分 totalMaxScore = 各维度单个评委满分之和（每维度取第一个评委的 max_score）
```

**示例：** 假设 5 个维度各 20 分满分 → totalMaxScore = 100

---

## 五、API 接口详解

所有 API 路径都在 `/api/` 下，使用 Next.js Route Handler。  
所有接口都设置 `export const dynamic = 'force-dynamic'`。  
所有数据库操作使用 `supabaseAdmin`（service_role key，绕过 RLS）。

### 5.1 POST /api/auth/login

**请求：** `{ code: "W", password: "W123" }`  
**响应：**
```json
{
  "success": true,
  "reviewer": {
    "code": "W",
    "name": "Walker",
    "role": "制作人",
    "is_admin": true,
    "dimensions": [
      { "dim_name": "可玩性", "max_score": 20 },
      { "dim_name": "创新性", "max_score": 20 }
    ]
  }
}
```
- 账号不区分大小写（ilike）
- 密码是明文比对（password_hash 字段）
- 登录后存入 localStorage('reviewer')
- is_admin=true → 跳转 /admin，否则 → /scoring

### 5.2 GET /api/meetings

**参数：** `?includeDeleted=true`（可选）  
**响应：** `{ meetings: [...] }`

### 5.3 POST /api/meetings

**请求：** `{ name, meeting_date, deadline?, notes?, copy_from_meeting_id? }`  
- 自动创建 8 个空模板项目
- 如有 copy_from_meeting_id，复制源会议的项目信息

### 5.4 PATCH /api/meetings

**请求：** `{ id, is_current?, name?, meeting_date?, deadline?, notes? }`  
- 设 is_current=true 时，先清除其他会议的 is_current

### 5.5 POST /api/meetings/delete

**请求：** `{ id, action: "soft_delete" | "restore" | "purge" }`  
- soft_delete: 标记删除，3天后自动清理
- restore: 恢复
- purge: 立即彻底删除（级联删除 projects + scores）

### 5.6 GET /api/projects

**参数：** `?meetingId=xxx&role=admin|reviewer`  
- role=reviewer 时过滤掉 name 或 submitter 为空的项目

### 5.7 POST/PATCH/DELETE /api/projects

标准 CRUD。

### 5.8 GET /api/scores

**参数：** `?meetingId=xxx&reviewerCode=W&projectId=xxx`（后两者可选）

### 5.9 POST /api/scores

**请求：** `{ meeting_id, project_id, reviewer_code, dim_name, score, comment? }`  
**验证逻辑：**
1. 检查会议状态（locked/archived 拒绝）
2. 检查截止日期
3. 验证维度权限：
   - `__bonus__` → 仅 W，maxScore=5
   - `__problems__`/`__actions__`/`__verdict__` → maxScore=0（不计分）
   - 正常维度 → 查 reviewer_dims 表获取 maxScore
4. 验证分数范围 0~maxScore
5. Upsert（onConflict: meeting_id,project_id,reviewer_code,dim_name）

### 5.10 DELETE /api/scores

**参数：** `?meetingId=xxx&reviewerCode=xxx&projectId=xxx`  
批量删除评分数据。

### 5.11 GET /api/summary

**参数：** `?meetingId=xxx`  
**这是最复杂的接口**，并行查询 5 张表，计算：
- 每个项目各维度的 AVG 平均分
- 提取 __bonus__（加分明细）、__problems__（问题）、__actions__（意见）、__verdict__（结论）
- 计算完成率 completionRate
- 计算评委贡献度

**响应：**
```json
{
  "meeting": { ... },
  "projects": [
    {
      "id": "...", "seq_no": 1, "name": "...", "submitter": "...",
      "dimTotals": {
        "可玩性": { "total": 40, "avg": 13.33, "count": 3, "maxScore": 20, "percentage": 67, "reviewers": ["N","S","J"] }
      },
      "baseScore": 65.5,
      "bonusScore": 3,
      "bonusDetails": [{ "reviewer": "W", "value": 3, "reason": "创新突出" }],
      "totalScore": 68.5,
      "completionRate": 100,
      "reviewerProblems": [
        { "reviewer_code": "N", "reviewer_name": "Nadia", "problems": ["问题1", "问题2"] }
      ],
      "reviewerActions": [...],
      "verdict": "approved"
    }
  ],
  "scores": [...],
  "reviewers": [
    {
      "code": "N", "name": "Nadia", "role": "策划总监",
      "scoresGiven": 24, "projectsScored": 8, "totalGiven": 290,
      "expectedScores": 24, "dimensions": ["可玩性","创新性","项目规划"],
      "dimMaxTotal": 60
    }
  ],
  "dimConfig": [
    { "name": "可玩性", "maxScore": 60, "reviewerCount": 3 }
  ],
  "totalMaxScore": 100
}
```

---

## 六、前端页面详解

### 6.1 登录页 `/` (page.tsx)

- 输入账号+密码
- POST /api/auth/login
- 成功后 localStorage.setItem('reviewer', JSON.stringify(data))
- is_admin → /admin，否则 → /scoring

### 6.2 评委打分页 `/scoring` (scoring/page.tsx)

**布局：** 顶部导航栏 + 左侧项目列表 + 右侧打分区

**数据流：**
1. 从 localStorage 读取评委信息
2. 加载评审会列表 → 默认选 is_current=true 的
3. 加载项目列表（role=reviewer，只看已填的）
4. 加载该评委的所有评分

**打分交互：**
- 每个维度一个数字输入框 + 滑块
- 输入即时保存（调用 POST /api/scores）
- Walker 专属加分区（1-5 分 + 加分原因），需点"保存加分"
- 评审意见（存在问题 + 整改意见），需点"保存评审意见"

**重要：** 加分项和评审意见是**手动保存**的（点按钮），不是自动保存。

### 6.3 管理员看板 `/admin` (admin/page.tsx)

**布局：** 顶部导航 + 评审会切换 + 操作按钮 + 项目模板管理 + 得分总览 + 项目评审详情 + 评委贡献度

**功能模块：**

1. **评审会管理：** 切换/新建/设为当前/删除（软删除+回收站）
2. **项目模板：** 8 个卡片，点击弹窗编辑（项目名/提报人/简介）
3. **得分总览：** 表格显示各项目各维度均分、基础分、加分、总分、完成度
4. **项目评审详情：** 可折叠卡片，每个项目显示：
   - 评审结论按钮（评审通过/待修改/待重评）— 点击选中，再点取消
   - Walker 加分明细
   - 存在问题（逐条带评委标签）
   - 改进动作（逐条带评委标签）
5. **评委贡献度：** 卡片显示每个评委已评维度数、覆盖项目数、完成进度
6. **工具栏按钮：** 生成报告 / 刷新数据 / 导出CSV / 导出JSON / 重置评分 / 删除评审会

**子组件（同文件内）：**
- `TrashView` — 回收站视图
- `NewMeetingModal` — 新建评审会弹窗
- `EditProjectModal` — 编辑项目弹窗
- `ProjectDetailCard` — 项目评审详情卡片（含结论按钮）

### 6.4 报告页 `/report` (report/ReportClient.tsx)

**访问方式：** `/report?meetingId=xxx`（从管理后台"生成报告"按钮打开新窗口）

**报告结构（从上到下）：**
1. 操作栏（打印/关闭按钮，打印时隐藏）
2. 标题区（评审会名称、日期）
3. 概览统计（4 卡片：候选项目/评审评委/已评项目/维度满分）
4. 评审方法 & 计算公式（可折叠）
5. 项目评分明细（每个项目一个卡片：维度条形图+加分明细+结论标签）
6. 维度得分对比（横向条形图对比各项目）
7. 评委贡献度（卡片+进度条）
8. 待补评项目（如有）
9. 各项目问题与改进动作（逐条带评委标签）
10. 结论统计（5 卡片：参评/通过/待修改/待重评/改进意见 + 结论明细表）
11. 页脚

**辅助组件（同文件内）：**
- `SectionTitle` — 章节标题
- `ConclusionBox` — 结论统计卡片
- `StatCard` — 概览统计卡片

---

## 七、环境变量

### 开发环境 (.env.local)

```env
NEXT_PUBLIC_SUPABASE_URL=https://你的项目.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...（anon key 或 service_role key）
SUPABASE_SERVICE_KEY=eyJ...（service_role key）
```

### 生产环境 (.env 位于部署目录)

```env
NEXT_PUBLIC_SUPABASE_URL=https://你的项目.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_KEY=eyJ...
```

**注意：** `lib/supabase.ts` 会按优先级查找：
- URL: `NEXT_PUBLIC_SUPABASE_URL` > `SUPABASE_URL`
- Key: `SUPABASE_SERVICE_ROLE_KEY` > `SUPABASE_SERVICE_KEY` > `NEXT_PUBLIC_SUPABASE_ANON_KEY`

**当前项目使用 service_role key 绕过 RLS**，所有数据库操作都通过服务端 API 路由。

---

## 八、构建 & 部署流程

### 8.1 本地开发

```bash
cd scoring-system
npm install
npm run dev          # http://localhost:3000
```

### 8.2 构建

```bash
npm run build        # 或 npx next build
```

输出到 `.next/standalone/` + `.next/static/`。

### 8.3 部署到腾讯云（当前方式）

**源代码目录：** `C:\Users\Ashur\Downloads\scoring-system`  
**部署目录：** `D:\GitHub\ScoreSys`（Git 仓库：github.com/AshurZZ-51/ScoreSys）

```powershell
# 1. 构建
$env:PATH = "C:\Users\Ashur\.nodejs\node-v20.18.0-win-x64;$env:PATH"
Set-Location "C:\Users\Ashur\Downloads\scoring-system"
npx next build

# 2. 复制 standalone 到部署目录（保留 Dockerfile/start.sh/.env）
$src = "C:\Users\Ashur\Downloads\scoring-system\.next\standalone"
$dest = "D:\GitHub\ScoreSys"

# 清除旧文件（但保留关键文件）
Get-ChildItem $dest -Exclude ".git", "Dockerfile", "start.sh", ".env" | Remove-Item -Recurse -Force

# 复制 standalone
Copy-Item "$src\*" $dest -Recurse -Force

# 复制 static 资源
Copy-Item "C:\Users\Ashur\Downloads\scoring-system\.next\static\*" "$dest\.next\static" -Recurse -Force

# 3. 提交推送
Set-Location $dest
git add -A
git commit -m "描述信息"
git push

# 4. 腾讯云自动检测到 push → 拉取 → docker build → 部署
```

**Dockerfile 内容：**
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY . .
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
```

### 8.4 部署注意事项

- **绝对不能删除** `D:\GitHub\ScoreSys` 里的 `Dockerfile`、`start.sh`、`.env`
- standalone 模式不含 `node_modules`（已 bundle），也不含 `.next/static/`（需手动复制）
- 腾讯云通过 GitHub webhook 自动触发部署，如果没触发需手动操作

---

## 九、数据库初始化

### 9.1 创建表（在 Supabase SQL Editor 执行）

```sql
-- 评委表
CREATE TABLE reviewers (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT,
  is_admin BOOLEAN DEFAULT false,
  password_hash TEXT NOT NULL
);

-- 评委维度权限表
CREATE TABLE reviewer_dims (
  reviewer_code TEXT REFERENCES reviewers(code),
  dim_name TEXT NOT NULL,
  max_score INTEGER NOT NULL DEFAULT 20,
  PRIMARY KEY (reviewer_code, dim_name)
);

-- 评审会表
CREATE TABLE meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  meeting_date DATE NOT NULL,
  deadline DATE,
  status TEXT DEFAULT 'active',
  notes TEXT,
  is_current BOOLEAN DEFAULT false,
  deleted_at TIMESTAMPTZ,
  scheduled_purge_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX idx_meetings_single_current ON meetings (is_current) WHERE is_current = true;

-- 项目表
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID REFERENCES meetings(id),
  seq_no INTEGER NOT NULL,
  name TEXT DEFAULT '',
  submitter TEXT DEFAULT '',
  description TEXT DEFAULT '',
  is_template BOOLEAN DEFAULT false,
  is_pending BOOLEAN DEFAULT false,
  problems TEXT[] DEFAULT '{}',
  actions TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 评分表
CREATE TABLE scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID REFERENCES meetings(id),
  project_id UUID REFERENCES projects(id),
  reviewer_code TEXT REFERENCES reviewers(code),
  dim_name TEXT NOT NULL,
  score NUMERIC DEFAULT 0,
  comment TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(meeting_id, project_id, reviewer_code, dim_name)
);
```

### 9.2 插入评委数据（示例）

```sql
INSERT INTO reviewers (code, name, role, is_admin, password_hash) VALUES
  ('W', 'Walker', '制作人', true, 'W123'),
  ('N', 'Nadia', '策划总监', false, 'N123'),
  ('S', 'Simon', '技术总监', false, 'S123'),
  ('J', 'Jack', '美术总监', false, 'J123'),
  ('G', 'Grace', '项目管理', false, 'G123');

INSERT INTO reviewer_dims (reviewer_code, dim_name, max_score) VALUES
  ('N', '可玩性', 20), ('N', '创新性', 20), ('N', '项目规划', 20),
  ('S', '技术&美术', 20), ('S', '风险性', 20), ('S', '可玩性', 20),
  ('J', '技术&美术', 20), ('J', '创新性', 20),
  ('G', '项目规划', 20), ('G', '风险性', 20);
```

**注意：** Walker (W) 是管理员，不在 reviewer_dims 里配置维度（他通过 __bonus__ 加分）。

### 9.3 五个评分维度（硬编码）

| 维度 | 颜色 |
|---|---|
| 可玩性 | #3b82f6 蓝 |
| 创新性 | #8b5cf6 紫 |
| 项目规划 | #06b6d4 青 |
| 技术&美术 | #ec4899 粉 |
| 风险性 | #f59e0b 黄 |

**⚠ 维度名在以下位置硬编码：**
- `admin/page.tsx` 表头和 CSV 导出
- `report/ReportClient.tsx` 颜色映射

修改维度名需同步修改数据库和以上文件。

---

## 十、已知局限与技术债

1. **密码明文存储** — `password_hash` 实际存的是明文密码，需改用 bcrypt
2. **无 JWT / session** — 登录态仅存在 localStorage，无服务端验证（任何人拿到 reviewer code 就能操作）
3. **维度名硬编码** — 管理后台表头和报告颜色映射写死了 5 个维度名
4. **8 个项目固定模板** — 创建评审会时固定生成 8 个模板，无法动态增减
5. **projects 表的 problems/actions 字段已弃用** — 问题和意见现在存在 scores 表（dim_name = __problems__ / __actions__），但 projects 表的旧字段未删除
6. **无实时推送** — 管理后台查看评委提交的数据需要手动点"刷新数据"
7. **定时清理未实现** — 软删除的评审会有 scheduled_purge_at 字段，但没有定时任务自动清理
8. **无权限中间件** — API 路由没有统一的认证中间件，仅靠客户端 localStorage 判断

---

## 十一、常见迭代需求指南

### 添加新维度
1. 在 `reviewer_dims` 表添加新维度记录
2. 修改 `admin/page.tsx` 中表头的硬编码维度列表
3. 修改 `admin/page.tsx` 中 CSV 导出的 `dims` 数组
4. 修改 `report/ReportClient.tsx` 中的 `dimColors` 对象
5. 其他地方（scoring, summary API）是**动态读取** reviewer_dims 的，不需要改

### 添加新评委
只需在数据库操作：
1. `INSERT INTO reviewers` 新评委
2. `INSERT INTO reviewer_dims` 分配维度权限

### 修改项目数量（不再固定 8 个）
修改 `meetings/route.ts` 中 POST 方法里的模板生成循环 `for (let i = 1; i <= 8; i++)`

### 添加实时刷新
- 方案 A: 定时轮询（setInterval + loadData）
- 方案 B: Supabase Realtime（监听 scores 表变更）
- 方案 C: 添加 WebSocket

### 加强安全性
1. 添加 Next.js middleware 校验请求
2. 改用 JWT token 替代 localStorage
3. 密码改用 bcrypt hash
4. API 路由增加认证检查

---

## 十二、Supabase 配置要点

- **项目 URL:** https://zrmosaqeyguopumteeut.supabase.co
- **RLS 状态:** 所有表的 RLS 可以**关闭**（因为全走 service_role key）或者保持开启但通过 service_role 绕过
- **API 限制:** 免费版限 500 MB 数据库 + 50,000 请求/月

---

## 附录：完整 API 快速参考

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | /api/auth/login | 登录 |
| GET | /api/meetings | 获取评审会列表 |
| POST | /api/meetings | 创建评审会 |
| PATCH | /api/meetings | 更新评审会 |
| POST | /api/meetings/delete | 删除/恢复/彻底删除 |
| GET | /api/projects | 获取项目列表 |
| POST | /api/projects | 创建项目 |
| PATCH | /api/projects | 更新项目 |
| DELETE | /api/projects | 删除项目 |
| GET | /api/scores | 获取评分 |
| POST | /api/scores | 提交/更新评分 |
| DELETE | /api/scores | 删除评分 |
| GET | /api/summary | 获取汇总数据 |
