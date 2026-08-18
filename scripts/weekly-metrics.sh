#!/usr/bin/env bash
# 週檢：缺陷標籤 + 產出型指標（docs/14 §2.1, docs/08 §7, Phase 2 T5）。
# 用法：./scripts/weekly-metrics.sh [repo（預設 GH_REPO 或目前 origin）] [limit]
set -euo pipefail
REPO="${1:-}"
LIMIT="${2:-100}"
GH_ARGS=()
[ -n "$REPO" ] && GH_ARGS+=(-R "$REPO")

echo "== 缺陷標籤（defect/escape, defect/review；docs/14） =="
gh issue list --label defect/escape --state all --json number,title --limit 20 "${GH_ARGS[@]}"
gh issue list --label defect/review --state all --json number,title --limit 20 "${GH_ARGS[@]}"

echo ""
echo "== 產出型指標（factory-metrics，docs/08 §2） =="
npm run build >/dev/null
node dist/cli/factory-metrics.js "${LIMIT}"
