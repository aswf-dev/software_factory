# Backstage 工作項歷史查閱（Create 分頁）設計

- 日期：2026-09-10
- 狀態：設計已確認，待實作
- 相關：`docs/ADR/009-backstage-partial-unfreeze.md`、`docs/03-idp-backstage.md` §3.4、`backstage/versions.md`

## 1. 問題

Backstage「開立 Factory 工作項」表單送出後，使用者無法在 UI 上回溯當時填了什麼。

現況查證（2026-09-10，於 `../backstage-app` Backstage 1.53.0 / `@backstage/plugin-scaffolder@1.38.1` 實際讀碼與查 DB）：

| 位置 | 看得到什麼 | 依據 |
|---|---|---|
| `/create/tasks` 清單 | 只有 Task ID / Template / Created / Owner / Status 五欄 | `ListTasksPage.esm.js` 欄位寫死 |
| `/create/tasks/:taskId` | 步驟、log、`output.text`（僅含 `oneLiner` 與 `taskType`） | `OngoingTask.esm.js` + 本專案 template 的 `output` |
| 「Start Over」選單 | 完整表單原值——但會開一張**新表單**，不是唯讀檢視 | `OngoingTask.esm.js` 讀 `task.spec.parameters` |
| scaffolder DB | 完整 `spec.parameters`（43 筆任務實查） | `packages/backend/backstage-db/scaffolder.sqlite` |

資料一直都在，缺的是唯讀的查閱介面。

## 2. 目標與非目標

**目標**：回溯稽核——查出某次工作項是誰、在何時、用什麼 PRD 內容、開了哪張 Issue。

**非目標**：
- 不做「複製舊單重開」（內建 Start Over 已涵蓋）。
- 不做除錯用的 parameters ↔ Issue body 並排比對。
- 不涵蓋 factory-work-item 以外的 template（其餘仍走內建 Tasks 分頁）。
- 不重造 log 檢視（連回內建任務詳情頁）。

## 3. 決策與理由

| 決策 | 理由 |
|---|---|
| 在 Create 頁新增 SubPage tab，而非覆寫內建 Tasks 分頁 | 覆寫等於 fork 官方頁面，其他 template 的歷史會被我們的實作取代，升版維護成本高 |
| 擴充現有 `factory-draft` 前端 module，不新開插件包 | 新插件包需改 `../backstage-app` 的 `package.json` + `App.tsx` + `yarn install`，那是另一個 repo（philipz/backstage-app）。擴充既有 module 則**零 backstage-app 改動**，全部落在本 repo、跟著 CI 與對抗性測試走 |
| Issue 連結採「template 加 `output.links` + 舊任務 fallback 解析 log」並行 | 新單走結構化欄位（乾淨）；DB 內既有 43 筆只在 log 字串中留有 URL，稽核需要 100% 覆蓋 |
| 詳情做成獨立路由而非展開列或彈窗 | 稽核情境需要可分享的網址；與內建 Tasks 分頁的結構一致 |
| 純函式抽到 `src/work-item-history/` | 本 repo 的 vitest 只收 `src/**` 與 `test/**`，且 `src/**` 有 80% 覆蓋率門檻；邏輯放這裡才受測試保護。已有先例：`factory-draft-backend` import `../../../../src/factory-draft/prompts.ts` |

## 4. 架構

Create 頁新增 tab「工作項歷史」，路徑 `/create/work-items`。

```
backstage/plugins/factory-draft/src/
  index.tsx                              module 組裝與擴充註冊（僅此職責）
  draft-field/DraftFieldComponent.tsx    現有 LLM 草稿欄位（自 index.tsx 搬出）
  work-item-history/
    SubPage.tsx                          <Routes>：index → 清單；:taskId → 詳情
    HistoryList.tsx                      清單表格
    HistoryDetail.tsx                    唯讀詳情

src/work-item-history/
  task-record.ts                         純函式
  task-record.test.ts                    vitest
```

現有 `index.tsx` 為 252 行，同時承擔「草稿欄位實作」與「module 組裝」兩件事。本次一併拆開，屬於為本工作服務的針對性整理，不做無關重構。

擴充註冊（加入 `factoryDraftModule.extensions`）：

```ts
SubPageBlueprint.make({
  name: 'work-item-history',
  attachTo: { id: 'page:scaffolder', input: 'pages' },
  params: {
    path: 'work-items',
    title: '工作項歷史',
    loader: () => import('./work-item-history/SubPage.tsx').then(m => <m.SubPage />),
  },
})
```

