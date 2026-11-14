#!/usr/bin/env bash
# 啟動 software factory 的完整相關服務（DSH web + Backstage），全部背景執行。
#
# 用法：./start.sh
#   - DSH web    : 背景啟動，127.0.0.1:7800；經 Cloudflare Tunnel 對外為
#                  https://dsh.aswf.dev/（tunnel 本身由外部管理，本腳本只負責讓 DSH
#                  接受這個 authority，並印出可用的認證網址）
#   - Backstage  : 背景啟動，app :3000 + backend :7007（log: /tmp/backstage.log）
#
# 停止請執行 ./stop.sh（本腳本啟動的服務都在背景，不佔用終端）。
# 前置：../backstage-app/.env 已存在（AUTH_GITHUB_CLIENT_ID/SECRET、GITHUB_TOKEN、BACKEND_SECRET）
#
# 環境變數（都可省略，用預設值即可）：
#   DSH_PUBLIC_URL    對外根網址（預設 https://dsh.aswf.dev/）
#   DSH_TRUSTED_HOST  額外接受的 authority，空白分隔可多個（預設取 DSH_PUBLIC_URL 的 host）
#   DSH_PORT          本機監聽埠（預設 7800）
#   DSH_RESTART=1     即使已在運行也強制重啟（預設：參數不符才重啟）
#
# 為什麼要 --public-url 與 --trusted-host：
#   DSH 的瀏覽器 API 前有一道 Host/Origin fence，只接受 loopback、listener 綁定的位址，
#   以及 --trusted-host 指定的 authority。Cloudflare Tunnel 送進來的 Host 是
#   dsh.aswf.dev，沒帶 --trusted-host 時頁面載得出來、但每一個 /api 請求都 403
#   （症狀：畫面空白／一直轉圈，DevTools 裡一整排 403）。
#   launch token 又是每個 process 隨機、cookie 綁定 authority，所以遠端必須拿到
#   https://dsh.aswf.dev/?token=... 才能完成交換；--public-url 才會讓 DSH 印出這組
#   公開網址（不帶時只印 http://127.0.0.1:7800/?token=...，對遠端使用者沒有用）。
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"             # software_factory
APP_DIR="$(cd "${REPO_DIR}/.." && pwd)/backstage-app"  # ../backstage-app
DSH_BIN="${REPO_DIR}/node_modules/.bin/dsh"
DSH_LOG="/tmp/dsh-web.log"

DSH_PORT="${DSH_PORT:-7800}"
DSH_PUBLIC_URL="${DSH_PUBLIC_URL:-https://dsh.aswf.dev/}"
DSH_PUBLIC_HOST="$(printf '%s' "${DSH_PUBLIC_URL}" \
  | sed -e 's#^[A-Za-z][A-Za-z0-9+.-]*://##' -e 's#/.*##')"
DSH_TRUSTED_HOST="${DSH_TRUSTED_HOST:-${DSH_PUBLIC_HOST}}"

# bash 3.2（macOS 內建）搭配 set -u 時，空陣列的 "${arr[@]}" 會炸；下面用 + 的形式展開。
TRUSTED_ARGS=()
for _host in ${DSH_TRUSTED_HOST}; do
  TRUSTED_ARGS+=(--trusted-host "${_host}")
done

