# ADR-013：factory trunk 統一——機制 repo 也採 software-factory 分支

- **狀態**：已接受
- **日期**：2026-08-28
- **決定者**：平台架構（人類直接指示：統一所有 repo 的做法，含 software_factory 自身）
- **對應**：`09-roadmap.md` §2.2（Q-P2-1）、`10-open-questions.md` Q-P2-1、`factory-run.yml`（base_branch input 與 Guard）、`backstage/templates/*`（baseBranch 欄位）、`007-stacked-pr-workflow.md`、`ADR/003`

## 脈絡

Q-P2-1（2026-08-18 裁決）為試點 repo（fubon-tradingbot、spring-modulith-orders、uber_payment_poc、uber_payment_cloudflare_worker）設定了模式：**工廠 trunk = `software-factory` 分支，main 絕不觸碰**；factory agent 的 PR 合併回 software-factory，再由**人工**把 software-factory 合併進 main。機制 repo（philipz/software_factory）是例外——trunk 沿用 main（dogfooding：機制 repo 就是工廠自身的開發線）。

例外造成實際問題（2026-08-28 實測）：
- Issue #171 dispatch 帶入 `base_branch=software-factory`（Backstage 模板預設為試點 repo 設計），機制 repo 沒有該分支 → checkout 在花費前才炸，錯誤訊息不讀。
- Guard 條件「`repo != philipz/software_factory && base == main`」無法涵蓋「機制 repo + 不存在的 trunk」這類錯配，也讓模板預設值變成錯誤來源。

## 決策

**取消機制 repo 的 main-trunk 例外，全面統一：所有 repo（含 philipz/software_factory 自身）的 factory trunk 一律為 `software-factory` 分支，main 絕不觸碰。**

1. **機制 repo 建立 `software-factory` 分支**（從 main 分出），成為其 factory trunk。
2. **`factory-run.yml`**：
   - `base_branch` input 預設改為 `software-factory`；
   - Guard 改為「**所有 repo 的 `base_branch` 一律不得為 `main`**」（移除機制 repo 特例）＋新增**分支存在性檢查**（`gh api .../git/ref/heads/<base>`，不存在即紅燈）——無論表單/手動 dispatch 填錯都能在零成本時 fast-fail。
3. **Backstage 模板（factory-work-item 與 agent-add-tests）**：`baseBranch` 欄位 description 改為統一語意（所有 repo 皆 software-factory）；預設值維持 `software-factory`（統一後永遠正確）。
4. **CI**：機制 repo 的 `test.yml` push 觸發涵蓋 `software-factory`（factory trunk 每層獨立綠燈，docs/07 §2.2）。
5. **合併流程**：機制 repo 自身也走兩段式——factory PR 合併回 software-factory（人工審查）→ **人工**把 software-factory 合併進 main。main 成為「release line」，只接受人工的 software-factory → main 合併。

## 後果

### 正面

- 模式完全統一：模板預設、Guard 規則、CI 觸發、docs 對所有 repo 一致，無特例可誤用。
- 機制 repo 的 main 也受到「agent 永不觸碰」保護——guardrail 變更（`.github/**` 等 H5）多一道人工合併關卡。
- 分支存在性檢查讓錯配在 checkout 前以可讀訊息 fast-fail（#171 教訓）。

### 負面（誠實揭露）

- 機制 repo 每次變更多一道人工合併 hop（software-factory → main）；遺忘會讓 main 落後。
- workflow/guardrail 從 main（default branch）執行——main 落後 = CI 跑舊版；由「合併紀律」補償（每次 software-factory → main 合併即同步）。
- 遷移過渡：既有 open PR（dependabot → main 等）仍合併進 main；software-factory 分支由人工定期同步。

## 未做

- main 的 branch protection 強化（單人 repo 無法自我核准，Q12-4 已知缺口；維持人工合併紀律）。

## 附註（2026-10-04）：分支漂移的判定與處理

實測發現多個納管 repo 的 main 與 software-factory 已長期分歧，原因不只「忘了同步」：

- **trunk 落後（`trunk-behind`）**：有內容直接合進 main——人工 PR（如 fubon-tradingbot #638–#640）、
  dependabot（如 camunda_hazelcast）。工廠以 software-factory 為基礎產出 PR，之後同步回 main 可能衝突。
- **main 落後（`main-behind`）**：software-factory 有已合併、尚未同步的內容（如 node-redlock 25 個 commit）。
  這就是上方「負面」所列的「CI 跑舊版」風險。

**判定規則**：比較兩個分支的**內容**而非 commit 數。用 GitHub 三點 compare 兩個方向各比一次
（`software-factory...main` 與 `main...software-factory`），看 `files` 是否為空：

| 兩個方向的 `files` | 狀態 |
| --- | --- |
| 皆空（sha 不同） | `merge-only`：只有同步產生的 merge commit，**不算漂移** |
| 只有 `main...software-factory` 有 | `main-behind` |
| 只有 `software-factory...main` 有 | `trunk-behind` |
| 皆有 | `diverged` |

只比一個方向會誤判（node-redlock 的 `software-factory...main` 回 `files=0`，但 main 實際缺了 21 個檔案）；
只看 commit 數則會把每次同步後的 merge commit 都當成漂移。

**處理方式**：aswf.dev 在送單前偵測並告知，**不自動對齊、不自動 release**，修正由 repo 擁有者負責：

- `main-behind`：開同步 PR（software-factory → main）。
- `trunk-behind`：開 PR 把 main 合回 software-factory（兩邊通常已分岔，無法 fast-forward）。

設計細節：factory-scoreboard `docs/superpowers/specs/2026-10-04-trunk-drift-guard-design.md`。
