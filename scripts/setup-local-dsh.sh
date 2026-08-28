#!/usr/bin/env bash
# setup-local-dsh.sh — 本機 DSH 一次性設定（ADR-012：skills 共享 root）。
#
# 目的：把本機 DSH（GUI / headless session）的 `skill-filesystem.customSkillDirs`
# 指向「本 software_factory checkout」的 `.dsh/skills`——factory skills 的單一事實
# 來源在機制 repo，目標 repo 不再持有副本；本機端靠此設定載入共享 skills。
#
# 可攜性（雲端 VM / 換機器）：
#   - 以本檔自身位置推導絕對路徑（`dirname BASH_SOURCE`），任何目錄佈局皆可用；
#   - 在目標機器上只需：git clone software_factory → 執行本腳本（一條指令重現）。
#
# 用法：
#   ./scripts/setup-local-dsh.sh
#
# 冪等：重複執行只會更新路徑，不會重複追加；`~/.dsh/settings.yaml` 其他節區
# （如 llm-pi-ai）與註解保留。修改前會備份（settings.yaml.bak.<ts>）。
set -euo pipefail

# 1) 以本檔位置推導 software_factory checkout 根與共享 skills 目錄（絕對路徑）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SF_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILLS_DIR="$SF_ROOT/.dsh/skills"

if [ ! -d "$SKILLS_DIR" ]; then
  echo "錯誤：找不到 $SKILLS_DIR——請在 software_factory checkout 內執行本腳本" >&2
  exit 1
fi

# 2) 目標設定檔：$DSH_HOME/settings.yaml（預設 ~/.dsh/settings.yaml，與 factory-run
#    的 CI 設定同一個 home 慣例）
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
SETTINGS="$DSH_HOME/settings.yaml"
mkdir -p "$DSH_HOME"

# 3) 冪等合併 skill-filesystem.customSkillDirs
#    節區存在 → awk 以整節替換（保留其他節區與註解）；不存在 → 檔案尾端追加。
if [ -f "$SETTINGS" ] && grep -q '^skill-filesystem:' "$SETTINGS"; then
  cp "$SETTINGS" "$SETTINGS.bak.$(date +%Y%m%d%H%M%S)"
  awk -v skills="$SKILLS_DIR" '
    /^skill-filesystem:/ {
      print "skill-filesystem:"
      print "  customSkillDirs:"
      printf "    - %s\n", skills
      inblock = 1
      next
    }
    inblock && /^[^[:space:]]/ { inblock = 0 }
    inblock { next }
    { print }
  ' "$SETTINGS" > "$SETTINGS.tmp"
  chmod 600 "$SETTINGS.tmp"
  mv "$SETTINGS.tmp" "$SETTINGS"
else
  if [ -f "$SETTINGS" ]; then
    printf '\nskill-filesystem:\n  customSkillDirs:\n    - %s\n' "$SKILLS_DIR" >> "$SETTINGS"
  else
    printf 'skill-filesystem:\n  customSkillDirs:\n    - %s\n' "$SKILLS_DIR" > "$SETTINGS"
  fi
  chmod 600 "$SETTINGS"
fi

echo "完成：skill-filesystem.customSkillDirs -> $SKILLS_DIR"
echo "設定檔：$SETTINGS"
echo
echo "驗證：重新開啟 DSH session 後，skill 目錄應可見："
echo "  factory-workflow / factory-stop-rules / factory-pr-stacking / factory-self-review / quint-lang / quint-modeling"
echo "（若需改用其他 DSH home，請設 \$DSH_HOME 後再執行本腳本。）"
