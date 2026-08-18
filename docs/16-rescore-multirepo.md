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
