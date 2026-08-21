#!/usr/bin/env bash
# 關閉 software factory 的完整相關服務（Backstage + DSH web）。
#
# 用法：./scripts/backstage/stop.sh
#
# 訊號策略：
#   - 一律先 SIGTERM（優雅關閉）。
#   - DSH web（7800）：只發 SIGTERM，**絕不 KILL**——DSH 的 session log 是 buffered
#     寫入，SIGKILL 會丟失未 flush 的記錄 → 下次載入報 corrupt session log
#     （seq gap，2026-08-21 實測教訓，docs/03 §7.2）。
#   - Backstage（3000/7007）：webpack graceful shutdown 需第二訊號；二次 TERM 後
#     仍不退出才 KILL（非 DSH，無 session log 風險）。
set -u

stop_port() {
  local port="$1"
  local pid
  pid=$(lsof -ti:"$port" 2>/dev/null || true)
  if [ -z "$pid" ]; then
    echo "  :${port} （未在運行）"
    return 0
  fi
  # lsof 可能回傳多個 pid——逐一 SIGTERM（bash 3.2 下全形字元前用 ${var} 界定）
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
  for port in 7800 3000 7007; do
    lsof -ti:"$port" >/dev/null 2>&1 && REMAIN="$REMAIN $port"
  done
  [ -z "$REMAIN" ] && break
  sleep 1
done

# 仍佔用的：DSH 再發一次 TERM（絕不 KILL）；Backstage 二次 TERM 後才 KILL
for port in 7800 3000 7007; do
  pid=$(lsof -ti:"$port" 2>/dev/null || true)
  [ -z "$pid" ] && continue
  if [ "$port" = "7800" ]; then
    for p in $pid; do
      kill -TERM "$p" 2>/dev/null
    done
    echo "  :${port}（DSH）二次 SIGTERM"
  else
    for p in $pid; do
      kill -TERM "$p" 2>/dev/null
    done
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
for port in 7800 3000 7007; do
  if lsof -ti:"$port" >/dev/null 2>&1; then
    echo "⚠️  :$port 仍佔用（需人工處理）"
    OK=0
  else
    echo "✅ :$port 已釋放"
  fi
done
[ "$OK" -eq 1 ] && echo "✔ 全部服務已停止" || echo "⚠️ 部分端口未釋放"
