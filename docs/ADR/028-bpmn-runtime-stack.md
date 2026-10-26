# ADR-028：BPMN 執行技術選型——bpmnkit、Durable Object 事件日誌與 PoC 驗收

- **狀態**：提議中（2026-10-26；PoC 依 §7 驗收後改為「已接受」）
- **日期**：2026-10-26
- **決定者**：使用者（經 grilling 逐題裁決；Q15–Q20、Q32–Q36、Q38、Q40、Q41）
- **對應**：`ADR-027`（語意與治理；本 ADR 只決定「怎麼做」）、`research/56-bpmn-orchestration`（實測證據）、`ADR-015`（Scoreboard 平台：Astro＋Workers＋D1）、`ADR-006`（GitHub App 身分）

## 脈絡

`ADR-027` 決定由 BPMN 編排系統價值流，流程位置由 Durable Object（DO）權威、GitHub 為事實來源。本 ADR 選擇實作技術。治理語意變動慢、技術選型變動快，因此分開記錄：之後更換引擎或編輯器只需修訂本 ADR。

三次實測的關鍵事實（細節與出處見 `research/56`）：

- **bpmn-engine 26.0.5 在 workerd 一 import 即崩潰**（`createRequire(fileURLToPath(import.meta.url))`）；修補後可在 DO 內 `getState → recover → resume`。bpmn-elements 本身不帶任何 `node:*` import。
- **Workers 禁止 `eval`／`new Function`，`node:vm` 只是 stub**：JavaScript script task 與 JS 條件式一律不能執行；`${}`、FEEL、service task 可用。
- **計時器**：預設 `setTimeout` 在 DO 被驅逐時遺失、會阻止 hibernation；延遲 ≥ 約 24.8 天根本不會排程。
- **定義改動會讓等待中的實例靜默卡住**，且沒有遷移 API。
- **bpmnkit**：MIT、無浮水印；編輯器 147.6 KiB gz、`exportPreserving` 只產生最小 diff、帶 `factory:*` 往返 0 差異；引擎**自稱模擬器**、沒有 snapshot，但在 DO 以「重播輸入日誌」恢復已實測可行（強制驅逐 3 次，路徑正確、副作用不重複）。語意缺口：receiveTask 不等待、沒有 worker 的 task 直接完成、inclusive join 不等待。約一位維護者、專案 8 個月。
- **WanderSaga**（`CamundaSagaPatternExample`，已部署於 Cloudflare Workers）以 `@bpmnkit/engine` 在 production 跑平行分支、user task、補償事件與 `onChange` → WebSocket；但只存在 isolate 記憶體，無持久化、無多人。**實測**（`research/56` §4.1、§4.2）：初版一次完整 Saga 25–38 ms CPU、每節點約 1 ms，SSE 每 500 ms 輪詢的閒置連線佔當日 CPU 約 78%；加入「BPMN AST 模組層級快取＋啟動預熱」與「事件驅動 SSE」後，完整 Saga 降到 10–20 ms（中位數約 -58%）、每事件約 0.4–0.5 ms，閒置連線成本降到約 0.1 ms／秒。HTTP 備援路徑跨 isolate 時 404／400，證實純記憶體狀態無法跨請求。
- **帳號方案**：Workers Paid（2026-11-01 續約），每次請求 CPU 上限預設 30 s。
- **Astro `main: src/worker.ts` 可在同一 Worker 匯出 DO**（實測 build 與執行成功）；Worker bundle 588 → 726 KiB（含 bpmn-engine）。1 MiB 是專案自訂門檻，Cloudflare 上限為 64 MiB 未壓縮。

## 決策

### 1. 引擎：bpmnkit 全環境使用，DO 以事件日誌為準（Q15）

