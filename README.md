# Gap Weekend Alarm

基于 Cloudflare Pages + Worker 的匿名 WebPush 提醒 PWA，支持大小周 / 双休 / 单休三种排班规则，在指定时刻推送周末 / 调休 / 工作日提醒。推送载荷仅含 `type` 字段，不采集任何个人信息。

**[立即使用 →](https://gap-weekend-alarm.pages.dev/)**

## 项目架构

```
Cloudflare Pages          ← 前端 PWA (apps/web, React + MUI)
Cloudflare Worker         ← API + 定时调度 (apps/worker, Hono)
Cloudflare D1             ← 数据库（订阅配置、假期调整、重试队列）
Cloudflare Turnstile      ← 注册时的人机验证
```

Worker 挂载两条 Cron：
- `* * * * *` — 每分钟扫描到期推送任务
- `0 2 * * *` — 每日 UTC 02:00 从 [holiday-cn](https://github.com/NateScarlet/holiday-cn) 同步上一年、当年及次年假期数据

---

## 本地开发

### 安装依赖

```bash
npm install
npx playwright install chromium   # 仅首次，用于 e2e 测试
```

### 配置本地环境变量

```bash
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
# 编辑 .dev.vars，填入 VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT
# ALLOW_INSECURE_TURNSTILE_BYPASS=true 已默认开启，本地无需真实 Turnstile
```

### 启动服务

```bash
# 终端 1 — Worker（含 D1 本地数据库，自动 apply migrations）
npm run dev:worker

# 终端 2 — Web
npm run dev:web
```

Web 默认访问 `http://localhost:5173`，Worker API 在 `http://127.0.0.1:8787`。

### 运行测试

```bash
# 纯 Web UI 测试（不需要 Worker 运行）
npm run test:e2e:web

# Web + Worker 联合集成测试
npm run test:e2e:joint
```

---

## 生产部署

### 前置：Worker

#### 1. 创建 D1 数据库（首次）

```bash
cd apps/worker
npx wrangler d1 create gap-weekend-alarm-db
```

将输出的 `database_id` 填入 `apps/worker/wrangler.toml` 的 `[[d1_databases]]` 块。

#### 2. 应用数据库迁移

```bash
npx wrangler d1 migrations apply gap-weekend-alarm --remote
```

#### 3. 生成 VAPID 密钥对

```bash
npx web-push generate-vapid-keys
```

将 **Public Key** 填入 `apps/worker/wrangler.toml` 的 `VAPID_PUBLIC_KEY`：

```toml
[vars]
VAPID_PUBLIC_KEY = "你的公钥"
```

#### 4. 创建 Turnstile Widget

前往 [Cloudflare Turnstile](https://dash.cloudflare.com/?to=/:account/turnstile) → 创建 Widget，类型选 **Managed**，记录：
- **Site Key** — 填入 Web 前置步骤
- **Secret Key** — 作为 Worker Secret

#### 5. 设置 Worker Secrets

```bash
cd apps/worker

# VAPID 私钥（来自第 3 步生成结果）
npx wrangler secret put VAPID_PRIVATE_KEY

# VAPID 联系 URI（mailto: 或 https: 格式）
npx wrangler secret put VAPID_SUBJECT

# Turnstile Secret Key（来自第 4 步）
npx wrangler secret put TURNSTILE_SECRET
```

#### 6. 部署 Worker

```bash
# 在项目根目录
npm run deploy:worker

# 或进入 apps/worker 目录
cd apps/worker && npx wrangler deploy
```

部署成功后记录 Worker URL，格式为 `https://<name>.<subdomain>.workers.dev`。

---

### 前置：Web

Web 使用 `.env.production` 注入构建时环境变量（该文件已 gitignore，需从示例文件复制）：

```bash
cp apps/web/.env.production.example apps/web/.env.production
```

编辑 `apps/web/.env.production`：

```env
# Worker 部署后的 URL
VITE_API_BASE_URL=https://gap-weekend-alarm-worker.<subdomain>.workers.dev

# Turnstile Site Key（来自 Turnstile 前置步骤）
VITE_TURNSTILE_SITE_KEY=0x...
```

### 部署 Web

```bash
# 在项目根目录，先构建再部署到 Cloudflare Pages
npm run build:web
npm run deploy:web
```

首次部署会自动在 Cloudflare Pages 创建名为 `gap-weekend-alarm` 的项目。

---

## 完整部署速查

```bash
# ── Worker ──────────────────────────────────────
cd apps/worker
npx wrangler d1 create gap-weekend-alarm-db          # 首次
# 更新 wrangler.toml 中的 database_id
npx wrangler d1 migrations apply gap-weekend-alarm --remote
npx web-push generate-vapid-keys                     # 记录公钥 & 私钥
# 将公钥写入 wrangler.toml VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT
npx wrangler secret put TURNSTILE_SECRET
cd ../..
npm run deploy:worker

# ── Web ─────────────────────────────────────────
cp apps/web/.env.production.example apps/web/.env.production
# 编辑 .env.production，填入 Worker URL 和 Turnstile Site Key
npm run build:web
npm run deploy:web
```

---

## 配置说明

| 位置 | 键 | 说明 |
|---|---|---|
| `wrangler.toml` `[vars]` | `VAPID_PUBLIC_KEY` | VAPID 公钥，非敏感，可明文提交 |
| `wrangler.toml` `[vars]` | `PUSH_MODE` | `live`（生产）/ `simulate`（仅日志）/ `off`（静默）|
| `wrangler.toml` `[vars]` | `ALLOW_INSECURE_TURNSTILE_BYPASS` | 生产保持 `"false"` |
| Worker Secret | `VAPID_PRIVATE_KEY` | VAPID 私钥 |
| Worker Secret | `VAPID_SUBJECT` | 推送联系 URI，如 `mailto:you@example.com` |
| Worker Secret | `TURNSTILE_SECRET` | Turnstile 服务端密钥 |
| `apps/web/.env.production` | `VITE_API_BASE_URL` | Worker 的完整 URL |
| `apps/web/.env.production` | `VITE_TURNSTILE_SITE_KEY` | Turnstile 前端 Site Key |

---

## 可用脚本

```bash
npm run dev:web          # 启动 Web 开发服务器
npm run dev:worker       # 启动 Worker 本地开发服务器
npm run build:web        # 构建 Web 静态资源
npm run deploy:web       # 部署 Web 到 Cloudflare Pages
npm run deploy:worker    # 部署 Worker 到 Cloudflare Workers
npm run lint:web         # ESLint 检查 Web
npm run lint:worker      # TypeScript 检查 Worker
npm run test:e2e:web     # 纯 Web UI 测试（Playwright）
npm run test:e2e:joint   # Web + Worker 联合集成测试（Playwright）
```

## 节假日地区（中国内地）

设置 → 排班规则与本地计算 → **节假日地区** 可选择关闭或中国内地。
默认关闭，保留原有大小周/双休/单休计算；开启后，明确的休假和调休上班记录覆盖排班，
但不改变大小周锚点。日历显示“休 / 班”和节日名称，倒计时使用同一规则。
地区与时区分别设置：日期按用户选择的时区解释。已开启通知的用户需点击“同步通知配置”。

当前只实现中国内地；香港、澳门、台湾的预留来源已停用，未来接入数据后再开放，避免显示没有数据的地区。
源数据来自 [NateScarlet/holiday-cn](https://github.com/NateScarlet/holiday-cn)（MIT，见 `THIRD_PARTY_NOTICES.md`），
包含国务院公告对应的休假及调休上班安排；它不是对每个普通周末的完整标注，也不是官方服务。
未列出的日期仍按个人排班规则计算。此接口不是用户自定义 URL 的代理，不接受任意第三方数据源。

### 数据覆盖与故障处理

- `GET /api/v1/holiday-sources` 仅列出已实现且启用的来源。
- `GET /api/v1/holidays?source=CN_MAINLAND&year=2026` 返回年份、来源、同步时间、`available / stale / unavailable` 及日期记录；年份范围 2000–2100。
- 空白的未来年份文件（例如尚未发布公告的 2027 年）以及网络/格式错误不能证明该年无假期；界面明确显示“数据不可用，按排班估算”。
- Worker 保存原始文档年份的完整、经过校验的快照，单次原子替换；删除/更正的记录不会残留。失败保留上一份有效快照并标记旧数据；超过 48 小时未更新也标记旧数据。
- 下一年度文档可能包含上一年 12 月的安排，查询合并相邻文档，以更新的文档年份优先；没有可靠覆盖时不虚构假期。
- 每日 UTC 02:00 同步中国时区的去年、当年、次年。迁移后首次每分钟 Cron 会初始化一次，失败留待每日 Cron 重试，防止每分钟反复请求上游。
- 公共读取 API 不触发同步、不访问任意上游；首次初始化完成前页面明确降级。历史快照只包含曾成功同步过的文档年份。
- 开启节假日后，工作日提醒尊重次日假期、调休上班和节后返工；关闭时保留原先周日晚提醒行为。推送载荷仍只有 `type`。

### 升级与验证

先按原部署流程应用新增的 D1 migration `0003_holiday_snapshots.sql`，再发布 Worker 和前端。
首次 Cron 成功后检查上述年度 API 的 `status` 与 `synced_at`；不要把 migration 成功当作数据同步成功。
旧 `holiday_adjustments` 缺少来源年份和覆盖证据，不直接升级为有效快照，初始化前会明确按排班降级。
没有在此功能开发中执行任何生产迁移或发布。

新增 `npm run test:worker`：Node 22+ 下运行内存 SQLite 的迁移、年度 API、同步和提醒策略测试，不依赖浏览器或 Cloudflare 账号。
GitHub 可复用测试工作流运行该测试、两端检查/打包和现有 Web / 联合 Playwright 测试；不部署、不读取 Cloudflare secrets。Cloudflare 发布工作流直接依赖同一次测试成功，避免生产发布先于独立测试完成。

## 长期缓存与 PWA 离线访问

联网访问并完成一次 Service Worker 安装后，可在同一浏览器/已安装 PWA 中离线重新打开日历、倒计时与本地设置。
首次离线访问无法下载应用；未下载年份不会凭空获得假期数据。

- **假期数据**：本地 `localStorage` 保存版本化的公开来源目录及最多 12 个最近使用的来源/年份快照，缓存键包含完整 API base，切换后端不会混用数据。只保存经过校验的公开字段，拒绝非法日期、重复日期或未知 schema。
- **刷新**：先显示上次有效快照，再联网校验；页面可见时每 30 分钟刷新，恢复联网或回到页面时也会重试。HTTP/格式错误及未发布年份不会覆盖有效快照；未知年份不作永久负缓存。
- **状态**：离线显示“离线缓存”，重开后的待验证数据和失败/超过 48 小时的数据标旧，保留同步时间与来源。长期缓存不等于数据永久准确；浏览器可以清理缓存，空间不足时会缩减缓存并提示。
- **应用壳**：生产 build 自动生成内容哈希版本的 HTML、JS/CSS、图标和 manifest 白名单，全部成功下载才完成安装。离线 SPA 路由返回缓存入口；开发服务不预缓存模块。
- **更新**：新版本先完整安装，再等待旧页面全部关闭后接管；不强制重载、不丢弃正在编辑的设置。激活时只清理本应用旧壳缓存，保留通知配置及其他缓存。
- **边界**：Service Worker 不缓存 API、订阅、认证、POST、Turnstile 或跨来源响应；假期快照缓存与通知配置缓存独立。
- **离线操作**：通知注册/关闭/同步、延长区间等网络操作会禁用。排班可在本地修改；已注册用户的离线修改与“待同步”标记一并保存，联网重开也不会被旧服务端配置覆盖，需要手动同步。
- **关闭页面后**：不保证定时刷新；离线浏览也不代表能接收新的网络推送，网络可用性及系统通知权限仍有影响。

`npm run test:e2e:pwa` 使用真正的生产构建、Service Worker 和本地模拟 API，在桌面/移动浏览器验证离线重载、持久化假期、更新等待、失败安装、敏感请求不缓存、离线修改与存储故障。
测试不会访问生产 API。全部 PWA 测试已纳入发布前验证链路。
