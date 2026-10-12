# Cloudflare 自动发布

工作流：`.github/workflows/cloudflare.yml`。沿用现有的 Worker + D1 + Pages 架构，不创建、替换数据库，也不修改现有 Worker secrets。

## 触发方式与安全边界

- 每次分支 push、面向 `main` 的 PR，以及手动运行都会调用同一份可复用测试工作流，检查前后端 lint、Web 构建、Worker dry-run、Worker/SQLite 测试和 Web / 联合 Playwright 测试，不使用 Cloudflare token。发布 job 直接依赖这次测试运行成功，不依赖另一个并行 workflow 的状态。
- 发布必须同时满足：上述检查通过、当前 ref 为 `refs/heads/main`、事件为 push 或手动运行，以及仓库变量 `CLOUDFLARE_DEPLOY_ENABLED` 为 `true`。
- PR、feature 分支 push、feature 分支手动运行、tag 均不会执行发布。不要改用 `pull_request_target`。
- 发布使用 GitHub `production` environment；请先设置环境保护与 secrets，再启用仓库级开关。仅合并本工作流不会在未开启开关时发布。
- 发布串行执行，不取消正在进行的迁移或发布。GitHub concurrency 不保证排队顺序；不要重跑已过期的历史提交，恢复时优先在最新 `main` 上手动运行。
- Actions 固定到完整 commit SHA；GitHub token 仅 `contents: read`，checkout 不保留凭据。发布 job 不恢复 npm cache，Cloudflare token 仅注入配置检查及实际发布步骤，不传给 npm 安装或 Web 构建。

## 一次性配置

在 GitHub 仓库 Settings → Environments 中创建 `production`：

1. Deployment branches and tags 限定只允许 `main` 分支。
2. 建议启用 Required reviewers、Prevent self-review，并关闭管理员绕过保护的选项（以仓库套餐支持为准）。这样每次上线仍须审核；若希望完全自动发布，可自行选择不要求 reviewer，但保留分支限制。
3. 添加下面的环境 secret / variables。密钥只在 GitHub / Cloudflare 的安全设置界面填写，不提交到仓库、日志或聊天。

| 类型 | 名称 | 值 |
| --- | --- | --- |
| Environment secret | `CLOUDFLARE_API_TOKEN` | 受限于现有 Cloudflare 账户的部署 token |
| Environment variable | `CLOUDFLARE_ACCOUNT_ID` | 现有 Worker、D1 和 Pages 所属的 Cloudflare Account ID |
| Environment variable | `CLOUDFLARE_PAGES_PROJECT` | 现有 Pages 项目名，当前为 `gap-weekend-alarm` |
| Environment variable | `VITE_API_BASE_URL` | 现有生产 Worker 的 HTTPS origin，不带路径或末尾 `/` |
| Environment variable | `VITE_TURNSTILE_SITE_KEY` | 现有生产 Turnstile widget 的公开 Site Key |
| **Repository variable** | `CLOUDFLARE_DEPLOY_ENABLED` | 完成配置后设为 `true`；留空或设为 `false` 禁止新发布 job |

开关必须是 **repository** variable（Settings → Secrets and variables → Actions → Variables），因为 job 条件判断发生在 environment variables 可用之前。关闭开关不会中止已经启动的发布。

### Cloudflare 前置条件

沿用已手动部署的资源，无需重新生成 VAPID 密钥：

- 核对 `apps/worker/wrangler.toml` 的 Worker 名称、D1 `database_id`、`VAPID_PUBLIC_KEY` 与生产环境一致。数据库迁移使用已配置的 `DB` binding，避免 README 旧命令中的数据库名歧义。
- Worker 已有 `VAPID_PRIVATE_KEY`、`VAPID_SUBJECT`、`TURNSTILE_SECRET` secrets。工作流不重新设置这些值；VAPID 私钥必须继续匹配已有公钥，否则可能影响现有订阅。
- `ALLOW_INSECURE_TURNSTILE_BYPASS` 保持 `"false"`，生产推送模式按现有配置为 `live`。
- Pages 项目必须已存在，且其 production branch 必须为 `main`。`--branch main` 只选择上传分支，不能替你修改项目的 production branch。不要依赖 CI 交互式创建项目。
- Turnstile widget 允许当前 Pages 域名及自定义域名。两个 `VITE_*` 值会公开写入前端 bundle，不能填入服务端 secret；GitHub 构建不会读取你电脑上的 `.env.production`，也不会读取 Pages 控制台中的构建变量。
- API token 需要所选账户下的 Workers Scripts Edit、D1 Edit、Cloudflare Pages Edit 权限；如 Wrangler 为当前部署配置提示缺少必要读取权限，再按具体错误最小化补充。当前使用 `workers.dev`，不需要为自定义 zone route 授予编辑权限。不要使用 Global API Key 或所有账户权限。
- 如之前启用了 Cloudflare 自带 Git 自动构建，确认不会与此工作流重复发布，再按自己的上线计划调整。

## 发布顺序

1. 无密钥 CI 的检查、构建及全部测试通过。
2. 等待 `production` 环境审批（如已配置），检查必要变量。
3. 使用 `npm ci` 和 lockfile 安装依赖；Node 22、Ubuntu 24.04 满足当前 Vite / Wrangler / workerd 运行要求。
4. 在 `apps/worker` 执行 `wrangler d1 migrations apply DB --remote`。CI 非交互模式自动确认迁移；审核上线时需同时审核 SQL。
5. `npm run deploy:worker` 发布 Worker。
6. 注入生产公开变量执行 `npm run build:web`。
7. `wrangler pages deploy apps/web/dist --project-name ... --branch main` 上传 Pages。

Wrangler 直接使用 `npm ci` 安装的锁定版本，不通过 `npx` 临时下载最新版。任何一步失败都停止后续步骤。首次合并前应先完成环境保护；开启开关后，`main` 后续 push 或 Actions → Cloudflare CI and deployment → Run workflow（选择 `main`）即可启动发布。

## 故障与恢复

- 缺少配置：发布在修改 Cloudflare 前失败。补齐 GitHub 设置后，从最新 `main` 重跑。
- lint / 构建失败：先修复代码再发布，不绕过 validate。该工作流运行浏览器端到端测试，但测试使用本地模拟推送，不代表线上推送链路已验证。
- 迁移失败：Worker 与 Pages 尚未发布；排查对应 SQL。D1 已成功执行的较早迁移不会因后续迁移失败全部撤销。
- Worker 发布失败：D1 迁移可能已完成；修复后重跑，已记录的迁移不会重复执行。
- Web 构建或 Pages 上传失败：Worker 可能已上线，旧前端仍在服务。修复后重跑；该流程不是跨服务原子事务，不做自动回滚。
- 数据库变更应采用兼容旧 Worker / 旧 Web 的增量迁移；破坏性迁移需要独立上线计划与备份。回滚 Worker/Pages 版本不能撤销 D1 数据变更。

首次正式运行后，应核对 Actions 日志、Cloudflare 当前版本及站点 API / 注册 / 推送行为。本次增加工作流不会替你生成凭据、改变生产配置或执行一次真实部署。

## 官方参考

- [Cloudflare Pages：CI Direct Upload](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/)
- [Cloudflare Workers：GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [D1 Wrangler 命令与迁移](https://developers.cloudflare.com/d1/wrangler-commands/)
- [GitHub：部署环境保护](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
- 固定版本：[checkout v6.0.2](https://github.com/actions/checkout/releases/tag/v6.0.2)、[setup-node v6.3.0](https://github.com/actions/setup-node/releases/tag/v6.3.0)