- **權威實例、瀏覽器模擬、編輯器、檢視器、linter 全部使用 bpmnkit**（`@bpmnkit/engine`、`@bpmnkit/core`、`@bpmnkit/editor`、`@bpmnkit/canvas`）。整套只有一種 BPMN 方言，避免「編輯器說合法、引擎讀不懂」。
- **事件日誌是真相，引擎是重播日誌的函式**：每一個輸入（啟動變數、使用者送出、GitHub 事實 message、service task 結果）以遞增序號 append 到 DO SQLite。DO 被驅逐後喚醒時，由日誌重播重建引擎狀態；重播期間 service task 一律從日誌取既有結果，**不重新執行副作用**。
- **記憶體快取＋冷喚醒重播**：DO 醒著時把引擎實例留在記憶體，新事件直接送進執行中的引擎並 append 日誌（熱路徑，每事件約 0.5 ms 量級）；**只有 DO 冷啟動（被驅逐後喚醒、部署更新）才從日誌重播**。重播成本約與日誌長度成正比（每事件約 0.4–0.5 ms 推估，200 筆事件約 100 ms），因此不得在每個請求都重播。
- **definitions 快取（沿用 WanderSaga `getOrPrepareDefinitions` 的做法）**：解析 BPMN、套用轉接層後的 definitions 以「模板 id＋版本＋內容雜湊」為鍵存在**模組層級**快取；同一 isolate 內的多個 DO 共用，每個實例只做 `new Engine()`＋`deploy`。快取物件**視為唯讀**（測試須以 deep-freeze 驗證引擎不會修改它）。模組初始化時只預熱固定的小集合（`factory.work-item` 子流程、S/M/L preset），租戶模板第一次用到時才解析，避免拉長 isolate 啟動時間。日誌是真相，記憶體中的引擎只是快取：快取與日誌不一致時一律丟棄快取、重播日誌。若實測冷喚醒重播成本過高，可在日誌之外加「引擎可序列化狀態」的快照作為加速（仍以日誌為準）。
- **引擎包在與引擎無關的 adapter 介面後面**（§6.1 的 `createRuntime`）。退場方案：bpmn-elements（有原生 snapshot）。更換引擎＝實作同一介面＋以既有日誌重播驗證，`ADR-027` 不受影響。
- **版本釘死**：每個實例同時釘住「模板版本」與「引擎版本」；`package.json` 使用確切版本（不得用 `^`／`~`）。
- **確定性要求**：重播必須得到相同路徑，因此 id 與時鐘由外部注入；linter 禁止 FEEL 的 `now()`、`today()` 與隨機函式（§3）。
- **不採用 bpmn-engine**：import 崩潰需長期維護 patch，且其 recover 層與我們自有的日誌模型重疊。
- 實作可直接移植 WanderSaga 的模式：job worker 註冊、握住 user task 的 job 直到人送出、`onChange` 廣播、`camunda:topic` → `zeebe:taskDefinition` 轉接層（`CamundaSagaPatternExample/src/bpmn.js`）。

### 2. 編輯器與檢視器（Q33、Q34）

- **編輯器：`@bpmnkit/editor`**（含 toolbar、sidebar、通用屬性面板，約 147.6 KiB gz）。**不引入** Camunda 專用面板（會拉入連接器目錄，約 577 KiB gz）。`factory:*` 屬性以 `registerSchema(type, schema, adapter)` 註冊表單。
- **存檔使用 `exportPreserving(original, defs)`**：發布 PR 的 diff 只包含實際變更。
- **監控檢視器：`@bpmnkit/canvas`**（約 77 KiB gz），與編輯器同一套渲染，保證「編輯時的圖」與「監控時的圖」一致。前提：PoC 證明它支援 token 位置與狀態的 overlay／marker；**不支援則改用 bpmn-js NavigatedViewer**（約 56 KiB gz，需保留 bpmn.io 浮水印）。
- **退場條件（編輯器、檢視器、引擎共用）**：上游 6 個月無發版、升級造成資料遺失或語意改變、或授權改變。退場時模板仍是標準 BPMN＋`factory:` 命名空間，已驗證 bpmn-moddle 可讀。
- 只使用公開 API；編輯器的 DOM 與 class 名稱不是公開 API，不得依賴。
- bundle：編輯器與檢視器只載入瀏覽器端，不計入 Worker bundle；以 Astro island（`client:only`）延遲載入，只在編輯與監控頁面出現。

### 3. 表達式、命名空間與 linter（Q16、Q17、Q35、Q36）

