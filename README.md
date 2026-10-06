# 建平世纪中学非官方站 · 源码

学校非官方站的 Cloudflare Worker 源码。站点原名「清流中学非官方站」，仓库名 `qlzx-website` 沿用旧称。

三个 Worker 一套代码库，互不依赖，各自单独部署：

| 文件 | Worker 名 | 模块 |
| --- | --- | --- |
| `old-news-api.js` | `normal-welcomed-page` | 新闻聚合（HN 翻译 / 标注 / AI 抽检 / 搜索）、倒计时、临时云盘（分片存储，单文件上限 500MB）、上传风控、毕业留言墙、`/exam` 考试模式页 |
| `new-jpsj-website.js` | `jpc-normal-page` | 全站：学校简介、账号体系（注册 / 邮箱验证码 / 登录）、云盘、班费收支、毕业留言墙 |
| `exam-mode-web.js` | `exam-mode-web` | 独立考试模式，只保留考试期间需要的页面 |

写的是 Workers 的 `export default { fetch, scheduled }` 形式，没有构建步骤，改完直接部署。

## 部署

```bash
npx wrangler login      # 首次
./deploy.sh             # 三个全发
./deploy.sh old-news    # 只发新闻站
./deploy.sh jpsj        # 只发全站
./deploy.sh exam        # 只发考试模式
```

脚本用 `--keep-vars`，线上变量和密钥不会被仓库里的占位值覆盖。wrangler 的安装坑（npmmirror、跳过 optionalDependencies、锁版本）都写在 `deploy.sh` 头部注释里。

### 绑定

`*.toml` 里的 KV namespace id 和 D1 database id 是线上真实资源 ID，照抄即可。密钥不进仓库，用 `npx wrangler secret put` 或 Dashboard 配：

| 变量 | 用途 |
| --- | --- |
| `ADMIN_TOKEN` | 维护模式、风控解封等管理接口 |
| `JWT_SECRET` | 会话签名，64 位随机串 |
| `GITHUB_TOKEN` | 触发 GitHub Action 发验证码邮件，需要目标仓库 Actions: write |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | 仅 TG 推送存档用，见下 |

`wrangler.old-news.toml` 还挂了 Workers AI 绑定 `AI` 和 4 小时一次的 cron。

## 数据库

`migrations/*.sql` 按需在 D1 Console 执行：

- `init-accounts.sql` — 账号、会话
- `drive-chunks.sql` — 云盘分片
- `class-fund.sql` — 班费收支
- `graduation-wall.sql` — 毕业留言墙

## 其它

- `legacy/` — 旧版本留档：初代 worker `MainPage.js`、`showTime` 系列时间服务、Windows 桌面时钟客户端 `showTimeOnTop.py`、维护模式管理控制台。已被上面三个 Worker 取代，不再更新。
- `archive/tg-push.js` — Telegram 推送代码存档，2026-09-18 从新闻站摘出。文件头写了完整的恢复步骤。
