#!/usr/bin/env bash
# [DEBUG-op55] 一次性診斷：用 #625 的實際內容（Issue + npm audit 報告）讓 Opus 5.5
# 以 factory 相同設定（headless + guardrail + effort=max）跑 N 次唯讀分析，
# 保留每次的 exit code、stdout、stderr，並把 `dsh: <CODE>:` 錯誤行（不含 reasoning）
# 印到 log，用來確認 run 36838600120 中 Opus 5.5 exit 1 的真實原因（拒答 or 429）。
#
# 用法：ANTHROPIC_API_KEY=... scripts/probe/opus-refusal-probe.sh [trials] [model]
set -uo pipefail
TRIALS=${1:-3}
MODEL=${2:-claude-opus-5-5}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${OUT:-/tmp/opus-refusal-probe}
mkdir -p "$OUT"

node "$ROOT/dist/cli/factory-dsh-patch.js" --provider anthropic --model "$MODEL" --effort max \
  --providers "$ROOT/config/dsh/settings.providers.yaml" --out "$OUT/model.patch.yml" > /dev/null

TASK='你是工廠 agent，正在處理 Issue（見 issue.md）。PR #621 的 CI 在 security job 的
`npm audit --audit-level=high` 失敗，完整報告見 audit-report.txt。請：
1) 讀這兩個檔案；2) 判斷根因分類（測試寫錯／程式行為錯誤／環境依賴版本／flaky）；
3) 列出要讓 audit 閘門轉綠所需的最小套件升版（套件、目前範圍、目標版本、對應 GHSA）；
4) 不要修改任何檔案，只輸出分析結論。'

for i in $(seq 1 "$TRIALS"); do
  W="$OUT/trial-$i"
  rm -rf "$W" && mkdir -p "$W/ws"
  cp "$ROOT/scripts/probe/opus-refusal-fixture/"* "$W/ws/"
  START=$(date +%s)
  (cd "$W/ws" && "$ROOT/node_modules/.bin/dsh" --profile headless \
    --patch "$ROOT/config/dsh/factory-guardrail.patch.yml" \
    --patch "$OUT/model.patch.yml" "$TASK" > "$W/stdout.txt" 2> "$W/stderr.txt")
  CODE=$?
  echo "trial=$i model=$MODEL exit=$CODE elapsed=$(( $(date +%s) - START ))s"
  echo "  dsh error lines:"
  grep -E '^dsh: [A-Z_]+:' "$W/stderr.txt" | sed 's/^/    /' || echo "    (none)"
done
