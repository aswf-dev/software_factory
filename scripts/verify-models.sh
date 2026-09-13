#!/usr/bin/env bash
# verify-models.sh — 驗證 model-tiers.yaml 宣告的每個模型「真的叫得動」。
#
# 為什麼需要這支腳本（2026-09-11 實測教訓）：
#   repo 的單元／對抗性測試只驗證「config 與文件互相一致」，**無法**發現
#   「模型 id 根本不存在」或「pi-ai 不認得該 id」。PR #274 就是全綠卻讓整條
#   deepseek 路徑失效（誤用不存在的 `deepseek-v4.1-flash`，API 回 HTTP 400；
#   即使改對 id，`deepseek-flash` 不在 pi-ai 內建 catalog 仍會 UNKNOWN_MODEL）。
#   靜態測試抓不到的，只能靠真的打一次 API。
#
# 驗證分層（後者不是前者的必然結果，兩層都要跑）：
#   L1 Provider API — 模型 id 在供應商端存在且能推論（curl，僅 deepseek 支援）
#   L2 DSH 執行層   — pi-ai 認得該 id 且能完成一次 headless 推論（決定性關卡）
#
# 用法：
#   ./scripts/verify-models.sh                 # 驗證 model-tiers.yaml 的所有模型
#   ./scripts/verify-models.sh deepseek        # 只驗證指定 provider
#   REF=origin/main ./scripts/verify-models.sh # 驗證「線上那份」設定而非工作區
#
# credential：從環境變數或 repo 根的 .env 讀取（DEEPSEEK_API_KEY /
# ANTHROPIC_API_KEY / QWEN_API_KEY）。缺 key 的 provider 標 SKIP 而非失敗——
# 缺 credential 是環境問題，不是模型問題，混為一談會讓紅燈失去意義。
#
# 成本：每個模型一次極短推論（數十 token），可忽略。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SF_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SF_ROOT"

ONLY_PROVIDER="${1:-}"
REF="${REF:-}"

# 載入 .env（僅補齊未設定者，不覆蓋既有環境變數）
if [ -f .env ]; then
  while IFS='=' read -r k v; do
    case "$k" in DEEPSEEK_API_KEY|ANTHROPIC_API_KEY|QWEN_API_KEY)
      [ -z "${!k:-}" ] && export "$k=$v" ;;
    esac
  done < <(grep -E '^(DEEPSEEK|ANTHROPIC|QWEN)_API_KEY=' .env 2>/dev/null || true)
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/home"

# 取得待驗設定：預設用工作區，REF 指定時用該 git ref（驗證「線上實際生效」的那份）
if [ -n "$REF" ]; then
  echo "設定來源：git ref $REF"
  git show "$REF:config/dsh/settings.providers.yaml" > "$WORK/providers.yaml"
  git show "$REF:config/dsh/model-tiers.yaml" > "$WORK/tiers.yaml"
else
  echo "設定來源：工作區（如需驗證線上版本請用 REF=origin/main）"
  cp config/dsh/settings.providers.yaml "$WORK/providers.yaml"
  cp config/dsh/model-tiers.yaml "$WORK/tiers.yaml"
fi

command -v jq >/dev/null || { echo "錯誤：需要 jq" >&2; exit 1; }
[ -f dist/cli/factory-model.js ] || { echo "建置 dist（factory-model CLI）…"; npm run build >/dev/null; }

# tier chain 的聯集 = 實際可能被路由到的所有模型（去重、保持順序）
MODELS="$(
  for T in low medium high critical; do
    node dist/cli/factory-model.js --tier "$T" \
      --tiers "$WORK/tiers.yaml" --providers "$WORK/providers.yaml" 2>/dev/null \
      | jq -r '.chain[] | "\(.provider) \(.model) \(.reasoningEffort // "-")"'
  done | awk '!seen[$0]++'
)"

[ -n "$MODELS" ] || { echo "錯誤：解析不到任何模型（設定損壞？）" >&2; exit 1; }

printf '\n%-11s %-24s %-7s %-8s %-8s %s\n' PROVIDER MODEL EFFORT L1-API L2-DSH NOTE
printf '%.0s-' {1..82}; printf '\n'

FAIL=0
# reasoningEffort 也要帶進驗證：模型「叫得動」不代表「以設定的 effort 叫得動」
# （opus-5 只接受 off/xhigh/max，填 high 會 UNSUPPORTED_REASONING_EFFORT）。
# 若這裡不帶，驗的就不是 production 實際會送出的那組設定。
while read -r P M EFFORT; do
  [ -n "$ONLY_PROVIDER" ] && [ "$P" != "$ONLY_PROVIDER" ] && continue

  case "$P" in
    deepseek)  KEY="${DEEPSEEK_API_KEY:-}" ;;
    anthropic) KEY="${ANTHROPIC_API_KEY:-}" ;;
    qwen)      KEY="${QWEN_API_KEY:-}" ;;
    *)         KEY="" ;;
  esac

  if [ -z "$KEY" ]; then
    printf '%-11s %-24s %-7s %-8s %-8s %s\n' "$P" "$M" "$EFFORT" SKIP SKIP "無 credential（非模型問題）"
    continue
  fi

  # L1：只有 deepseek 有穩定的 OpenAI 相容 /models 可查；其餘標 n/a 不臆測
  L1="n/a"
  if [ "$P" = "deepseek" ]; then
    if curl -sf -m 30 -H "Authorization: Bearer $KEY" https://api.deepseek.com/models \
        | jq -e --arg m "$M" '.data[]? | select(.id == $m)' >/dev/null 2>&1; then
      L1="OK"
    else
      L1="FAIL"
    fi
  fi

  # L2：以 repo 實際 providers 設定 + agent-default-model 跑一次 headless 推論。
  #     這是決定性關卡——L1 過不代表 L2 過（pi-ai catalog 可能沒有該 id）。
  cp "$WORK/providers.yaml" "$WORK/home/settings.yaml"
  {
    printf 'agent-default-model:\n  provider: %s\n  model: %s\n' "$P" "$M"
    # 與 factory-run.yml 寫 settings 的方式一致（僅在 chain 宣告 effort 時才寫）
    [ "$EFFORT" != "-" ] && printf '  reasoningEffort: %s\n' "$EFFORT"
  } >> "$WORK/home/settings.yaml"
  OUT="$(DSH_HOME="$WORK/home" npx dsh --profile headless 'Reply with exactly: PING' 2>&1)"
  if printf '%s' "$OUT" | grep -q 'PING'; then
    L2="OK"; NOTE=""
  else
    L2="FAIL"
    NOTE="$(printf '%s' "$OUT" | grep -oE '(UNKNOWN_MODEL|UNSUPPORTED_REASONING_EFFORT|MISSING_CREDENTIAL|AUTH|RATE_LIMIT|INVALID_CONFIG)[^\"]*' | head -1)"
    [ -z "$NOTE" ] && NOTE="$(printf '%s' "$OUT" | tail -1 | cut -c1-40)"
  fi

  [ "$L1" = "FAIL" ] && FAIL=1
  [ "$L2" = "FAIL" ] && FAIL=1
  printf '%-11s %-24s %-7s %-8s %-8s %s\n' "$P" "$M" "$EFFORT" "$L1" "$L2" "$NOTE"
done <<< "$MODELS"

printf '\n'
if [ "$FAIL" -eq 0 ]; then
  echo "✅ 所有具備 credential 的模型都可正確呼叫"
else
  echo "❌ 有模型無法呼叫——上表 FAIL 欄的 NOTE 是 DSH/API 回報的原因" >&2
fi
exit "$FAIL"
