# 16 — 跨 repo 二次判定操作（rescore dispatch）

> **依據**：docs/06 §5.3（二次判定）、docs/superpowers/plans/2026-08-18-phase2-expansion.md T8（試點）。
> **讀者**：需要對非 software_factory repo 的 factory/* PR 做二次判定的人。
> **背景**：`factory-rescore.yml` 是 pull_request 事件 workflow，**只在其所在 repo 觸發**。對其他 repo（如 fubon-tradingbot）的 factory/* PR，GitHub 不會自動觸發——且直接複製 workflow 過去也無法運作（該 repo 沒有 `dist/cli/factory-rescore.js`）。解法（PR #109）：機制留在此 repo，以 `workflow_dispatch` 指定目標 repo；**目標 repo 零複製、此 workflow 不 push 任何分支**。

---

## 1. 對其他 repo 的 PR 手動重計分

在 software_factory 的 Actions → Factory Rescore → Run workflow，填：

| input | 值 | 說明 |
|---|---|---|
| `repo` | `philipz/fubon-tradingbot` | 目標 repo（App 需已安裝於該 repo）|
| `base_branch` | `software-factory` | 目標 repo 的工廠 trunk（僅供 checkout 讀 catalog/risk-paths）|
| `pr_number` | 例如 `12` | 要重計分的 PR 編號（必填）|

或 CLI：

```bash
gh workflow run factory-rescore.yml --repo philipz/software_factory \
  -f repo=philipz/fubon-tradingbot \
  -f base_branch=software-factory \
  -f pr_number=<PR_NUMBER>
```

**執行內容**：checkout 目標 repo 的 base_branch → 以 App token 讀 PR 變更檔 → 用目標 repo 的 `catalog-info.yaml`/`.github/factory/risk-paths.yml` 重計分 → 與 Issue 上的初始 `oversight/*` 標籤比較 → 單向升級時以 App 身分在 Issue 留言（docs/06 §5.3）。

## 2. 對本 repo（software_factory）的 PR

`pull_request` 事件自動觸發（僅 `factory/*` 分支）；無需手動操作。

## 3. 注意事項

- **App 需安裝於目標 repo**，否則 mint token（`repositories:` 限定目標 repo）會失敗。
- **此 workflow 不 push**：只讀 PR + 留言/標籤，不觸碰任何 repo 的 main（Q-P2-1）。
- 目標 repo 的 catalog/risk-paths 更新後（例如裁決調降某軸），rescore 會自動讀到新值——不需改 workflow。
- 若要自動化（PR 事件即時觸發）：需在目標 repo 放一個薄 dispatch workflow（App 無 actions:write，無法由 App 觸發 software_factory 的 workflow_dispatch）——目前試點規模採手動 dispatch，自動化留待第 3 期評估。

---

## 4. 人類 PR 的 factory 監督流程（2026-08-20，PR #583 實例）

> **適用**：目標 repo 上**人類開發的 PR**（head 非 `factory/*`、base 通常為 main 或 trunk）。factory 對人類 PR 的角色是**監督、不干預**——CI 自動驗證 → rescore 二次判定 → 缺陷追蹤，agent **不接手**人類 PR（重複勞動且模糊責任）。

### 4.1 三個介入點

| 介入點 | 機制 | 觸發 | 範例（PR #583）|
|---|---|---|---|
| **① CI 自動驗證** | 目標 repo 的 test.yml（觸發涵蓋 main/software-factory/factory/**）| PR 事件自動 | test/lint/security 全綠 |
| **② rescore 二次判定** | factory-rescore 跨 repo dispatch（§1）| **手動**（工作項式；無自動化——App 無 actions:write）| total 4 → review、無硬規則 |
| **③ 缺陷追蹤** | defect/* 標籤 → docs/14 觀察期 | 合併後發現缺陷時 | — |

### 4.2 操作（② rescore）

```bash
gh workflow run factory-rescore.yml --repo philipz/software_factory \
  -f repo=<owner/name> -f base_branch=<factory trunk> -f pr_number=<PR>
```

- 計分結果：`total`/`tier`/`triggeredHardRules`/`escalated`。
- **無關聯 Issue（無 `Closes #N`）**：只輸出計分，不比較監督層級。
- **有 `Closes #N`**：連動讀 Issue 初始 `oversight/*` 標籤 → 單向升級檢查（docs/06 §5.3）。
- 不升級（`escalated: false`）時 workflow 不自動留言——監督留痕需**手動留言**（§4.3）。

### 4.3 監督留痕（建議格式）

在 PR 留言：計分 / 監督層級 / 硬性規則是否觸發 / 升級與否，並註明「**監督性檢查，不構成審查核准**」（factory 的計分不是 code review，人類審查仍為必要）。

### 4.4 界線（重要）

- ❌ **agent 不接手人類 PR**：不自動補測試、不改人類的設計。需要 agent 介入時，開**新的 factory 工作項**（用表單）→ 檢查器驗證 → dispatch。
- ❌ 監督 ≠ 審查核准：rescore 只確認「變更的監督層級與風險」，審查/合併決策仍屬人類。
- ✅ 人類 PR 的正常閉環：開發 → CI 綠 → （可選）rescore 監督 → 人類審查合併 → 合併後缺陷追蹤。