# ./start.sh --mint-cookie
#   用目前 DSH 行程的 launch token 換一顆綁定 ${DSH_PUBLIC_HOST} 的長效 session cookie，
#   stdout 只輸出 `name=value`（給 Cloudflare Worker 的 DSH_COOKIE secret 用），其他訊息走 stderr：
#     ./start.sh --mint-cookie | npx wrangler secret put DSH_COOKIE
#   cookie 由 ~/.dsh/.credentials.yaml 的持久密鑰簽章，DSH 重啟後仍有效；
#   效期由 profile 的 connection.cookieMaxAgeDays 決定（已設 3650 天）。
#   刪除該 credential 記錄並重啟 DSH 即可讓所有 cookie 失效（之後要重新 mint）。
if [ "${1:-}" = "--mint-cookie" ]; then
  _url="$(grep -oE 'dsh web: https?://[^ ]*' "${DSH_LOG}" 2>/dev/null | head -1 || true)"
  if ! lsof -ti:"${DSH_PORT}" >/dev/null 2>&1 || [ -z "${_url}" ]; then
    echo "❌ DSH web 沒在 :${DSH_PORT} 運行，或 ${DSH_LOG} 找不到 token；先執行 ./start.sh" >&2
    exit 1
  fi
  _cookie="$(curl -sS -D - -o /dev/null -m 10 -H "Host: ${DSH_PUBLIC_HOST}" \
      "http://127.0.0.1:${DSH_PORT}/?token=${_url##*token=}" \
    | awk -F': ' 'tolower($1)=="set-cookie"{print $2}' | head -1 | cut -d';' -f1 | tr -d '\r')"
  if [ -z "${_cookie}" ]; then
    echo "❌ token 交換沒有回 Set-Cookie（token 可能已過期，重跑 ./start.sh 再試）" >&2
    exit 1
  fi
  _code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 -H "Host: ${DSH_PUBLIC_HOST}" \
    -H "Cookie: ${_cookie}" "http://127.0.0.1:${DSH_PORT}/")"
  if [ "${_code}" != "200" ]; then
    echo "❌ 新 cookie 自我驗證失敗（HTTP ${_code}）" >&2
    exit 1
  fi
  echo "✅ 已 mint 綁定 ${DSH_PUBLIC_HOST} 的 cookie（自我驗證 200）；請當成密碼保管" >&2
  printf '%s\n' "${_cookie}"
  exit 0
fi

if [ ! -f "${APP_DIR}/.env" ]; then
  echo "❌ 缺少 ${APP_DIR}/.env（需 AUTH_GITHUB_CLIENT_ID/SECRET、GITHUB_TOKEN、BACKEND_SECRET）" >&2
  exit 1
fi

dsh_running() { lsof -ti:"${DSH_PORT}" >/dev/null 2>&1; }

# DSH 啟動時印的認證 URL（帶 --public-url 時就是對外網址）
dsh_log_url() { grep -oE 'dsh web: https?://[^ ]*' "${DSH_LOG}" 2>/dev/null | head -1; }

# 用對外 Host 打 /api：403 = fence 不接受這個 authority；401 = 通過 fence、只差 cookie。
fence_accepts_public_host() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 \
    -H "Host: ${DSH_PUBLIC_HOST}" "http://127.0.0.1:${DSH_PORT}/api" 2>/dev/null || true)"
  [ "${code}" = "401" ]
}

# DSH 的 session log 是 buffered 寫入，只送 SIGTERM、絕不 SIGKILL。
stop_dsh() {
  local pids p
  pids="$(lsof -ti:"${DSH_PORT}" 2>/dev/null || true)"
  [ -z "${pids}" ] && return 0
  for p in ${pids}; do
    kill -TERM "${p}" 2>/dev/null || true
  done
  for _ in $(seq 1 40); do
    dsh_running || return 0
    sleep 0.5
  done
  return 1
}

# 1. DSH web（背景，綁 loopback；對外由 Cloudflare Tunnel 代理進來）
#
# 綁 127.0.0.1 的理由：cloudflared 從本機連入，不需要對 LAN 開 port。瀏覽器用
# http://localhost:7800 一樣可達（loopback 的 Host 本來就被 fence 接受），Backstage
# 的 /dsh 頁面也是用 localhost 嵌 iframe（同 site 才送得出 SameSite=Strict cookie）。
NEED_RESTART=0
RESTART_REASON=""
if dsh_running; then
  if [ "${DSH_RESTART:-0}" = "1" ]; then
    NEED_RESTART=1
    RESTART_REASON="DSH_RESTART=1（強制重啟）"
  elif ! fence_accepts_public_host; then
    NEED_RESTART=1
    RESTART_REASON="既有行程未接受 ${DSH_PUBLIC_HOST}（缺 --trusted-host）→ /api 全部 403"
  elif [ -z "$(dsh_log_url || true)" ]; then
    NEED_RESTART=1
    RESTART_REASON="既有行程的 log 找不到 token URL（${DSH_LOG}）"
  else
    echo "✅ DSH web 已在 http://127.0.0.1:${DSH_PORT} 運行，且已接受 ${DSH_PUBLIC_HOST}"
  fi
