# ADR-012：Guardrail 集中化架構（消除目標 repo 副本漂移）

- **狀態**：已接受
- **日期**：2026-08-28
- **決定者**：平台架構（人類直接指示；涉及 `.github/**` 與 `.dsh/skills/**` guardrail 自身）
- **對應**：`011-model-tier-routing.md`（issue-check 三行留言）、`04-agent-execution-dsh.md` §3.2（skill rank）、`factory-issue-check.yml`、`factory-run.yml`

## 脈絡

目標 repo（如 uber_payment_cloudflare_worker）的 `.dsh/skills/`、`.github/workflows/factory-issue-check.yml`、
`.github/factory/task-template-*.txt`、`.github/ISSUE_TEMPLATE/` 在 bootstrap 時**一次性複製**自機制 repo
（software_factory），之後無同步機制。機制 repo 的邏輯演進（實例：ADR-011 把 issue-check 留言擴充為
「格式合規＋複雜度分析＋建議模型」三行，2026-08-25）不會自動傳到目標 repo——issue #60 的留言仍是一行
舊格式。修復方式過去是「手動重新複製」，每次機制 repo 改動都要人工巡迴各目標 repo。

GitHub 硬限制：事件觸發的 workflow 檔案必須存在於 repo 自身的 `.github/workflows/`，且**機制 repo 為
private、目標 repo 為 public**——跨 user-account 的 private reusable workflow（`workflow_call`）不可用，
故「reusable workflow 化」此路徑在權限上不成立。

## 決策

以「**集中執行 + 刪除副本**」取代「複製」：目標 repo 不再持有任何會漂移的 guardrail 副本，
機制 repo 是唯一事實來源，執行點集中在 factory-run。

1. **Issue 格式檢查集中到 factory-run**：`factory-run.yml` 新增「Check issue format (central enforcement)」
   步驟（在 agent 啟動前）——以機制 repo 的 `dist/cli/factory-issue-check.js` 檢查目標 issue，
   留言三行（ADR-011），不合規即紅燈停派。目標 repo 的 `.github/workflows/factory-issue-check.yml`
   **刪除**（DRIFT-ELIMINATION：目標端不再有可漂移的副本）。
2. **Skills 走共享 root**：factory skills（factory-*、quint-*）單一事實來源在機制 repo 的
   `.dsh/skills/`。CI 端 factory-run 在 dsh 啟動前同步到 `$HOME/.dsh/skills`（DSH rank 400 user-dsh）；
   本機端執行 `scripts/setup-local-dsh.sh`（以自身位置推導絕對路徑、冪等合併
   `~/.dsh/settings.yaml` 的 `skill-filesystem.customSkillDirs`，rank 300；可在雲端 VM 重現）。
   目標 repo 的 `.dsh/skills/` **刪除**。
3. **Task-template 走既有 fallback**：factory-run 已實作「目標 repo 無模板 → fallback 機制 repo」
   （L337-338 先例）——目標 repo 的 `.github/factory/task-template-*.txt` **刪除**。
4. **Issue 開單統一走 Backstage**（ADR-009）：`.github/ISSUE_TEMPLATE/factory-work-item.yml` 僅服務
   GitHub UI 直接開單（會繞過 Backstage 的制式欄位）——**刪除**，開單入口唯一化。
5. **repo-local guardrail 保留**：`risk-paths.yml`（H 規則依 repo 結構而異）、`quint-paths.yml`、
   `CODEOWNERS`、`catalog-info.yaml` 本就 repo-local，不屬同步範圍。
6. **不變更**：機制 repo 自身的 `factory-issue-check.yml`（trigger on issues）、test/quint-verify/
   security-scan/codeql（target 版為通用樣板或 repo-local 邏輯，非機制邏輯複製，無漂移風險）。

## 後果

### 正面

- 消除「手動重新複製」：機制 repo 改動**自動生效**於下一次 dispatch（issue-check、skills）。
- 目標 repo 變乾淨：`.dsh/skills/`、issue-check workflow、task-template、issue-template 全部刪除。
- 檢查與執行同一份 CLI：留言與實際路由永不打架（承 ADR-011）。

### 負面 / 取捨

- **Issue 檢查時點後移**：從「開單當下（on: issues）」改為「dispatch 當下（factory-run 首步）」——
  GitHub UI 直接開單不再即時檢查（統一走 Backstage 時無感）。
- **本機 agent 依賴機器設定**：目標 repo 無 `.dsh/skills` 後，本機 DSH session 需 `customSkillDirs`
  指向機制 repo checkout，否則載不到 factory skills（AGENTS.md 已記載設定方法）。
- guardrail 治理模型改變：skills 不再隨目標 repo 版控/PR 審查——以機制 repo 的 PR 審查取代
  （單一事實來源的 review checkpoint）。

## 未做（日後選項）

- 自動 sync bot：本架構已「刪除副本」而非「同步副本」，暫無需；若未來目標 repo 重新出現
  機制邏輯副本，再以「開 sync PR（人類合併）」補上。
- 機制 repo 的 workflow 改為 reusable（`workflow_call`）：受 private repo 跨帳號限制，暫不可行；
  若日後機制 repo 公開或遷入 org 再評估。