依據：`SubPageBlueprint` 預設 `attachTo: { relative: { kind: 'page' }, input: 'pages' }`；`PageBlueprint` 會把 `inputs.pages` 逐一渲染成頁首 tab 與 `<Route path={`${path}/*`}>`。內建 Templates / Tasks / Actions 分頁即同一機制。

## 5. 模組介面

### 5.1 `src/work-item-history/`（純函式）

三個模組：`narrow.ts`（`asRecord` / `asString` 收窄工具，共用）、`task-record.ts`（任務辨識與紀錄轉換）、`issue-url.ts`（Issue URL 抽取）。`extractIssueUrl` 獨立成檔的理由：它吃的是 ANSI 著色的 log 行與 `output.links`（不是 task JSON），失敗模式是「少一個連結」（不是「少一個欄位」），且會帶進 regex／ANSI 處理。

```ts
export type WorkItemRecord = {
  taskId: string
  createdAt: string
  createdBy?: string
  status: string
  oneLiner: string
  taskType: string
  targetRepo: string   // 已正規化為 owner/repo
  baseBranch: string
  requirement: string
}

/**
 * 以 spec.templateInfo.entityRef 認出 factory-work-item 任務。
 * 收的是 task.spec 而非整個 task——故命名為 Spec，避免與 toWorkItemRecord(task)
 * 混淆（傳錯層級不會拋錯也不會型別錯，只會讓清單永遠空白）。
 * 要求 kind 為 template:，但 namespace 刻意不釘死。
 */
export function isFactoryWorkItemSpec(spec: unknown): boolean

/**
 * spec.parameters → WorkItemRecord。
 * 個別欄位缺失以空字串補，不丟例外；
 * 僅當 task 連 `id` 都取不到（結構完全不可用）時回傳 null。
 */
export function toWorkItemRecord(task: unknown): WorkItemRecord | null

/** github.com?owner=X&repo=Y → X/Y；已是 X/Y 則原樣返回。 */
export function normalizeRepo(raw: unknown): string

/**
 * listTasks 的整包結果 → 可直接渲染的清單（篩選 + 轉換 + 丟壞資料）。
 * 這三步刻意不留在元件裡：元件在 backstage/plugins/**，不受 tsconfig
 * 與 vitest 保護。
 */
export function toWorkItemRecords(tasks: unknown): WorkItemRecord[]

/** 先讀 output.links，沒有才 regex 掃 log 行；都沒有回傳 undefined。 */
export function extractIssueUrl(input: {
  output?: unknown
  logLines?: string[]
}): string | undefined

/** PRD 摘要截斷（清單用），保留完整值供詳情頁。 */
export function summarize(text: unknown, maxChars: number): string

