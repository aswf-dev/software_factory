#!/usr/bin/env bash
# 啟動 software factory 的完整相關服務（DSH web + Backstage），全部背景執行。
#
# 用法：./start.sh
#   - DSH web    : 背景啟動，127.0.0.1:7800（loopback，不對外暴露）
#   - Backstage  : 背景啟動，app :3000 + backend :7007（log: /tmp/backstage.log）
#
# 停止請執行 ./stop.sh（本腳本啟動的服務都在背景，不佔用終端）。
# 前置：../backstage-app/.env 已存在（AUTH_GITHUB_CLIENT_ID/SECRET、GITHUB_TOKEN、BACKEND_SECRET）
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"          # software_factory
APP_DIR="$(cd "$REPO_DIR/.." && pwd)/backstage-app" # ../backstage-app
DSH_BIN="$REPO_DIR/node_modules/.bin/dsh"

if [ ! -f "$APP_DIR/.env" ]; then
  echo "❌ 缺少 $APP_DIR/.env（需 AUTH_GITHUB_CLIENT_ID/SECRET、GITHUB_TOKEN、BACKEND_SECRET）" >&2
  exit 1
fi

# 1. DSH web（背景，綁定 loopback——不對外暴露）
if lsof -ti:7800 >/dev/null 2>&1; then
  echo "✅ DSH web 已在 127.0.0.1:7800 運行"
else
  if [ ! -x "$DSH_BIN" ]; then
    echo "❌ 找不到 DSH：$DSH_BIN（需先在 software_factory 執行 npm ci）" >&2
    exit 1
  fi
  (cd "$REPO_DIR" && nohup "$DSH_BIN" --profile web --host 127.0.0.1 --port 7800 --no-open \
    > /tmp/dsh-web.log 2>&1 &)
  echo "▶️  DSH web 啟動（127.0.0.1:7800，log: /tmp/dsh-web.log）"
fi

# 2. Backstage（背景）
if lsof -ti:3000 >/dev/null 2>&1 || lsof -ti:7007 >/dev/null 2>&1; then
  echo "✅ Backstage 已在運行（:3000 / :7007）"
else
  echo "▶️  Backstage 啟動（app http://localhost:3000，log: /tmp/backstage.log）"
  (cd "$APP_DIR" && set -a && source .env && set +a && nohup yarn start \
    > /tmp/backstage.log 2>&1 &)
fi

# 3. 等三秒後回報狀態
echo ""
echo "--- 服務狀態（3 秒後檢查）---"
sleep 3
for port in 7800 3000 7007; do
  if lsof -ti:"$port" >/dev/null 2>&1; then
    echo "✅ :$port LISTEN"
  else
    echo "⚠️  :$port 未就緒（看 log：/tmp/dsh-web.log、/tmp/backstage.log）"
  fi
done

echo ""
echo "✔ 啟動完成。入口："
echo "  - DSH web   : http://127.0.0.1:7800"
echo "  - Backstage : http://localhost:3000"
echo "停止：./stop.sh"
