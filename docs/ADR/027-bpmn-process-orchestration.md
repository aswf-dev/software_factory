# ADR-027：以 BPMN 編排系統價值流——語意與治理

- **狀態**：提議中（2026-10-26；待審閱後改為「已接受」，PoC 依 `ADR-028` §7 驗收）
- **日期**：2026-10-26
- **決定者**：使用者（經 grilling 逐題裁決，Q1–Q43）
- **取代**：`ADR-023` 全文、`ADR-024` 全文、`ADR-025` §2（模板檔案格式）與 §3 的實作載體、`ADR-026` §1（系統 spec 與模組清單的格式與檔名）
- **修訂**：`ADR-001`（GitHub 仍是事實的唯一來源；新增「流程位置」由 Durable Object 權威的分層）
- **對應**：`ADR-028`（技術選型與 PoC 驗收）、`research/56-bpmn-orchestration`（實測證據）、`ADR-022`（前置工作項、`stage/done`）、`ADR-021`（N-version）、`docs/29` §6／§8／§9、`docs/31` §1

## 脈絡

`ADR-023`／`ADR-024` 把流程定為「描述＋呈現」：`process.yaml` 描述、React Flow 畫圖，UI **不可派工、不可簽核**，「執行」只是產生待開工作項清單。這個邊界刻意排除了執行引擎（`ADR-023` §3 淘汰 Rete.js 的理由正是它內建執行引擎），並登記了重評觸發條件 #1：「需要在前端執行流程」。

本 ADR 回應的需求正好觸發該條件。使用者要的是五件事同時成立（Q1）：

1. **可編排**：專案／租戶能在網頁上用標準圖形編輯自己的流程，不只是在 S/M/L 上微調。
2. **執行自動化**：流程本身推進——activity 觸發工單表單、建 Issue、派工 GitHub Actions。
3. **標準化與可視化**：BPMN 2.0 是非工程背景也讀得懂的標準。
4. **擺脫 YAML 編排**：`process.yaml`／模板 YAML 的「只能前綴、只能追加」語意難以表達真實流程。
5. **可即時監控、多人共用**：流程狀態存活數週到數月，團隊共享、可稽核。

限制：

- **GitHub 仍是事實來源**：Issue、PR、標籤、HG 簽核留言、`factory-run` 終態，現有的 `factory-stage-finalize`、`factory-stage prereqs`、`src/hg/parse.ts` 全部以 GitHub 為準（`ADR-001`、`ADR-022`）。
- **HG0（每張單由人送出）**、`ADR-022` Q29-A（不自動派工下游）與 `docs/24` §2.1（CI 無人確認＝拒絕）是既有治理底線。
- 單次 `factory-run` 最長 185 分鐘、token 可達 19M+；瀏覽器不可能承載執行，也不能持有 GitHub App 憑證。
- 瀏覽器單機狀態無法滿足「關掉頁面後流程仍存活」「換人接手」「可稽核」（Q3）。

## 決策

### 1. 範圍

- **v1 只編排系統價值流**（P0–P5、HG、S/M/L 預設流程）（Q4）。
- **單次 `factory-run` 內部的 30+ step 是 non-goal**（Q13）：在 BPMN 裡它是一個黑盒 service task（派工 → 等待終態）。runner、log、artifact、matrix 仍由 GitHub Actions 承擔；若要 BPMN 化另立 ADR。
- **只有新納管的系統使用 BPMN**（Q27=a）：不對進行中的系統做快轉導入；既有系統依 §9 重新納管。

### 2. 權威分層（修訂 `ADR-001`）（Q8=ii）

| 層 | 權威 | 內容 |
|---|---|---|
| **事實** | GitHub（不變） | Issue 是否存在、PR 是否合併、`stage/done`／`needs-human` 標籤、HG 簽核留言、`factory-run` 終態 |
| **流程位置** | 每個流程實例一個 Durable Object | token 位置、user task 的認領與表單草稿、事件日誌 |
| **定義** | git（PR 審核後發布） | BPMN 模板與系統檔 |

