---
name: factory-workflow
description: 工廠 agent 處理一個 GitHub Issue 工作項的主流程 SOP。載入本 skill 後依序執行：讀 Issue、寫測試、實作、自審、拆 stacked PR、回報，並在結束前寫出執行報告。
---

# 工廠主流程

處理 GitHub Issue #<編號>（由任務描述提供，repo 為當前 workspace 的 repo）。

## 步驟

1. 讀取該 Issue 的內容與驗收條件（`gh issue view <編號>`）。
2. 判斷是否有可驗證的驗收條件：若 Issue 沒有明確的驗收條件（無重現步驟、無「完成 = 可觀察結果」的描述），**不要猜測**——將 `hasAcceptanceCriteria` 設為 `false` 並依 factory-stop-rules 停手。
3. 依「測試先行」順序作業：先寫測試（定義「正確」），再實作使其通過，最後補文件。
4. 依 factory-pr-stacking 的規則拆分並建立 stacked PR。
5. 提交前依 factory-self-review 自審。
6. 在 Issue 留言回報產出的 PR 編號與摘要。
7. **結束前，在 workspace 寫出執行報告**：

```json
{
  "issueNumber": <編號>,
  "invocation": { "exitCode": 0, "stdout": "<最後一則輸出>", "stderr": "" },
  "changedPaths": ["<改動檔案相對路徑>"],
  "changedLines": <總變更行數>,
  "assertionDelta": <測試斷言淨增減，負數表示減少>,
  "addedDependencies": ["<新增相依套件名>"],
  "syncFailures": <gh stack sync 連續失敗次數>,
  "hasAcceptanceCriteria": <true|false>
}
```

寫入路徑：`.factory/run/report.json`（位於 workspace 根目錄）。此報告是 CI 判定終點的輸入；**欄位缺漏時 CI 會以最保守方式處理**，但完整填寫能讓人類接手時看到全貌。

## 原則

- 所有 git/gh 操作使用 GitHub App 身分：**若環境變數 `GH_TOKEN` 不存在，先執行**
  `export GH_TOKEN=$(cat .factory/run/gh-token 2>/dev/null)`（短效 installation token，
  由 CI 寫入 workspace；讀取失敗則依 factory-stop-rules 停手）。**永不把 token 寫入任何
  會進 git 的檔案**（如 commit message、文件、測試）。
- 任務描述本身不重複本 skill 內容——需要細節時回到本檔案。
- 任何不確定的情況，依 factory-stop-rules 停手，**不要猜測並繼續**。
