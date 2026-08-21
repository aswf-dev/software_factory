#!/usr/bin/env bash
# 關閉 software factory 的完整相關服務（Backstage + DSH web）。
#
# 用法：./stop.sh
#
# 訊號策略（沿用 scripts/backstage/stop.sh 的踩坑教訓）：
#   - 一律先 SIGTERM（優雅關閉）。
#   - DSH web（7800）：只發 SIGTERM，**絕不 KILL**——DSH 的 session log 是 buffered
#     寫入，SIGKILL 會丟失未 flush 的記錄 → 下次載入報 corrupt session log
#     （seq gap，2026-08-21 實測教訓，docs/03 §7.2）。
#   - Backstage（3000/7007）：webpack graceful shutdown 需第二訊號；二次 TERM 後
#     仍不退出才 KILL（非 DSH，無 session log 風險）。
#
# 註：macOS bash 3.2 的 `set -u` 對 `$var` 後緊接全形字元的解析有坑
#     （UTF-8 首 byte 被誤當變數名）——因此所有變數一律以 ${var} 界定。
set -u

PORTS="7800 3000 7007"

stop_port() {
  local port="$1"
  local pid
  pid=$(lsof -ti:"$port" 2>/dev/null || true)
  if [ -z "$pid" ]; then
    echo "  :${port} （未在運行）"
    return 0
  fi
  # lsof 可能回傳多個 pid（多 process 綁同一 port）——逐一 SIGTERM
  for p in $pid; do
    kill -TERM "$p" 2>/dev/null && echo "  :${port} 已發 SIGTERM（pid ${p}）"
  done
}

echo "▸ 停止 DSH web（127.0.0.1:7800）..."
stop_port 7800

echo "▸ 停止 Backstage（app :3000 / backend :7007）..."
stop_port 3000
stop_port 7007

echo "▸ 等待釋放（最多 12 秒）..."
for i in $(seq 1 12); do
  REMAIN=""
  for port in $PORTS; do
    lsof -ti:"$port" >/dev/null 2>&1 && REMAIN="$REMAIN $port"
  done
  [ -z "$REMAIN" ] && break
  sleep 1
done

# 仍佔用的：DSH 再發一次 TERM（絕不 KILL）；Backstage 二次 TERM 後才 KILL
for port in $PORTS; do
  pid=$(lsof -ti:"$port" 2>/dev/null || true)
  [ -z "$pid" ] && continue
  for p in $pid; do
    if [ "$port" = "7800" ]; then
      kill -TERM "$p" 2>/dev/null
      echo "  :${port}（DSH）二次 SIGTERM（pid ${p}）"
    else
      kill -TERM "$p" 2>/dev/null
    fi
  done
  if [ "$port" != "7800" ]; then
    sleep 3
    pid=$(lsof -ti:"$port" 2>/dev/null || true)
    if [ -n "$pid" ]; then
      for p in $pid; do
        kill -KILL "$p" 2>/dev/null
      done
      echo "  :${port}（Backstage）二次 TERM 後仍佔用 → KILL"
    fi
  fi
done
sleep 2

OK=1
for port in $PORTS; do
  if lsof -ti:"$port" >/dev/null 2>&1; then
    echo "⚠️  :${port} 仍佔用（需人工處理）"
    OK=0
  else
    echo "✅ :${port} 已釋放"
  fi
done
[ "$OK" -eq 1 ] && echo "✔ 全部服務已停止" || echo "⚠️ 部分端口未釋放"