- **表達式只允許 FEEL**；業務邏輯一律放在 service task（工廠撰寫的 TypeScript handler）。流程圖不承載程式碼，這同時是安全邊界：租戶無法透過模板注入程式碼。
- **v1 不支援計時器事件**（Q17）。逾時提醒以每日 cron 掃描「停在同一 activity 超過 N 天」的實例實作。持久計時器（timers → DO alarm 轉接）列為第二階段。
- **命名空間**（Q36）：
  - `factory:`（工廠自有，發布 XSD／moddle descriptor）承載治理語意：`taskType`、`phase`、`gate`、`gateDef`（signers、scope、evidence）、`system`、`modules`。
  - `zeebe:*` 只用引擎需要的子集：`taskDefinition`、multi-instance 的 collection、message 的 correlationKey。
- **linter**：`@bpmnkit/core` 的 `lintDiagram` 加上工廠自寫的 TypeScript 規則，**CI（Node）與瀏覽器（發布前）各跑一次，規則相同**。發布 PR 的 required check 必須通過 linter。規則至少包含：
  1. `ADR-025` meta-contract：task_type 白名單、P0–P5、必含 HG1/HG2/HG4/HG5/HG6、自訂閘門命名 `<TENANT>-<NAME>` 且須以 `factory:gateDef` 宣告、工廠 preset 不可重排。
  2. 工作項必須是 callActivity 指向 `factory.work-item.v<N>`（`ADR-027` §4.1）。
  3. 禁止：scriptTask、非 FEEL 的條件式、所有 timer 事件、receiveTask（改用 intermediate message catch）、inclusive／complex gateway 匯流、FEEL 的 `now()`／`today()`／隨機函式。
  4. 每個 `zeebe:taskDefinition` type 都必須在工廠 handler 註冊表內（對應 bpmnkit「沒有 worker 的 task 直接完成」的缺口）。
  5. id 為 NCName 且符合 `<tenant>.<name>.v<N>[.P<k>]` 命名；`<bpmn:definitions>` 必須帶 `targetNamespace`（bpmnkit parser 要求）。
  6. `scale`、`readiness` 必須附 evidence。
- **S/M/L 遷移**（Q35）：以 `@bpmnkit/core` builder 從 `templates/factory/{S,M,L}.yaml` 一次性產生帶自動排版的 `.bpmn`（builder 不支援自訂屬性，於 `build()` 後補上 `factory:` 屬性與命名空間，已驗證可正確匯出）。之後以 XML 為正本。

### 4. Durable Object 執行平面

#### 4.1 部署落點（Q18）

- **先與 Scoreboard 放在同一個 Worker**：wrangler 設 `main: ./src/worker.ts`，同時匯出 Astro 的 `handle()` 與 DO class（`ProcessInstance`），共用 D1、Cloudflare Access 驗證、`tenant-access` 與 webhook 轉送站。
- **拆分觸發條件**：Worker 壓縮後 bundle > 900 KiB，或 DO 需要獨立的部署節奏。拆分時改為獨立 Worker，以 `durable_objects.bindings[].script_name` 綁定。
- 同步更新過時的註解：`astro.config.mjs` 的 bundle 基線（現為 588 KiB）、`scripts/check-bundle-size.mjs` 的平台上限（Cloudflare 現為 64 MiB 未壓縮）。

#### 4.2 DO 內部資料

每個 DO（`<tenant>/<system>#<cycle>`）的 SQLite：

| 表 | 用途 |
|---|---|
| `journal` | append-only 事件日誌：`seq`、`kind`（start／human／fact／effect_result）、`payload`、`actor`、`at` |
| `outbox` | 副作用意圖：`key`（instance／activity／exec）、`type`、`status`、`attempts`、`result` |
| `claims` | user task 認領（`ADR-027` §4.5）與表單草稿 |
| `meta` | 模板版本、引擎版本、週期、漂移與 `needs-attention` 旗標 |

- outbox 執行順序：寫意圖 → 呼叫 GitHub → 寫結果到 journal；重試前先以 `ADR-027` §6 的標記查 GitHub。
- 不在記憶體掛 `setTimeout`／`setInterval`（會阻止 hibernation）；需要延後處理一律使用 DO alarm（每個 DO 一個，需自行多工）。
- 執行中的引擎實例以 DO 的記憶體欄位保存（§1 記憶體快取）；DO 的 constructor 只做「標記需要重播」，實際重播延到第一個需要引擎的請求，以 `blockConcurrencyWhile` 包住，避免並行請求看到半重建的狀態。

