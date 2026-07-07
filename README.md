# 立项评审在线打分系统

基于 Next.js 14 + Supabase 的全栈评审打分平台。

## 功能
- 🔐 5评委 + 1管理员 = 6个账号
- 📊 5维度（可玩30/创新25/规划15/技美15/风险15），按评委角色显示对应维度
- 📝 滑块打分，实时保存
- 📈 管理员看板：项目排名、评委贡献度
- 🔄 重置评分 / 归档会议
- 📊 一键导出CSV + JSON
- 📄 一键生成V2.2风格的HTML报告
- 🆕 新建评审会，支持从历史模板复制项目

## 启动

### 1. 安装依赖
```bash
npm install
```

### 2. 配置环境变量
复制 `.env.local`（已包含Supabase凭证）

### 3. 本地开发
```bash
npm run dev
```

### 4. 部署到Vercel
```bash
vercel --prod
```

## 账号
| 账号 | 密码 | 角色 | 评哪些维度 |
|---|---|---|---|
| walker | walker123 | CEO | 全部5维度 |
| noice | noice123 | 策划 | 可玩/创新/规划 |
| sunner | sunner123 | 策划 | 可玩/创新/规划 |
| jarvis | jarvis123 | 技术/美术 | 规划/技美/风险 |
| gouki | gouki123 | 技术/美术 | 规划/技美/风险 |
| admin | admin123 | 管理员 | (全部权限) |

## 技术栈
- Next.js 14 (App Router)
- Supabase (PostgreSQL)
- TypeScript
- 纯CSS（无UI库依赖）