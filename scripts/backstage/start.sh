#!/usr/bin/env bash
# 啟動 software factory 的完整相關服務（Phase A1：Backstage 門戶 + DSH web）。
#
# 用法：./scripts/backstage/start.sh
#   - DSH web：背景啟動（127.0.0.1:7800，loopback 不對外暴露）
#   - Backstage：前景啟動（app :3000 + backend :7007），Ctrl+C 停止
#
# 前置：../backstage-app/.env 已存在（AUTH_GITHUB_CLIENT_ID/SECRET、GITHUB_TOKEN、BACKEND_SECRET）
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"        # software_factory
APP_DIR="$(cd "$REPO_DIR/.." && pwd)/backstage-app"    # ../backstage-app
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
  sleep 3
  lsof -ti:7800 >/dev/null 2>&1 && echo "✅ DSH web 就緒" || echo "⚠️  DSH web 可能未就緒（看 /tmp/dsh-web.log）"
fi

# 2. Backstage（前景）
echo "▶️  Backstage 啟動（app http://localhost:3000）——Ctrl+C 停止"
cd "$APP_DIR"
set -a && source .env && set +a
exec yarn start
