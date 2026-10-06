#!/usr/bin/env bash
# ============================================================
# 建平世纪站 · Cloudflare Worker 自动部署脚本
# 用法: ./deploy.sh [old-news|jpsj|exam|all]
#   old-news -> old-news-api.js     -> normal-welcomed-page (新闻推送, cron 0 */4)
#   jpsj     -> new-jpsj-website.js -> jpc-normal-page       (建平世纪全站)
#   exam     -> exam-mode-web.js    -> exam-mode-web         (独立考试模式, /exam 那份在 old-news 里)
# --keep-vars 保留线上变量/密钥，只推代码
# 需要已登录: npx wrangler login
# ============================================================

set -euo pipefail
cd "$(dirname "$0")"

# 两个 wrangler 安装坑（2026-09-18 实测，npmmirror registry）：
# 1) 跳过 optionalDependencies：workerd 的平台包在镜像上版本号为空，
#    npm arborist 直接报 "Invalid Version: " 挂掉。部署不需要 workerd 二进制
#    （那是 wrangler dev 本地模拟器才用的）。
# 2) 版本号写死：不带版本号的 `npx wrangler` 会现装 latest，而装好的缓存在
#    npm 里是按 `wrangler@<版本>` 记的，于是每次都可能重装再挂。升级时改这里。
export npm_config_omit=optional
# 3) 走 npmmirror：registry.npmjs.org 直连取 wrangler 元数据要 7s+ 且经常卡死，
#    镜像 2~3s 就回来。已显式设过 registry 的不覆盖。
export npm_config_registry="${npm_config_registry:-https://registry.npmmirror.com}"
WRANGLER="npx --yes wrangler@4.134.0"

deploy() {
  local name=$1
  case "$name" in
    old-news) config="wrangler.old-news.toml" ;;
    jpsj)     config="wrangler.jpsj.toml" ;;
    exam)     config="wrangler.exam.toml" ;;
    *) echo "未知目标: $name"; exit 1 ;;
  esac
  echo "→ 部署 $name ($config)"
  $WRANGLER deploy -c "$config" --keep-vars
  echo "✓ $name 完成"
}

case "${1:-all}" in
  old-news) deploy old-news ;;
  jpsj)     deploy jpsj ;;
  exam)     deploy exam ;;
  all)      deploy old-news; deploy jpsj; deploy exam ;;
  *) echo "用法: ./deploy.sh [old-news|jpsj|exam|all]"; exit 1 ;;
esac