#### 4.3 實例索引（Q41）

D1 新增一張**只存中繼資料**的表 `process_instances`：實例 id、tenant、system、cycle、模板版本、引擎版本、狀態、目前 activity 摘要、`updated_at`。**不存日誌**。DO 在狀態變化時順便寫入；寫入失敗不影響 DO，下次狀態變化時補寫。用途：Scoreboard 總覽頁、每日 reconcile 與提醒的掃描清單、§4.5 升級閘門的實例清單。

#### 4.4 備份與災難復原（Q38）

- 使用 SQLite-backed DO 內建的 **Point-in-Time Recovery**：`getBookmarkForTime()`＋`onNextSessionRestoreBookmark()`，可把單一 DO 還原到過去 30 天內任一時間點。
- **還原後必須接著執行一次 reconcile**（`ADR-027` §7）：還原會倒回 bookmark 之後的日誌，但 GitHub 事實不會倒回。
- **部署禁止事項**：不得以 `deleted_classes` migration 刪除 DO class（不在 PITR 保護範圍）；DO class 的 rename／transfer 須經人審。
- 殘餘風險：超過 30 天才發現的錯誤無法以 PITR 還原。

#### 4.5 引擎升級閘門（Q40）

升級 bpmnkit 版本前，CI 依 §4.3 的索引取得所有進行中實例，呼叫各 DO 的 `exportJournal()` RPC，以新版引擎重播；另加 §6.4 的黃金日誌。**任一實例的路徑或結果不同即擋下升級**。

#### 4.6 即時監控傳輸（Q19）

- **DO WebSocket Hibernation**（`ctx.acceptWebSocket`、tag 為使用者與角色）：每個實例的 DO 直接廣播 `onChange` 衍生的 token 事件與認領狀態，閒置後自動 hibernate。
- 連線時先送完整快照，之後送增量；前端以 journal `seq` 去重與補洞。
- WebSocket 升級請求在進入 DO 前，必須通過 `page-access`（Access JWT）與 `tenant-access` 檢查。
- `serializeAttachment` 上限 16 KiB，只存連線身分，不存狀態。
- **事件驅動，零定時喚醒**：DO 只在「有新事件」時廣播；心跳用 `ctx.setWebSocketAutoResponse` 讓平台直接回應 ping/pong，不喚醒 DO（比 WanderSaga 的 30 s SSE keepalive 更省）。連線中斷時在 `webSocketClose`／`webSocketError` 立即移除訂閱。
- 流程結束（或實例進入終態）時由 DO 主動以 close code 關閉所有連線，不依賴 client 關閉。
- 延後的清理（例如結束後保留快照一段時間再釋放記憶體）一律用 DO alarm，不用 `setTimeout`（WanderSaga 的 5 分鐘 `setTimeout` 清理在 DO 中會阻止 hibernation 並持續計費）。

#### 4.7 Cloudflare 方案（Q20）

**正式環境與 PoC 都使用 Workers Paid**（帳號已是 Paid，2026-11-01 續約）。原先「先用 Free、達門檻再升級」的方案已由實測否決：WanderSaga 初版一次完整 Saga 要 25–38 ms CPU（P99 55 ms），優化後仍需 10–20 ms，都超過 Free 每次請求 10 ms 的上限；日誌重播的冷喚醒成本還會隨日誌長度成長（`research/56` §4.1、§4.2）。
- **Smart Placement 不適用於 DO**：Smart Placement 只影響無狀態 Worker 的執行位置，且依據 subrequest 的後端位置判斷（WanderSaga 沒有 subrequest，預期無效）。DO 的位置在第一次建立時決定、之後固定；是否以 `locationHint` 讓 DO 靠近 GitHub API 或靠近使用者，列入 PoC 量測（WebSocket 延遲 vs GitHub 呼叫延遲）。

