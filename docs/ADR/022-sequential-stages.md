# ADR-022：依序模式——以「前置工作項」串接工作項，派工時檢查、完成時接力

- **狀態**：已接受（實作與本 ADR 同一張 PR；aswf.dev 的 webhook 轉送站另案）
- **日期**：2026-10-12
- **決定者**：平台架構（使用者經 grilling 逐項裁決，Q2–Q5、Q11、Q12、Q16、Q21、Q27、Q29、Q33、Q34）
- **對應**：`ADR-021`（平行模式與代理設計模式採用邊界）、`ADR-001`（GitHub 為唯一事實來源）、`ADR-018` §12（階段推導、不提供略過 input 的先例）、`docs/24` §2.1（CI 無人確認＝拒絕）、`docs/29` L26（建議下一步不會自動變成工作項）、`docs/32` §4

## 脈絡

`ADR-021` 把 Google Cloud 的代理設計模式對照工廠後，**依序＋人機迴圈**是下一個要擴充的模式。
但 stacked PR 已經在**一張單內**做到「測試 → 實作 → 文件」（`docs/07` §2.1），所以跨工作項的
依序只在兩種情況才有額外價值（Q21）：

1. **模組沒有測試**：先開 `agent-add-tests` 建立回歸安全網，經人審查合併後，才開 `agent-fix-bug`。
   一張單內的 01-test 只能證明「這個 bug 修好了」，不能證明「其他東西沒被改壞」。
2. **棕地導入的跨類型階段**（`docs/29` P0→P5）：分析 → 文件 → 人寫業務規則 → 安全網 → 維護，
   每一步是不同的任務類型，不可能塞進同一疊 PR。

一般 fix-bug 照舊只用 stacked PR。

先前的「前置工作項」欄位與規劃健檢（`docs/32` §4）只在開單時檢查**寫法**，不查前置是否已完成，
所以「前置沒完成就派工」只能靠人記得——那幾乎一定會停手、白花 token（`docs/27` L353）。

## 決策

### 1. 每個階段一張 Issue，以「前置工作項」欄位串接（Q3、Q16）

- 下游 Issue 的「前置工作項」欄位填 `#N`，只接受**同一個 repo** 的 Issue。`owner/repo#N` 判為無法解析。
- 每張單都由人事先開立，符合 `docs/29` L26。一張 Issue＝一個工作項＝一個歸因單元，`ADR-010` 的歸因
  與棘輪不受影響。

### 2. 「階段完成」只依 GitHub 即時狀態判定（Q2、Q4、Q11）

權威狀態留在 GitHub（`ADR-001`）；任何外部系統只存可重建的副本。判定（`src/cli/factory-stage.ts`）：

| 情況 | 判定 |
|---|---|
| Issue 有 `stage/done` 標籤 | 完成（人工覆寫） |
| 恰好一組交付（變體 a、b，或沒有變體代號的單一交付）有已合併的 PR，且該組沒有開著的 PR | 完成，勝者就是這一組 |
| 人接手修好並合併 | 完成（只看合併，不看機器終態） |
| 兩組以上都有已合併的 PR | **mixed**：不判定，請人貼 `stage/done` |
| 還有開著的 PR，或沒有任何合併 | 尚未完成 |

被關閉而未合併的 PR 不計（stacked PR 重建、選勝者關閉的落選 draft 都屬此類）。Issue 被關閉**不是**
完成訊號：工廠的 PR 合併到 `software-factory` 而非預設分支，`Closes #N` 不會自動關閉 Issue。

### 3. 派工時檢查前置，未完成即停派（Q12）

`factory-run` 在格式檢查之後、計分與 agent 之前執行 `factory-stage prereqs`：

- 前置未完成、找不到、欄位無法解析或指向自己 → 留言說明並停派。宣告有歧義時不放行。
- **不貼 `needs-human`**：這不是 agent 的失敗，貼了會污染停手原因統計（`docs/08` §2.5）。
- **不提供略過用的 input**（`ADR-018` §12 先例：強制指定的 input 等於留下跳過前一階段的後門）。
  真要略過，就清空下游 Issue 的前置欄位，留有紀錄。
- 查詢失敗時同樣停派（fail-closed）。
- N-version 的兩個變體都會執行本步，只有變體 a 留言。

### 4. 完成時的接力：aswf.dev 轉送、機制 repo 執行（Q5、Q27、Q29、Q33）

```
目標 repo 合併 PR ──webhook──▶ aswf.dev：驗證簽章、遞送 ID 去重、篩選 ──派工──▶ factory-stage-finalize.yml
```

`factory-stage-finalize.yml`（`workflow_dispatch`，也可由人手動執行作為 webhook 故障時的備援）呼叫
`factory-stage finalize`：

1. 目標 repo 必須已納管（`software-factory` 分支上有 `catalog-info.yaml`）——**允許清單只在這裡**，
   aswf.dev 不重複檢查，也**不得**使用 aswf.dev 的 `knownRepos`（可被 `SCOREBOARD_TOKEN` 寫入）。