**硬規則**：token 的每一次前進都必須對應**一個 GitHub 事實或一個具名使用者動作**，並寫入事件日誌。DO 不得自行產生事實（例如不得自行判定「工作項已完成」）。DO 與 GitHub 不一致時，**GitHub 勝出**（§7）。

### 3. 自動化邊界：人按一下才派工（取代 `ADR-024` §1／§2）（Q7=B）

- 工作項 activity 先進入 **user task**：畫面顯示預填好的工單表單（PRD／DoD 由流程變數與既有 AI 草稿 `/api/v1/draft/*` 帶入）。
- **人確認送出之後**，流程才建 Issue 並派工 `factory-run`。HG0「送出即核准」的語意保留：核准仍是人按下的那一下。
- 被推翻的只有 `ADR-024` §2「UI 不得直接觸發 `factory-run`」——`/scoreboard/submit` 早已直接派工，實際治理變更很小。
- **`ADR-022` Q29-A 的語意保留**：下游工作項不會自動派工；流程只會讓下游 user task「出現在某人面前」，仍需人送出。
- 「節點宣告 `auto`、低風險類型免按」（Q7 選項 C）**不在本 ADR 啟用**；若要啟用須另立 ADR 並逐一裁決 HG0、`ADR-022`、`docs/24` §2.1。

### 4. BPMN 元素與工廠語意的對應

#### 4.1 工作項＝工廠擁有的子流程（Q21=c）

- 工廠發布一個可重用、**租戶不可修改**的子流程 `factory.work-item.v<N>`：

  ```
  userTask 填寫工單 → serviceTask 守衛檢查（§5）→ serviceTask 建 Issue（含 §6 標記）
    → serviceTask 派工 factory-run → message catch「終態」
       ├─ stage-done   → 完成
       └─ needs-human  → 錯誤路徑 → 回到「填寫工單」（重做）
  ```

- 租戶模板**只能放 callActivity** 指向該子流程，並以 `factory:taskType` 宣告類型（必須在工廠 task_type 白名單內）。HG0 與派工邏輯因此在機械上不可被租戶編輯改動。
- 模組層工作項以 **multi-instance** 展開，每個模組一份子流程實例；每一份都要人送出（`Q-ORCH-3` 的「批次建立」仍不採用）。

#### 4.2 完成事實＝`stage/done`（Q24=c）

工作項 activity 以 Issue 被貼上 `stage/done` 為完成——這是 `factory-stage-finalize` 依 `ADR-022` 判定的階段完成，已涵蓋 N-version 選勝者、人工覆寫與 PR 合併。`workflow_run` 成功只是中間事件，不推進 token。

#### 4.3 HG 閘門＝message catch，事實落在 GitHub（Q12=A、Q22=b）

- 閘門是 **message catch event**，不是 user task。
- 網頁上的「簽核」按鈕只做一件事：以 GitHub App **user-to-server token**、**使用者本人身分**在 Issue 貼結構化留言（`<!-- factory:gate id=… state=signed evidence=… -->`）。這是引擎之外的副作用。
- token 只在 webhook 收到留言、經 `src/hg/parse.ts` 驗證通過後才前進：簽核者名單（`factory:gateDef` 的 signers）、對 repo 的 write 權限、L 規模雙簽。**直接在 GitHub 上簽也有效**，網頁按鈕只是便利入口。
- 每位使用者需授權 GitHub App 一次；token 8 小時過期、需刷新。Cloudflare Access 的 JWT 只帶 email，因此需另行建立「使用者 ↔ GitHub 帳號」對應（`ADR-028` §5）。
- 帶 App 徽章的使用者留言是否被 `parse.ts` 判為本人簽核：**PoC 必驗**（`ADR-028` §7）。

#### 4.4 閘門撤回（Q23=c）

已簽的閘門被撤回時，**token 不倒退**（會與已存在的 Issue／PR 對不上）。實例標記為「漂移」，該閘門下游**所有尚未派工**的工作項由 §4.1 的守衛檢查擋下，直到重新簽核；已在執行的工作項不中斷。

#### 4.5 user task 的多人協作：認領制（Q29=b）

同一時間只有一人能編輯同一個 user task（接力棒），其他人即時觀看；可搶回認領權，搶回動作記入日誌。DO 單執行緒，送出天然序列化。