- Paid 每次請求 CPU 上限預設 30 s，可用 `limits.cpu_ms` 調整（最高 5 分鐘）。PoC 先使用預設值，依實測的冷喚醒重播成本決定是否調整。
- **成本監控**：以 GraphQL Analytics（`workersInvocationsAdaptive`、DO 的對應資料集）追蹤 CPU 分位數、請求數與 DO duration；PoC 期間每週檢視一次。
- **防止閒置連線燒 CPU**：不得使用輪詢迴圈（WanderSaga 初版的 SSE 每 500 ms 醒來一次，閒置連線佔當日 CPU 約 78%；改為事件驅動後降到約 0.1 ms／秒）；WebSocket 一律走 Hibernation API 與 auto-response（§4.6）；流程結束時由伺服器主動關閉連線。

### 5. GitHub 與身分整合

- **webhook 轉送站擴充**（`src/lib/github-webhook.ts`）：除了現有三種事件，新增把 `stage/done`、`needs-human`、`factory:gate` 簽核留言、帶 `factory:bpmn` 標記的 Issue 事件轉送到對應的 DO。轉送站仍**不做業務判斷**：閘門留言的驗證由 `src/hg/parse.ts` 的同一份規則執行（Worker 端以 vendored 或共用套件引用，判定規則只寫一次）。
- **使用者身分**：Cloudflare Access JWT 只有 email。使用者首次簽核或送出時，走 GitHub App 的 web application flow 取得 user-to-server token，建立「Access email ↔ GitHub login」對應；token 加密存放於 D1，到期以 refresh token 更新。日誌的 `actor` 記錄 GitHub login。
- **派工**沿用現有 `github-app.ts` 的 installation token（`workflow_dispatch`）；只有「以本人身分留言」使用 user-to-server token。
- `factory-hg` CLI 的 signers 來源改為讀取 BPMN 模板的 `factory:gateDef`（取代 `loadTemplate()`）。

### 6. 瀏覽器模擬模式：service task stub（Q32、Q14）

#### 6.1 原則與埠

**只把 I/O 邊界換成 stub，所有純邏輯照真的跑**：Issue body 組裝（`buildIssueBody`）、`factory:bpmn` 標記產生、守衛判斷在模擬時都真的執行，只有「呼叫 GitHub」被替換。

```ts
// runtime/core：不碰任何 I/O；瀏覽器、DO、Node CI 共用
interface EffectHandlers {                     // 依 zeebe:taskDefinition type 分派
  'factory.issue.create'(c: Ctx, i: IssueDraft): Promise<{ issueNumber: number; url: string }>
  'factory.run.dispatch'(c: Ctx, i: DispatchInput): Promise<{ runId: number | null }>
  'factory.gate.guard'(c: Ctx, i: GuardInput): Promise<{ allowed: boolean; reason?: string }>
}
interface FactSource {                         // GitHub 事實 → message
  subscribe(deliver: (m: { name: string; correlationKey: string; vars?: object }) => void): void
}
interface HumanPort {                          // user task 的等待與完成（認領制）
  onWaiting(task: PendingUserTask): void
  complete(taskKey: string, vars: object, actor: string): void
}
createRuntime({ definitions, handlers, facts, humans, journal, ids, clock })
```

| 埠 | DO（正式） | 瀏覽器（模擬） |
|---|---|---|
| `handlers` | `runtime/live`：GitHub App＋outbox | `runtime/sim`：stub |
| `facts` | webhook → DO RPC | 情境腳本或按鈕注入 |
| `humans` | WebSocket＋認領制 | 自動完成或手動點按 |
| `journal` | DO SQLite | 記憶體／localStorage |
| `ids`、`clock` | 真實值 | 遞增序號、固定時鐘 |

#### 6.2 stub 行為

| task type | 模擬行為 |
|---|---|
| `factory.issue.create` | 真的執行 `buildIssueBody` 與標記產生；回傳 `issueNumber = 1000 + 序號`、`url = sim://issue/<n>`；記錄面板顯示「將建立的 Issue」完整標題、body、labels |
| `factory.run.dispatch` | 回傳假 runId；依情境腳本把該工作項的結果排入事實佇列 |
| `factory.gate.guard` | 真的執行守衛邏輯，依模擬中的漂移／撤回狀態判斷 |
| userTask（`factory.form.work-item`） | 自動模式以預填表單完成；步進模式顯示表單等人點擊（沿用 WanderSaga「握住 job」做法） |

