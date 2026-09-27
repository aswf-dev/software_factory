#!/usr/bin/env bash
# setup-local-dsh.sh — 本機 DSH 一次性設定（ADR-012：skills 共享 root）。
#
# 目的：把本機 DSH（GUI / headless session）的 `skill-filesystem.customSkillDirs`
# 指向「本 software_factory checkout」的 `.dsh/skills`——factory skills 的單一事實
# 來源在機制 repo，目標 repo 不再持有副本；本機端靠此設定載入共享 skills。
#
# 寫入位置：`$DSH_HOME/cordis.patch.yml`（home 層級的 Cordis patch，所有 profile
# 都套用，且優先於各 profile 自己的 patch）。DSH 0.1.7 已移除 `settings.yaml`：
# 舊檔只會在啟動後被非同步匯入一次（實測只匯入 web profile、headless 沒有），
# 之後改名為 `settings.yaml.imported`——本腳本舊版寫的設定因此不會穩定生效。
#
# 可攜性（雲端 VM / 換機器）：
#   - 以本檔自身位置推導絕對路徑（`dirname BASH_SOURCE`），任何目錄佈局皆可用；
#   - 在目標機器上只需：git clone software_factory → pnpm install → 執行本腳本。
#
# 用法：
#   ./scripts/setup-local-dsh.sh
#
# 冪等：重複執行只會確保 customSkillDirs 含本 checkout 的路徑，不會重複追加；
# patch 中其他 entry 與 skill-filesystem 的其他欄位保留。修改前會備份
# （cordis.patch.yml.bak.<ts>）；YAML 註解不會保留，需要時請從備份找回。
set -euo pipefail

# 1) 以本檔位置推導 software_factory checkout 根與共享 skills 目錄（絕對路徑）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SF_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILLS_DIR="$SF_ROOT/.dsh/skills"

if [ ! -d "$SKILLS_DIR" ]; then
  echo "錯誤：找不到 $SKILLS_DIR——請在 software_factory checkout 內執行本腳本" >&2
  exit 1
fi
if [ ! -d "$SF_ROOT/node_modules/js-yaml" ]; then
  echo "錯誤：找不到 js-yaml——請先在 $SF_ROOT 執行 pnpm install" >&2
  exit 1
fi

# 2) 目標設定檔：$DSH_HOME/cordis.patch.yml（預設 ~/.dsh）
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PATCH="$DSH_HOME/cordis.patch.yml"
mkdir -p "$DSH_HOME"
[ -f "$PATCH" ] && cp "$PATCH" "$PATCH.bak.$(date +%Y%m%d%H%M%S)"

# 3) 冪等合併 skill-filesystem 這一列（id 覆寫會整段取代 config，所以保留既有欄位）
(cd "$SF_ROOT" && PATCH="$PATCH" SKILLS_DIR="$SKILLS_DIR" node --input-type=module -e '
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs"
import { load, dump } from "js-yaml"
const { PATCH, SKILLS_DIR } = process.env
const rows = existsSync(PATCH) ? (load(readFileSync(PATCH, "utf8")) ?? []) : []
if (!Array.isArray(rows)) throw new Error(`${PATCH} 不是 patch 清單（頂層必須是陣列）`)
let row = rows.find((r) => r && r.id === "skill-filesystem")
if (!row) rows.push((row = { id: "skill-filesystem", config: {} }))
row.config ??= {}
const dirs = Array.isArray(row.config.customSkillDirs) ? row.config.customSkillDirs : []
if (!dirs.includes(SKILLS_DIR)) dirs.push(SKILLS_DIR)
row.config.customSkillDirs = dirs
writeFileSync(PATCH, dump(rows))
chmodSync(PATCH, 0o600)
')

echo "完成：skill-filesystem.customSkillDirs 含 $SKILLS_DIR"
echo "設定檔：$PATCH"
echo
echo "驗證：npx dsh --profile headless --dump-config | grep -A3 customSkillDirs"
echo "重新開啟 DSH session 後，skill 目錄應可見："
echo "  factory-workflow / factory-stop-rules / factory-pr-stacking / factory-self-review / quint-lang / quint-modeling"
echo "（若需改用其他 DSH home，請設 \$DSH_HOME 後再執行本腳本。）"