fi

if [ "${NEED_RESTART}" = "1" ]; then
  echo "♻️  重啟 DSH web：${RESTART_REASON}"
  if ! stop_dsh; then
    echo "❌ 埠 ${DSH_PORT} 在 20 秒內未釋放。" >&2
    echo "   DSH 的 session log 是 buffered 寫入，本腳本不對它送 SIGKILL；請先執行 ./stop.sh 再重跑。" >&2
    exit 1
  fi
fi

if ! dsh_running; then
  if [ ! -x "${DSH_BIN}" ]; then
    echo "❌ 找不到 DSH：${DSH_BIN}（需先在 software_factory 執行 npm ci）" >&2
    exit 1
  fi
  : > "${DSH_LOG}"
  (
    cd "${REPO_DIR}"
    nohup "${DSH_BIN}" --profile web \
      --host 127.0.0.1 --port "${DSH_PORT}" --no-open \
      --public-url "${DSH_PUBLIC_URL}" \
      ${TRUSTED_ARGS[@]+"${TRUSTED_ARGS[@]}"} \
      > "${DSH_LOG}" 2>&1 &
  )
  echo "▶️  DSH web 啟動（本機 http://127.0.0.1:${DSH_PORT}，對外 ${DSH_PUBLIC_URL}，log: ${DSH_LOG}）"
fi

# 2. 從 log 取出 launch token，寫出兩份認證 URL
#    - Backstage iframe：必須是 http://localhost:${DSH_PORT}（與 :3000 同 site，
#      SameSite=Strict 的 cookie 才送得出去；換成 127.0.0.1 會變跨 site → 401）
#      → 寫入 backstage-app 的 public 目錄（gitignored，內含 token 絕不可 commit）
#    - 遠端／手機：公開網址，寫到 0600 的檔案，避免 token 在 /tmp 被同機他人讀走
for _ in $(seq 1 40); do
  [ -n "$(dsh_log_url || true)" ] && break
  sleep 0.5
done

URL_LINE="$(dsh_log_url || true)"
TOKEN=""
if [ -n "${URL_LINE}" ]; then
  TOKEN="${URL_LINE##*token=}"
fi

DSH_URL_FILE="${APP_DIR}/packages/app/public/dsh-web-url.txt"
PUBLIC_URL_FILE="/tmp/dsh-public-url.txt"
if [ -n "${TOKEN}" ]; then
  mkdir -p "$(dirname "${DSH_URL_FILE}")"
  printf '%s' "http://localhost:${DSH_PORT}/?token=${TOKEN}" > "${DSH_URL_FILE}"
  echo "▶️  Backstage iframe 認證 URL 已寫入 ${DSH_URL_FILE}"

  ( umask 077; printf '%s' "${DSH_PUBLIC_URL%/}/?token=${TOKEN}" > "${PUBLIC_URL_FILE}" )
  echo "▶️  對外認證 URL 已寫入 ${PUBLIC_URL_FILE}（僅本機可讀）"

  # DSH 端驗證：以對外 authority（Host: ${DSH_PUBLIC_HOST}）在本機走一次 token → cookie → 200。
  # 不能從公網驗：Access 會先把 curl 轉去登入頁，-L 跟過去拿到的 200 是登入頁，不是 DSH。
  if command -v curl >/dev/null 2>&1; then
    _cookie="$(curl -s -D - -o /dev/null -m 10 -H "Host: ${DSH_PUBLIC_HOST}" \
        "http://127.0.0.1:${DSH_PORT}/?token=${TOKEN}" 2>/dev/null \
      | awk -F': ' 'tolower($1)=="set-cookie"{print $2}' | head -1 | cut -d';' -f1 | tr -d '\r' || true)"
    AUTH_CODE="000"
    if [ -n "${_cookie}" ]; then
      AUTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 10 -H "Host: ${DSH_PUBLIC_HOST}" \
        -H "Cookie: ${_cookie}" "http://127.0.0.1:${DSH_PORT}/" 2>/dev/null || true)"
    fi
    _cookie=""
    case "${AUTH_CODE}" in
      200) echo "✅ DSH 接受 ${DSH_PUBLIC_HOST} 的 token → cookie 流程（Worker 注入的 cookie 也走這條）" ;;
      *)   echo "⚠️  DSH 對 ${DSH_PUBLIC_HOST} 的 token → cookie 流程失敗（HTTP ${AUTH_CODE}，看 ${DSH_LOG}）" ;;
    esac
  fi