#### 6.3 情境腳本

與模板版本一起存放，同時是 CI 測試資料：

```json
{
  "template": "factory.M.v1",
  "modules": ["billing", "settlement"],
  "humans": "auto",
  "workItems": { "default": "success", "P3.add-tests[billing]": ["failed", "success"] },
  "gates": { "HG2": { "signedBy": "alice" }, "HG5": "revoke-after-sign" }
}
```

結果詞彙沿用 `factory-run` 的 `dry_run_scenario`：`success` → 送出 `stage-done`；`failed`／`guardrail` → 送出 `needs-human` 走重做路徑；`blocked` → 不送事實，畫面顯示卡住。事實以 `deliverMessage(name, vars, correlationKey)` 送入，correlationKey 即 `ADR-027` §6 標記內容。執行模式分 **Run**（自動跑完）與 **Step**（每個事實或人工步驟需點擊）；動畫沿用 `onChange`＋canvas overlay，與正式監控同一套程式。

#### 6.4 防止「模擬通過、正式卡住」

1. **啟動時檢查 handler 齊全**：列出定義內所有 taskDefinition type，任一缺 handler 即拋錯（模擬與正式皆同）。
2. **確定性**：見 §1；DO 重播需要同樣的確定性。
3. **黃金日誌**：CI 在 Node 以 stub handler 跑 S/M/L 全部情境，日誌存為快照（格式與 DO 相同，併入 §4.5 升級閘門）。另以「正式 handler＋假 GitHub stub server」再跑一次，兩次日誌除 id 外必須相同，藉此同時驗證正式 adapter。

#### 6.5 隔離

- 瀏覽器 bundle 只能 import `runtime/core` 與 `runtime/sim`；CI 掃描建置產物，出現 `runtime/live` 或 `api.github.com` 即失敗（與 `pnpm size` 同類閘門）。
- 模擬頁面設定 CSP `connect-src 'self'`。
- 瀏覽器本來就不持有任何 token。
- 模擬頁面明示無法證明的事項：GitHub 權限、App 安裝、webhook 送達、agent 實際產出、rate limit。

### 7. PoC 驗收標準

PoC 在 Scoreboard repo 實作，全部通過後本 ADR 與 `ADR-027` 改為「已接受」，並啟動 `ADR-027` §11 的刪除 PR。

| # | 項目 | 通過條件 |
|---|---|---|
| 1 | 模擬 | S/M/L 三個 `.bpmn` 在瀏覽器模擬跑到終點，且通過 linter |
| 2 | 權威實例 | DO 內完成一個工作項循環：user task 送出 → 建 Issue（帶標記）→ `workflow_dispatch` → webhook 收到 `stage/done` → token 前進 |
| 3 | 耐久性 | 流程中途強制驅逐 DO 3 次，最終路徑正確，副作用一次都不重複 |
| 4 | 閘門 | 以 user-to-server token 貼 HG 留言，經 `parse.ts` 驗證後 token 前進（含驗證 App 徽章留言被認定為本人） |
| 5 | 即時監控 | 兩個瀏覽器同時連線，都即時看到 token 移動與認領狀態 |
| 6 | 編輯與發布 | 編輯器改一個 task 名稱，發布產生 1 行 diff 的 PR；bpmn-js 可開啟同一檔案 |
| 7 | 成本與預算 | 實測並記錄：熱路徑每事件 CPU、冷喚醒重播 CPU 與日誌長度的關係（至少 50／200／500 筆）、DO 冷喚醒頻率；冷喚醒重播 500 筆事件的 CPU 須遠低於 30 s 上限；Worker 壓縮後 bundle < 900 KiB |
| 8 | 結構驗證 | bpmnkit 保留 process 層 `extensionElements`（`factory:system`、`factory:modules`、`factory:gateDef`）；跨檔案 callActivity 以版本化 id 解析成功 |
| 9 | 檢視器 | `@bpmnkit/canvas` 支援 overlay／marker；不支援則改用 bpmn-js NavigatedViewer 並記錄 |
| 10 | 還原 | 以 PITR 還原一個 DO 後執行 reconcile，token 正確前進到 GitHub 現況 |
| 11 | 快取與閒置成本 | 同一 isolate 內多個 DO 共用 definitions 快取，deep-freeze 測試證明引擎不修改它；閒置 WebSocket 在 auto-response 下不喚醒 DO（以 DO duration／Analytics 驗證）；量測有無 `locationHint` 時的 WebSocket 與 GitHub 呼叫延遲 |