### 5. 模組清單在 HG2 凍結（Q30=b）

multi-instance 的模組集合在 HG2 簽核時取快照並寫入日誌。之後新增模組＝範圍改變：重簽 HG2，並在**下一個週期**（§8）生效。不在 BPMN 內引入動態結構。

### 6. 冪等鍵：修訂 `ADR-024` §5（Q28=b）

- 流程建立的 Issue，body 加隱藏標記：`<!-- factory:bpmn instance=<id> activity=<id> exec=<executionId> -->`。
- 理由：multi-instance 加上「重做」後，同一模組、同一步驟可能合法存在多張單，既有欄位組合無法區分。此標記同時是 §7「掛載」與 §8 週期銜接的關聯依據。
- DO 端以 **outbox** 執行副作用：先寫意圖 → 呼叫 GitHub → 記錄結果；重試前先以標記查 GitHub，確認未建立才重做。DO alarm（至少一次）、webhook 重送、驅逐後恢復都不得造成重複建單或重複派工。

### 7. 既有入口、流程外工單與 reconcile

- **既有開單入口全部保留**（Q25=c）：Backstage 表單、GitHub issue form、`/scoreboard/submit`、`factory/approved` 標籤。對已有 BPMN 實例的系統，外部開的單是「**流程外工單**」：看得到、不推進 token；人可以在網頁上手動把它**掛載**到一個正在等待的 activity（掛載動作補寫 §6 標記並記入日誌）。BPMN 穩定後再評估逐步收斂為「只能由流程開單」（屆時另立 ADR）。
- **reconcile**（Q26）：每日 cron 加手動「重新對帳」按鈕，從 GitHub 讀取現況，**只允許依同一套對應規則把 token 往前推，永不倒退**；對應不上的情況標為 `needs-attention` 交人處理。
- **降級路徑**：DO 不可用時，GitHub 上的工作照常進行（既有入口都在）；DO 恢復或還原後（`ADR-028` §4.4）執行一次 reconcile 補上期間的事實。

### 8. 流程實例的粒度與生命週期（Q11=a、Q37=b）

- **一個系統的一個週期＝一個實例＝一個 Durable Object**，id 為 `<tenant>/<system>#<cycle>`。
- 走到流程終點（例如 P5 演進完成，或模板定義的終點）實例即結束；下一輪 P0 開新實例，**採用當時系統檔所釘的模板版本**。
- 實例在週期內**釘住模板版本，不做熱遷移**（實測：定義改動可能讓等待中的實例靜默卡住，見 `research/56` §2）。

### 9. 流程定義：全部以 BPMN XML 為正本（取代 `ADR-025` §2 格式、`ADR-026` §1 格式）（Q9→Q42=a）

#### 9.1 三層都用 BPMN

| 層 | 位置 | 檔案 | 內容 |
|---|---|---|---|
| 工廠 preset | 機制 repo | `templates/factory/{S,M,L}.v<N>.bpmn` | 以**階段為單位的可呼叫流程**（`factory.M.v3.P0`…`P5`） |
| 租戶模板 | 機制 repo | `templates/<tenant>/<name>.v<N>.bpmn` | 同上；`factory:gateDef`（id／signers／scope／evidence）放在 process 層 `extensionElements` |
| 系統實例 | **專案 repo** | `factory/system.bpmn`（取代 `system.yaml` 與 `process.yaml`） | 一個可執行 process：依序以 callActivity 串起採用的階段，追加的步驟直接畫在後面；process 層 `extensionElements` 帶 `factory:system`（scale、scaleEvidence）與 `factory:modules`（id、paths、buildUnit、spec、readiness、readinessEvidence、owner、core） |

