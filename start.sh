#!/usr/bin/env bash
# 啟動 software factory 的完整相關服務（DSH web + Backstage），全部背景執行。
#
# 用法：./start.sh
#   - DSH web    : 背景啟動，http://localhost:7800（loopback，不對外暴露）
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
#
# DSH 0.1.2-alpha.4 的 web 有 launch-token 瀏覽器認證（SameSite=Strict、authority 綁定
# cookie）。Backstage 的 /dsh 頁面以 iframe 嵌入；iframe 用 http://localhost:7800
# （同 host 名 localhost）與 Backstage 頁面 http://localhost:3000 同 site，Strict cookie
# 才送得出——若 iframe 用 127.0.0.1 → 跨 site，必 401 "authentication required"。
# 注意：DSH 的 webserver host 只接受 127.0.0.1 | 0.0.0.0（不接受 localhost），
# 故仍綁 127.0.0.1；瀏覽器對 localhost 會同時嘗試 ::1 與 127.0.0.1（IPv4 fallback），
# 因此 http://localhost:7800 可達。iframe 的 tokenized URL 見下方 1b。
if lsof -ti:7800 >/dev/null 2>&1; then
  echo "✅ DSH web 已在 http://localhost:7800 運行"
else
  if [ ! -x "$DSH_BIN" ]; then
    echo "❌ 找不到 DSH：$DSH_BIN（需先在 software_factory 執行 npm ci）" >&2
    exit 1
  fi
  (cd "$REPO_DIR" && nohup "$DSH_BIN" --profile web --host 127.0.0.1 --port 7800 --no-open \
    > /tmp/dsh-web.log 2>&1 &)
  echo "▶️  DSH web 啟動（http://localhost:7800，log: /tmp/dsh-web.log）"
fi

# 1b. 寫 DSH 認證 URL 給 Backstage /dsh iframe 用（自助癒合，2026-09-02）。
# DSH 印出的 URL 寫死 127.0.0.1（localWebUrl），但 iframe 需要 localhost（同 site）；
# 且 launch token 每 process 隨機。故從 log 取出 URL、把 host 改為 localhost，
# 寫入 backstage-app 的 public 目錄（gitignored，內含 token 絕不可 commit），
# DshPage 讀取它作為 iframe src → 首次載入即完成 token 交換、種下 cookie。
DSH_URL_FILE="$APP_DIR/packages/app/public/dsh-web-url.txt"
for _ in $(seq 1 30); do
  if grep -q "dsh web: http" /tmp/dsh-web.log 2>/dev/null; then break; fi
  sleep 0.5
done
if grep -q "dsh web: http" /tmp/dsh-web.log 2>/dev/null; then
  URL=$(grep -o "dsh web: http://[^ ]*" /tmp/dsh-web.log | head -1 \
    | sed 's#^dsh web: ##; s#127\.0\.0\.1#localhost#')
  printf '%s' "$URL" > "$DSH_URL_FILE"
  echo "▶️  DSH 認證 URL 已寫入 $DSH_URL_FILE"
else
  echo "⚠️  DSH web 尚未輸出 URL（稍後檢查 /tmp/dsh-web.log；/dsh iframe 需此檔才能認證）"
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
echo "  - DSH web   : http://localhost:7800"
echo "  - DSH 嵌入  : http://localhost:3000/dsh（Backstage 內嵌頁面）"
echo "  - Backstage : http://localhost:3000"
echo "停止：./stop.sh"