## 後果

### 正面

- 單一工具鏈（bpmnkit）涵蓋編輯、檢視、檢查、模擬與執行，BPMN 方言一致。
- 事件日誌同時提供耐久性、稽核、確定性重播與引擎升級驗證；引擎可替換。
- 與 Scoreboard 同 Worker，重用 D1、Access、租戶隔離與 webhook 轉送站，增量最小。
- 編輯器無浮水印、PR diff 可讀，符合「發布＝開 PR」。
- 模擬與正式共用核心，模擬結果有實際參考價值。

### 負面

- bpmnkit 引擎官方定位為模擬器、約一位維護者、專案年輕：需釘死版本、自備重播日誌與升級閘門。
- 自行實作的範圍不小：日誌與重播、outbox、DO alarm 多工、WebSocket 廣播、使用者 token 管理、linter 規則。
- v1 沒有計時器事件，逾時提醒依賴外部 cron。
- PITR 只涵蓋 30 天。
- Worker bundle 預算縮小（726/1024 KiB 起，需再加 runtime 與 handler）。

### 中性

- `zeebe:*` 子集讓模板可被 Camunda Modeler 與 bpmnkit 工具鏈讀懂，但不代表會部署到 Camunda 8。
- 需要 Workers Paid（帳號已是 Paid）；成本主要來自 DO duration 與 CPU，PoC 期間以 Analytics 追蹤。

## 替代方案

| 方案 | 為何未採用 |
|---|---|
| bpmn-elements（snapshot）為權威引擎＋bpmnkit 編輯器 | 兩套 BPMN 解讀（moddle descriptor 與 bpmnkit model）需同步；保留為退場方案。 |
| 修補後的 bpmn-engine | import 崩潰需長期維護 patch；其 recover 層與自有日誌模型重疊。 |
| bpmn-js Modeler | 匯出重排整份檔案，每次 PR 都是整檔 diff；浮水印須保持可見；165 KiB gz。 |
| 模擬改用 bpmnkit、正式用 bpmn-elements | 語意缺口會造成「模擬通過、正式卡住」或反之。 |
| Cloudflare Workflows | 流程是程式碼而非 BPMN 模型；無法以網頁編輯器編輯。 |
| 允許 JS script task（QuickJS-wasm 沙箱） | 等於在 Worker 內自建 runtime，且讓租戶可注入程式碼。 |
| SSE 或輪詢 D1 | SSE 長連線阻止 DO hibernation；輪詢有延遲且需另行投影狀態。 |
| 獨立 Worker 承載 DO（一開始就拆） | 需複製 Access、租戶隔離、rate-limit、retention；先同 Worker，以 §4.1 觸發條件決定拆分。 |
| 日誌鏡像到 D1 作災難復原 | 使用者裁決改用 DO 內建 PITR；D1 只存中繼資料索引（§4.3）。 |
| 同一 Worker 打包多個引擎版本 | bundle 與維運複雜度隨版本數成長；改以升級閘門（§4.5）。 |

## 重評觸發條件（任一成立即重新檢視）

1. bpmnkit 引擎提供原生 snapshot 與持久計時器，或移除「模擬器」定位 → 評估移除自製重播層的部分功能。
2. 任一退場條件成立（§2）→ 改用 bpmn-elements／bpmn-js。
3. PoC §7 任一項目失敗。
4. Worker bundle 超過 900 KiB，或 DO 需要獨立部署節奏 → 拆分 Worker。
5. 冷喚醒重播的 CPU 接近每次請求上限，或 DO duration 成本明顯偏高 → 加入引擎狀態快照作為重播加速，或調整 `limits.cpu_ms`。
6. 需要計時器事件的流程需求出現 → 啟動 timers → DO alarm 轉接（第二階段）。