/** ISO 時間 → 本地字串；空值顯示破折號，無法解析者原樣返回。 */
export function formatTimestamp(iso: unknown): string
```

`extractIssueUrl` 的 log pattern 依實測字串：

```
Successfully created issue #28: https://github.com/philipz/camunda_hazelcast/issues/28
```

log 行含 ANSI 色碼（`\u001b[32minfo\u001b[39m: ...`），regex 需容忍。

### 5.2 React 元件

元件只做三件事：取資料、呼叫純函式、渲染。不在元件內做字串解析或格式判斷。

- `HistoryList`：`useApi(scaffolderApiRef).listTasks({ filterByOwnership: 'all', limit: 200 })` → `toWorkItemRecords(tasks)` → `<Table>`。
- `HistoryDetail`：`useTaskEventStream(taskId)` → `task.spec.parameters` 唯讀渲染 + `extractIssueUrl({ output, logLines })`。

## 6. 資料流

**清單**：一次 `listTasks`，前端過濾。後端 list 端點只支援 `createdBy` / `status` / `order` / 分頁，**沒有 template 篩選**（`DatabaseTaskStore.list()` 已確認），因此無法把過濾下推。

`list()` 回傳每筆任務的 `id` / `spec`（含完整 `parameters`）/ `status` / `createdBy` / 時間戳。`secrets` 不在回傳結構內——不是靠刪除，是 SELECT 時就沒有這個欄位；`output` 同樣不在其中（它存在 `task_events` 的 completion 事件）。故清單頁一次請求即可顯示所有表單欄位，但無法顯示 Issue 連結（見 §7）。

規模：目前 43 筆任務（約一個月使用量），`limit: 200` 足夠。超過時於頁尾顯示「僅顯示最近 200 筆」，不假裝資料完整。

**詳情**：`useTaskEventStream(taskId)` 單一 hook 取得 `task.spec.parameters`、`output`、log 行。內建 `OngoingTask` 使用相同 hook，已完成任務會 replay 完整事件。無需新端點，無 N+1 請求。

## 7. 顯示欄位

**清單**：建立時間、一句話需求（連向詳情）、任務類型、目標 repo、狀態、建立者。

清單**不放** Issue 連結欄位。`listTasks` 的回傳只有 `id` / `spec` / `status` / `createdBy` / 時間戳，**不含 `output`**，而舊任務的 Issue URL 只存在於 log 事件中——要在清單顯示連結，就得對每一列各發一次請求（N+1）。稽核情境只需在查閱某一筆時看到連結，故 Issue 連結只出現在詳情頁。

**詳情**：
1. Issue 連結置頂（取不到則不顯示此區塊）
2. 表單六欄唯讀：一句話需求、任務類型、目標 repo、目標分支、需求描述（PRD 全文，**不截斷**）
3. 任務中繼資料：Task ID、建立者、建立時間、狀態
4. 「查看執行 log」連向內建 `/create/tasks/:taskId`

## 8. `backstage/templates/factory-work-item/template.yaml` 變更

純新增，既有 `steps` 與 `output.text` 一字不動：

```yaml
  output:
    links:
      - title: 已建立的 Issue
        url: ${{ steps['create-issue'].output.issueUrl }}
    text:
      - title: 建立與觸發完成
        content: |
          ...維持原樣...
```

`github:issues:create` 輸出 `issueUrl` 與 `issueNumber` 已在 `backstage/versions.md` 有 2026-08-21 實測記載。

現有 8 條相關對抗性測試（`test/adversarial/factory-assets.test.ts` 的 `Backstage factory-work-item 模板與 DoD 契約` describe）全為既有字串的 `toContain` 或 enum 比對，此新增不影響任何一條。

## 9. 錯誤處理與退化

| 情況 | 行為 |
|---|---|
| `listTasks` 失敗 | `ErrorPanel` 顯示錯誤 |
| 過濾後 0 筆 | `EmptyState`，說明尚無工作項歷史 |
| 舊任務取不到 Issue URL | 不顯示連結。不報錯，不猜測，不假造 |
| `requirement` 缺失或非字串 | 顯示「（無內容）」 |
| log 格式因升版改變 | 只影響舊任務的連結顯示；新任務走 `output.links` 不受影響 |

log regex 是舊資料的退化路徑，其失效後果是「少一個連結」，不是頁面損壞。

## 10. 測試

**單元測試**（`src/work-item-history/task-record.test.ts`，受 80% 覆蓋率門檻約束）：
- `normalizeRepo`：`github.com?owner=X&repo=Y`、已正規化的 `X/Y`、空字串
- `toWorkItemRecord`：完整 parameters、缺欄位、`parameters` 非物件
- `isFactoryWorkItemSpec`：命中、其他 template、錯誤 kind、`templateInfo` 缺失
- `toWorkItemRecords`：混雜清單只留 factory-work-item、非陣列輸入回空陣列
- `extractIssueUrl`：`output.links` 優先於 log、只有 log（含 ANSI 色碼）、兩者皆無
- `summarize`：短於上限、長於上限、空字串

**對抗性測試**（`test/adversarial/factory-assets.test.ts` 新增）：
- template 含 `output.links` 且引用 `steps['create-issue'].output.issueUrl`
- plugin 存在 `work-item-history` SubPage 擴充，且 `attachTo` 指向 `page:scaffolder`

**手動驗收清單**（本 repo 無前端測試工具鏈，UI 以人工驗收）：
1. `yarn dev` 後 Create 頁出現「工作項歷史」tab
2. 清單列出既有 factory-work-item 任務，不含其他 template 的任務
3. 點一句話需求進入詳情，網址為 `/create/work-items/<taskId>`，重新整理仍正確
4. 詳情顯示完整 PRD 全文
5. 舊任務（template 加 `output.links` 之前建立者）的詳情頁顯示由 log 解析出的 Issue 連結
6. 新開一張單後，其詳情頁顯示由 `output.links` 來的 Issue 連結
7. 「查看執行 log」正確連到內建任務詳情頁

## 11. 治理

新增分頁**超出 ADR-009 的解凍範圍**（原範圍僅：factory-work-item 模板、LLM 草稿、direct dispatch）。依 docs/14 §1.7 凍結裁決的精神，需補一則 **ADR-017：Backstage 解凍擴大——工作項歷史唯讀查閱**，載明：

- 理由：回溯稽核需求，資料已存在於 scaffolder DB，缺的只是查閱介面
- 範圍：**唯讀**。不新增任何寫入路徑、不新增後端端點、不擴充憑證或權限
- 仍凍結：Scoreboard、TechDocs 以外的其餘 Backstage 能力維持凍結

## 12. 部署時驗證項（Q03-2 模式）

1. `SubPageBlueprint` 的 `attachTo: { id: 'page:scaffolder', input: 'pages' }` 在 Backstage 1.53.0 實跑是否正確掛出 tab。
2. 前端跨 root import `../../../../src/work-item-history/task-record.ts` 是否通過 rspack（前端打包器為 rspack/webpack，非 Vite，故無 `fs.allow` 限制；backend 已有同模式先例，但前端未驗）。
   **Fallback**：純邏輯改置於插件內，並將 `backstage/plugins/**/*.test.ts` 納入 vitest `include`。
3. `useTaskEventStream` 對已完成任務 replay 時是否完整帶回 `output`（內建 `OngoingTask` 的同用法佐證，但未在瀏覽器實測）。

驗證結果一律回寫 `backstage/versions.md`。
