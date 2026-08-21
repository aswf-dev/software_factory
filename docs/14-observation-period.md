# 14 — 缺陷追蹤與觀察期機制

> **依據**：`13-phase1-acceptance.md` §6（五問中三項無數據）、`08-metrics-kpi.md` §2.2/§2.4（缺陷逃逸率）、`10` Q08-2（缺陷標記紀律）
> **目的**：把「信任由數據建立」從原則變成操作——建立缺陷的**標記紀律**與**觀察節奏**，讓 docs/09 §6 的五問在下一期結束時有實質答案。
> **讀者**：審查 factory PR 的人、每期結束做檢視的人

---

## 1. 缺陷標記紀律（Q08-2 解決）

### 1.1 兩個標籤

| 標籤 | 意義 | 什麼時候貼 | 誰貼 |
|---|---|---|---|
| `defect/escape` | **缺陷逃逸**：合併後才被發現的缺陷（本應在審查/測試中被攔下） | 發現合併產物有 bug 時，貼在**修正該 bug 的 Issue** 上 | 發現者（人） |
| `defect/review` | **審查攔截**：在人類審查 factory PR 時發現的缺陷（未逃逸，但代表 agent 品質問題） | 審查時發現問題，貼在**該工作項 Issue** 上 | 審查者（人） |

### 1.2 標記規則

1. **defect/escape 的判定**：合併後的功能性 bug，且可追溯到某顆 factory PR（`Closes #N` 連結）→ 貼 `defect/escape` 並在 Issue 留言標明來源 PR。
2. **defect/review 的判定**：審查 factory PR 時發現的邏輯/契約/測試錯誤 → 貼在該工作項 Issue，並以 review comment 記錄。
3. **兩者都必須可追溯**：`defect/escape` 的 Issue 必須 `Closes` 或提及來源 PR；`defect/review` 的 Issue 即工作項本身。
4. **不貼**：測試未涵蓋的既有程式碼缺陷（非 factory PR 引入）——那是另一回事，不計入 factory 的缺陷率。

### 1.3 指標定義（對照 docs/08 §2.4）

```
缺陷逃逸率 = defect/escape 數 / 期間內合併的工作項數
審查攔截率 = defect/review 數 / 期間內合併的工作項數
```

- 分母：有合併 PR 的工作項（`meta/observation` 期間內的）
- 觀察期內**合併工作項應貼 `meta/observation`**，讓分母可機械篩選
- 目標（Phase 2 的參考門檻，待校準——Q08-2 的後續）：逃逸率 0 才談自動合併（docs/09 §4 進入條件）

## 2. 觀察期機制

### 2.1 節奏

| 節奏 | 動作 | 產出 |
|---|---|---|
| **每顆 factory PR 合併時** | 審查者確認是否貼 `defect/review`（若有） | 即時標記 |
| **每週** | 檢查新增的 `defect/escape`/`defect/review`（`gh issue list --label defect/escape`）| 週報一行 |
| **每期結束（Phase 2 前）** | 計算 §1.3 兩率 + docs/09 §6 五問 | 更新的驗收報告或檢視紀錄 |

### 2.2 觀察期的啟動

- **啟動條件**：本機制文件合併後即啟動。
- **期間**：建議 2–4 週，或累積 ≥10 個帶 `meta/observation` 的合併工作項（兩者先到者）。
- **期間活動**：正常投放工作項（Phase 1 已驗證的 `agent-add-tests` 類別）、人類照常審查、標記照常進行。
- **結束動作**：計算兩率 → 更新 `13-phase1-acceptance.md` §6 → 作為 Phase 2 規劃的數據輸入。

### 2.3 誰負責

- **標記**：審查者（貼 defect/review）、發現者（貼 defect/escape）——目前即 philipz。
- **週檢**：可自動化一半（`gh issue list --label defect/escape --state open` 一行指令），人工解讀。
- **期檢**：Phase 2 規劃前的人工檢視。

## 3. 與既有機制的關係

| 機制 | 關係 |
|---|---|
| `oversight/*` 標籤 | 監督層級（agent 前）；`defect/*` 是事後品質（agent 後）。正交 |
| `needs-human` | 執行交還；`defect/review` 是審查中發現的問題——不同事件，可能同時存在 |
| `meta/observation` | 觀察期樣本標記，供分母篩選；與前兩者正交 |
| docs/08 §2.4 | 本文件把 §2.4 的指標**操作化**（標籤 + 節奏）|

## 未決事項

| 編號 | 事項 | 處置 |
|---|---|---|
| Q14-1 | 觀察期長度與樣本數門檻（2–4 週 vs ≥10 樣本） | Phase 2 規劃時依實際流量校準 |
| Q14-2 | defect/escape 是否需要自動化偵測（如合併後 N 天內 reopen 的 issue）| 第二階段評估；先人手標記 |

### 1.7 #50 — Backstage 降級裁決（Q03-6/Q13-1，2026-08-18）

- **裁決**：Phase 1–2 採**純 GitHub Issue 觸發**（降級方案）；Backstage 工件（`backstage/`、docs/03、app-config 設定）**凍結保留**，不部署、不維運。
- **理由**：單人 repo 的 IDP 抽象層價值接近零（無「全隊共用」對象）；維運成本 > 價值（Q03-6 明示此為可降級情境）；現行 `gh workflow run` + Issue 流程已實證完整運作。
- **可逆性（架構 D1）**：降級不關門——Backstage 只經 GitHub 契約耦合，工件全數保留；日後「公司內多使用者」需求出現時，重新部署 + Template 註冊即可升級（成本仍低）。
- **升級觸發條件**：第 2 位協作者或第 2 個 repo 進入（Phase 2 的 2.2）時，重新評估。
- **局部解凍（2026-08-21，ADR-009）**：單人使用但出現「統一入口 + LLM 草稿」的具體需求——解凍 `factory-work-item` 模板 + LLM 草稿 + direct dispatch 最小路徑（本機 `yarn dev`），其餘維持凍結。工件與裁決見 `docs/ADR/009-backstage-partial-unfreeze.md`。
