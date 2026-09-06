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

---

## 5. 已納管 repo 一覽

| repo | 工廠 trunk | 三軸（B/R/C） | 基準分 | automerge | 納管日 |
|---|---|---|---|---|---|
| `philipz/software_factory` | `main` | tactical / high / medium = 0+2+1 | 3 → review | ❌（dogfooding，docs/11 §1.2） | — |
| `philipz/fubon-tradingbot` | `software-factory` | strategic / high / low = 2+2+0 | 4 → review | ❌ | 2026-08-18（T8 試點） |
| `philipz/factory-scoreboard` | `software-factory` | tactical / medium / low = 0+1+0 | 1 → on-loop | ❌（資料正確性影響 promote 裁決） | 2026-09-06 |

> **基準分**＝未觸發硬規則時的計分。實際監督層級隨變更路徑浮動：命中任一硬規則即強制 `risk=2`，總分隨之上升。

### 5.1 factory-scoreboard 的評級理由（2026-09-06）

- **tactical (0)**：內部管理工具。推送端為 `continue-on-error` 且 CLI 永遠 exit 0，後台故障時**工廠照常運作**，影響僅止於暫時收不到成本與 skill-gap 資料。
- **medium (1)**：持有 ingest 認證邏輯與 `SCOREBOARD_TOKEN`。關鍵在於 **Cloudflare Access 保護不了 `/api/v1/events`**——Access 以路徑比對、不分 HTTP 方法，而該路徑必須 Bypass 才能讓 CI 推送，保護責任因此完全落在應用層程式碼。2026-09-06 實測曾發現 `GET` 匿名可讀（已修補），證明此處疏失會直接外洩資料，故不宜評為 `low`；但無金流、無 PII、資料可自 GitHub 與 Actions 重建，故非 `high`。
- **low (0)**：15 個原始檔、單一資料表、6 個端點、無跨服務協調。

### 5.2 納管驗證方法（建議新 repo 比照）

僅有設定檔不代表工廠讀得到。開一個 `factory/*` 探測 PR，用 `factory-rescore` 跨 repo 實測**兩個方向**：

```bash
gh workflow run factory-rescore.yml --repo philipz/software_factory \
  -f repo=<owner/name> -f base_branch=<trunk> -f pr_number=<PR>
```

| 探測內容 | 預期 |
|---|---|
| 只改一般檔案 | 基準分、`triggeredHardRules: []`、`escalated: false` |
| 改一個硬規則路徑（如 `migrations/`） | 分數上升、對應規則出現、`escalated: true` |

**兩個方向都要驗**：只驗前者無法區分「硬規則正確」與「硬規則根本沒載入」。

factory-scoreboard 的實測結果（run 34006539807 / 34006596084）：

```
一般檔案      → total 1, hardRules [],     escalated false, tier on-loop
migrations/  → total 2, hardRules [H6],   escalated true,  tier review
```

### 5.3 硬規則誤報的代價（實例）

factory-scoreboard 初版 H3 沿用 `**/*token*`，實測**誤中 `src/styles/tokens.css`**（設計 tokens，與憑證無關）——每次改樣式都會被強制人類審查。已改為 `**/*.token`、`.dev.vars` 等精確樣式。

> **原則**：硬規則若經常誤報，會訓練審查者略過警訊，反而**削弱**防護。新 repo 的 risk-paths **應依實際目錄結構撰寫，而非複製範本**。