- `ADR-025` 的 meta-contract 不變，改由 linter 對 BPMN 執行（`ADR-028` §3）：四種 step 語意、task_type 白名單、P0–P5、必含 HG1/HG2/HG4/HG5/HG6、自訂閘門命名 `<TENANT>-<NAME>`、工廠 preset 不可重排。
- `scale`、`readiness` 及其 evidence **仍只能由人填寫**（`ADR-023` §2 的不變量保留），UI 與 CI 不得推導。
- `ADR-026` 的歸屬不變（系統 spec 歸專案 repo、讀取時驗證、名冊在機制 repo）；只換格式與檔名。
- **不屬於流程的檔案不改**：`processes/registry.json`（納管名冊）、`catalog-info.yaml`、`.github/factory/risk-paths.yml`。
- 命名規則：BPMN id 必須是 XML NCName，不能含 `/`、`@`，因此 `<tenant>/<name>@<N>` 一律寫成 `<tenant>.<name>.v<N>`（必要時把 `/` 轉成 `.`）。

#### 9.2 編輯與發布（Q10=c）

- 網頁編輯器的**草稿存 D1**（多人協作、預覽、模擬）。
- **「發布」才開 PR**（沿用 `/api/v1/process/pr` 的路徑白名單與伺服器端驗證模式，目標改為 `.bpmn`）；合併後產生**不可變**的版本號。改流程＝發新版。
- **已發布模板一律從機制 repo 的 `main` 讀取**，不從目標 repo 的 factory trunk 讀取，避免受 trunk 漂移影響（見「待決」`Q43`）。

#### 9.3 S/M/L 的遷移

刪除 YAML 之前，以程式一次性把 `templates/factory/{S,M,L}.yaml` 轉成 `.bpmn`（帶自動排版），之後以 XML 為正本、只用編輯器維護（Q35）。P0–P5 與 HG 的編排知識因此不隨 YAML 刪除而遺失。

### 10. 瀏覽器模擬模式（Q14）

同一份 BPMN、同一個引擎在瀏覽器執行無副作用的模擬，用於發布前驗證與對外展示；做法見 `ADR-028` §6。模擬是**建議性**的：通過模擬不代表權限、webhook、App 安裝或 agent 產出沒問題。

### 11. process.yaml 的退場：只往前刪除（Q39=B）

1. **自本 ADR 接受起凍結** process.yaml 相關程式與格式：不再新增功能，只修安全性問題。
2. PoC 依 `ADR-028` §7 驗收後，兩個 repo 各開一個 PR 刪除：
   - 機制 repo：`factory-graph`、`factory-next`、`factory-snapshot`（含 `factory-snapshot.yml`）、`factory-template`、`src/process/*`、`templates/**/*.yaml`、`processes/**/*.yaml`、`processes/samples/*`。
   - Scoreboard：`src/lib/process/*`、`src/components/process/*`（React Flow）、`/scoreboard/process/*` 頁面、`/api/v1/process/modules-pr`。
3. **保留**：`src/hg/parse.ts`、`factory-hg`（signers 改讀 BPMN 的 `factory:gateDef`）、Scoreboard 的存取控制強化（`tenant-access`、`page-access`、`rate-limit`、`retention`、輸入驗證）、「發布＝開 PR」端點模式。
4. 刪除前在兩個 repo 的 HEAD 打 `pre-bpmn` tag。
5. `tradingbot-tw/saga-pattern` 與 `agent-playground/restate-cloudflare-workers-poc` 視為新系統，重新以 BPMN 納管（與 §1「只有新系統」一致）。
6. **不採用**「回到 `1.2.0` tag 重新開發」：1.2.0 之後的提交混有 BPMN 直接依賴的 HG 解析器與存取控制強化，回退需改寫 main 歷史並逐一 cherry-pick（盤點見 `research/56` §8）。

## 後果

### 正面

- 流程可在網頁上以標準 BPMN 編輯、模擬、發布，並真正推進；「下一步該開哪張單」從 advisory 清單變成流程狀態。
- HG0、`ADR-022` Q29-A、GitHub 為事實來源三條底線保留：人仍按下每一次送出，token 只因 GitHub 事實前進。
- 工作項與閘門的治理邏輯集中在工廠擁有的子流程與 linter，租戶編輯無法繞過。
- 一種格式（BPMN）、一套 linter、一種 PR，取代 YAML 模板＋系統 spec＋模組清單三套格式。
- 失敗模式明確：DO 掛掉不阻斷 GitHub 上的工作；不一致由 reconcile 只往前修正。

### 負面

