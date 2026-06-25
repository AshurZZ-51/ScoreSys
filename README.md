# 立项评估打分系统 - 腾讯云部署包

## 启动方式

### 方式1: 直接运行
```bash
PORT=3000 node server.js
```

### 方式2: Docker
```bash
docker build -t scoring-system .
docker run -p 3000:3000 scoring-system
```

### 方式3: PM2
```bash
npm install -g pm2
pm2 start server.js --name scoring
```

## 环境变量
- PORT: 端口（默认3000）
- HOSTNAME: 监听地址（默认0.0.0.0）
- NEXT_PUBLIC_SUPABASE_URL: Supabase URL
- NEXT_PUBLIC_SUPABASE_ANON_KEY: Supabase密钥

## 数据库配置
当前.env已配置：
- SUPABASE_URL=https://zrmosaqeyguopumteeut.supabase.co
- SUPABASE_KEY（service_role）

## 功能说明
1. 登录页：评委首字母登录，默认密码=首字母+123
2. 评分页：默认看当前评审会，可下拉切换历史
3. 管理员：admin51/123444
4. 管理员功能：切换当前评审会、编辑项目、删除评审会（3天恢复）
5. 评委只看已填写项目名+提报人的模板