2. 完成 → 刪除落選變體的分支（只刪不是任何開著或已合併 PR 之 head 的分支），並在宣告它為前置的下游
   open Issue 留言「前置 #N 已完成，可以派工」。下游以 `parsePrerequisites` 精確判定，不靠全文搜尋；
   留言帶標記，重複執行只留一次。
3. mixed → 在本 Issue 請人貼 `stage/done`，只問一次。
4. 其他 → 不做任何事（只合併了其中一層也會收到 webhook）。

**不自動派工下游**（Q29-A）：那會是「沒有人觸發的 agent 派工」，與 `docs/24` §2.1 的精神衝突，需另行
裁決。本 workflow 不呼叫 LLM。

App token 只發給單一目標 repo：`contents: write`（刪分支）、`issues: write`（留言）、`pull-requests: read`。

### 5. aswf.dev webhook 的安全控制（Q34，另案實作）

1. 驗證 `X-Hub-Signature-256`，使用**專用密鑰** `GITHUB_WEBHOOK_SECRET`，不得沿用 `SCOREBOARD_TOKEN`；
   未設定密鑰時一律拒絕。
2. 以 `X-GitHub-Delivery` 防重放（`ON CONFLICT DO NOTHING`，搶到的才處理）。
3. 只處理 `pull_request` 且 `closed`、`merged=true`、base 為 `software-factory`、head 符合 `factory/<issue>-…`。
4. 允許清單以即時狀態判斷（在本 workflow，決策 4 第 1 點）。
5. 刪除前以即時狀態重新判定（在本 workflow）。
6. D1 只存遞送紀錄（ID、時間、處理結果），90 天自動清除。
7. Cloudflare Access 的 Bypass 只開這一個確切路徑，且只開 GitHub App 實際指向的主機（`aswf.dev`；
   `www.aswf.dev` 沒有必要——多開一個主機只是多一處暴露面）。
8. webhook 檔案明確加進 aswf.dev 的 `risk-paths.yml` H1 與 CODEOWNERS。
9. 回應只回狀態碼，不回內部錯誤訊息。

**為何不沿用 `SCOREBOARD_TOKEN`**：它是 Bearer token，每次推送都以明文出現在 HTTP 標頭、機制 repo 所有
workflow 都讀得到；它只能寫統計事件，webhook 卻能觸發刪分支與留言——低權限密鑰不得守高權限入口；共用會讓
兩邊輪換互相牽連，事後也無法分辨請求來源。

## 後果

### 正面

- 「前置沒完成就派工」在花錢前被擋下，且不污染停手統計。
- 判定規則只寫一次（TypeScript，`src/cli` 100% 分支覆蓋），派工檢查與完成接力共用。
- 落選分支的清理有了確切時機（勝者全部合併之後），目標 repo 不需部署任何 workflow。

### 負面

- 工廠第一次在目標 repo **刪除分支**：App token 需要 `contents: write`。以單一 repo、單次 token、
  刪除前即時重判、只刪非 PR head 的落選分支來收斂風險。
- 下游 Issue 一次最多掃描 200 張 open Issue；超過時可能漏通知（可手動重跑 finalize）。
- webhook 上線前，接力只能手動執行 finalize。

### 中性

- 開單時的規劃健檢仍是 advisory、不查狀態；狀態檢查只在派工時做。

## 替代方案

| 方案 | 為何未採用 |
|---|---|
| 一張 Issue 列出整串階段（比照 write-spec） | 一張 Issue 會掛多階段 × 2 變體的 PR，標籤聯集問題倍增；且階段不是人逐張開立（Q3-B） |
| 以 Issue 關閉當完成訊號 | 工廠 PR 合併到 `software-factory`，`Closes #N` 不會觸發 |
| 人貼標籤才算完成 | 多一個人會忘記的步驟；改為機器推導、標籤只作覆寫（Q4） |
| 前置未完成時貼 `needs-human` | 不是 agent 的失敗，污染統計（Q12-B） |
| 提供略過檢查的 input | 等於留下跳過前一階段的後門（Q12） |
| aswf.dev 直接判定、刪分支、留言 | 判定規則要在另一個 repo、另一種語言再寫一份；Worker 首次持有 `contents: write`（Q33-B） |
| 排程輪詢代替 webhook | 為低風險清理新增一套迴圈基礎設施，且有延遲（Q27-B） |
| 前置完成後自動派工下游 | 無人觸發的派工，需另行裁決（Q29-B） |

## 驗證項

在沙箱 repo 跑一條完整流程（Q31-A）：開兩張有前置關係的 Issue → 派工下游（應被擋下）→ 前置 N-version →
選勝者 → 合併 → finalize（手動或 webhook）→ 確認下游收到通知、落選分支被刪 → 再次派工下游（應通過）。