else
  echo "⚠️  尚未取得 launch token（看 ${DSH_LOG}；Backstage iframe 與遠端登入都會失敗）"
fi

# 3. Backstage（背景）
if lsof -ti:3000 >/dev/null 2>&1 || lsof -ti:7007 >/dev/null 2>&1; then
  echo "✅ Backstage 已在運行（:3000 / :7007）"
else
  echo "▶️  Backstage 啟動（app http://localhost:3000，log: /tmp/backstage.log）"
  (cd "${APP_DIR}" && set -a && source .env && set +a && nohup yarn start \
    > /tmp/backstage.log 2>&1 &)
fi

# 4. 等三秒後回報狀態
echo ""
echo "--- 服務狀態（3 秒後檢查）---"
sleep 3
for port in "${DSH_PORT}" 3000 7007; do
  if lsof -ti:"${port}" >/dev/null 2>&1; then
    echo "✅ :${port} LISTEN"
  else
    echo "⚠️  :${port} 未就緒（看 log：/tmp/dsh-web.log、/tmp/backstage.log）"
  fi
done

# 5. 對外連通檢查（經過 Cloudflare Tunnel）
echo ""
echo "--- 對外檢查（Cloudflare Tunnel + Access）---"
# start.sh 不負責啟動 tunnel；建議以 `sudo cloudflared service install <token>` 裝成系統服務。
if pgrep -x cloudflared >/dev/null 2>&1; then
  echo "✅ cloudflared 正在執行"
else
  echo "⚠️  本機沒有 cloudflared 行程：${DSH_PUBLIC_URL} 會連不到（請啟動 tunnel）"
fi
if command -v curl >/dev/null 2>&1; then
  PUB_OUT="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -m 8 "${DSH_PUBLIC_URL}" 2>/dev/null || true)"
  PUB_CODE="${PUB_OUT%% *}"
  PUB_REDIRECT="${PUB_OUT#* }"
  case "${PUB_CODE}" in
    302|303)
      case "${PUB_REDIRECT}" in
        https://*.cloudflareaccess.com/*) echo "✅ ${DSH_PUBLIC_URL} 由 Cloudflare Access 保護（未登入 → 轉至 Access 登入頁）" ;;
        *) echo "⚠️  ${DSH_PUBLIC_URL} 轉址到非預期位置：${PUB_REDIRECT}" ;;
      esac ;;
    401) echo "⚠️  ${DSH_PUBLIC_URL} 直達 DSH、沒有 Access 保護（只剩 DSH token 擋著）" ;;
    403) echo "⚠️  ${DSH_PUBLIC_URL} 回 403：fence 沒接受這個 authority（檢查 --trusted-host，或 tunnel 改寫了 Host）" ;;
    200) echo "🚨 ${DSH_PUBLIC_URL} 未登入就回 200：任何人都能操作 DSH！立刻檢查 Access application 與 Worker" ;;
    000|"") echo "⚠️  ${DSH_PUBLIC_URL} 連不上：確認 cloudflared tunnel 正在執行" ;;
    *)   echo "⚠️  ${DSH_PUBLIC_URL} 回 HTTP ${PUB_CODE}（檢查 tunnel / Access / WAF 設定）" ;;
  esac
else
  echo "（略過：找不到 curl）"
fi

echo ""
echo "✔ 啟動完成。入口："
echo "  - DSH web（本機） : http://localhost:${DSH_PORT}"
echo "  - DSH web（對外） : ${DSH_PUBLIC_URL}（Access 登入後由 Worker 注入 cookie，不需要 token）"
if [ -s "${PUBLIC_URL_FILE}" ]; then
  echo "      備援：Worker 失效時，Access 登入後改開 ${PUBLIC_URL_FILE} 裡的 token 網址"
fi
echo "  - DSH 嵌入        : http://localhost:3000/dsh（Backstage 內嵌頁面）"
echo "  - Backstage       : http://localhost:3000"
echo "停止：./stop.sh"