- 新增一個有狀態的執行平面（Durable Object）與事件日誌，需要維運、備份與監控。
- 每位簽核者須授權 GitHub App；需建立 Access email ↔ GitHub 帳號對應與 token 刷新。
- Issue body 新增隱藏標記，推翻 `ADR-024` §5 的「不新增隱藏標記」。
- `factory:` 擴充資料（scale、modules）在 Camunda Modeler／bpmn-js 中不可見，只能透過工廠自己的表單編輯；手改 XML 比改 YAML 困難。
- 模組與 scale 同檔，CODEOWNERS 無法在檔案內分開指派審查者。
- 既有兩個真實系統需重新納管；`/scoreboard/process/*` 在 PoC 驗收前維持凍結狀態。
- 長壽實例釘住舊版本，模板改進要到下一個週期才生效。

### 中性

- 既有開單入口在過渡期保留，流程外工單與流程內工單並存。
- reconcile 與 DO 還原後補事實共用同一條程式路徑。

## 替代方案

| 方案 | 為何未採用 |
|---|---|
| 維持 `ADR-023`／`ADR-024`（只呈現、產生清單） | 無法滿足「執行自動化」「即時監控」「網頁編輯」；`docs/31` §0 的缺口只被部分解決。 |
| 純瀏覽器引擎（如 0dep.se/run） | 瀏覽器不能是狀態權威：關閉頁面即失、無法多人、無法稽核，且不能持有 GitHub App 憑證。 |
| BPMN 引擎取代 GitHub Actions 執行 factory-run | 需重建 runner、log、artifact、secret、matrix、185 分鐘 job；等於重寫 CI（Q13 non-goal）。 |
| 全自動派工（Q7=A） | 推翻 HG0、`ADR-022`、`docs/24` §2.1；一條錯誤的 sequence flow 可能一次派出多張高成本 agent 工單。 |
| DO 為全部權威（Q8=i） | 與 `factory-stage-finalize`、`factory-stage prereqs`、`hg/parse.ts` 形成雙重判定，分裂狀態無從裁決。 |
| 閘門為 user task、按鈕即推進（Q22=a） | 簽核證據不落在 GitHub，也無法驗證簽核者權限；直接在 GitHub 上簽將失效。 |
| 撤回時 token 倒退（Q23=b） | BPMN 無乾淨的倒退語意，會與已存在的 Issue／PR 對不上。 |
| 快轉重播導入既有系統（Q27=b） | 使用者裁決只對新系統啟用，降低首版範圍。 |
| 模組清單維持 YAML（Q42=b） | 模組變更已是 HG2 治理事件（§5）；兩套格式的成本高於收益。 |
| 回到 `1.2.0` 重新開發（Q39=A） | 見 §11.6。 |
| 雙軌長期並存（Q39=C） | 需長期維護兩套流程語言的語意一致。 |

## 待決

| 編號 | 事項 |
|---|---|
| `Q43` | factory trunk 漂移：機制 repo `software-factory` 落後 main 140 個 commit；Scoreboard 遠端 `software-factory` 分支已不存在（接入條件 #2 不成立）。建議 fast-forward／重建並設為 protected branch；**涉及遠端分支，待使用者決定或授權後執行**。§9.2「模板一律從機制 repo main 讀取」不受此影響。 |
| `Q-ORCH-3` | 批次建立 N 張工作項（人按一次建多張）仍不採用；multi-instance 每份各自送出。 |
| Q7 選項 C | 低風險類型免按送出的條件與審核方式，另立 ADR。 |
| 入口收斂 | 何時把既有入口收斂為「只能由流程開單」（Q25 的後續）。 |

## 重評觸發條件（任一成立即重新檢視）

1. 人按送出被實測證實為瓶頸（例如一個週期內單一階段需送出 > 10 張），且有足夠證據支持低風險類型自動派工。
2. reconcile 的 `needs-attention` 比例持續偏高，表示「GitHub 事實 → token」的對應規則不足。
3. `parse.ts` 無法將 user-to-server token 貼出的留言認定為本人簽核，且無替代方案（屆時退回「人自行在 GitHub 簽核」）。
4. `ADR-028` 的 PoC 任一驗收項目失敗且無法在技術選型層解決。
