# Backstage 工作項歷史查閱分頁 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Backstage Create 頁新增唯讀的「工作項歷史」分頁，讓「開立 Factory 工作項」表單送出後可回溯當時填寫的完整內容與對應的 GitHub Issue。

**Architecture:** 解析與轉換邏輯為純函式，放在 `src/work-item-history/`（受本 repo vitest 與 80% 覆蓋率門檻管束）；React 元件放在既有的 `backstage/plugins/factory-draft/`，只負責取資料與渲染。新分頁以 `SubPageBlueprint` 掛到 `page:scaffolder` 的 `pages` input，因此 `../backstage-app` 零改動。清單資料來自單次 `scaffolderApi.listTasks`（回傳已含完整 `spec.parameters`）；詳情頁用 `useTaskEventStream` 一次取得 parameters、output 與 log 行。

**Tech Stack:** TypeScript 7、vitest 4、React 18、Backstage 1.53.0（`@backstage/plugin-scaffolder@1.38.1`、new frontend system）、Material-UI v4、pnpm。

**Spec:** `docs/superpowers/specs/2026-09-10-backstage-work-item-history-design.md`

---

## 背景：實作者必須先知道的事

1. **本 repo 不含 Backstage app**。app 在 repo 外的 `../backstage-app`（獨立 repo philipz/backstage-app），透過 `link:` 依賴引用本 repo 的 `backstage/plugins/factory-draft`。本計畫**不需要也不應該**修改 `../backstage-app` 的任何檔案。
2. **`backstage/plugins/**` 不在本 repo 的 tsc 與 vitest 範圍內**（`tsconfig.json` 的 `include` 只有 `src/**/*.ts`、`test/**/*.ts`；`vitest.config.ts` 的 `include` 只有 `src/**/*.test.ts`、`test/**/*.test.ts`）。所以：
   - 插件的 `.tsx` 不會被 `pnpm typecheck` 檢查——**邏輯一律放 `src/`**，元件只做渲染。
   - 插件檔案的契約由 `test/adversarial/factory-assets.test.ts` 的字串斷言守住。
3. **程式風格**：無分號、單引號、2 空格縮排。`src/` 內部互相 import 用 `.js` 副檔名；插件反向 import `src/` 用 `.ts`/`.tsx` 明確副檔名（既有先例：`backstage/plugins/factory-draft-backend/src/router.ts` import `../../../../src/factory-draft/prompts.ts`）。
4. **執行 pnpm 指令一律加 `CI=true` 前綴**（例：`CI=true pnpm test`）。本機環境沒有 TTY 時，pnpm 的 verify-deps 前置檢查會以 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` 中止。**不要**因此執行 `pnpm install` 或動 `node_modules`。
5. **tsconfig 嚴格度**：`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`verbatimModuleSyntax`（型別 import 要寫 `import type`）。`lib` 只有 `ES2023`（**沒有 DOM**）——`src/` 的純函式不可使用任何 DOM 型別。
6. **實測基準資料**（2026-09-10 查 `../backstage-app/packages/backend/backstage-db/scaffolder.sqlite`）：43 筆任務，其中 `template:default/factory-work-item` 38 筆、`template:default/agent-add-tests` 5 筆；`created_by` 值形如 `user:default/philipz`。

## 檔案結構

| 檔案 | 職責 |
|---|---|
| `src/work-item-history/narrow.ts`（Task 3 建立） | 不可信 JSON 的收窄工具（`asObject` / `asString`），供本目錄各模組共用 |
| `src/work-item-history/task-record.ts`（建立） | 純函式：任務辨識、parameters 轉紀錄與整批轉換、repo 正規化、時間格式化、摘要 |
| `src/work-item-history/issue-url.ts`（Task 3 建立） | 純函式：從 `output.links` 或 log 行取出 Issue URL（輸入形態與失敗模式皆與 task-record 不同，故獨立） |
| 上述三者的 `*.test.ts`（建立） | 單元測試；本目錄受 100% 覆蓋率門檻約束 |
| `backstage/plugins/factory-draft/src/index.tsx`（改寫） | 只做 module 組裝與擴充註冊 |
| `backstage/plugins/factory-draft/src/draft-field/DraftFieldComponent.tsx`（自 index.tsx 搬移） | 既有 LLM 草稿欄位元件 |
| `backstage/plugins/factory-draft/src/work-item-history/SubPage.tsx`（建立） | 分頁路由：index → 清單、`:taskId` → 詳情 |
| `backstage/plugins/factory-draft/src/work-item-history/HistoryList.tsx`（建立） | 清單表格 |
| `backstage/plugins/factory-draft/src/work-item-history/HistoryDetail.tsx`（建立） | 唯讀詳情 |
| `backstage/templates/factory-work-item/template.yaml`（修改） | 新增 `output.links` 輸出 Issue URL |
| `test/adversarial/factory-assets.test.ts`（修改） | 新增 3 條契約測試 |
| `docs/ADR/017-backstage-work-item-history.md`（建立） | 解凍範圍擴大的裁決紀錄 |
| `docs/ADR/README.md`、`docs/03-idp-backstage.md`、`backstage/versions.md`（修改） | 索引與元件表更新、驗證結果回寫 |

---

### Task 1: 純函式基石——`normalizeRepo` 與 `isFactoryWorkItemTask`

> **✅ 已完成，並依 code review 修正（2026-09-10）。** 後續 task 必須以修正後的樣貌為準：
>
> 1. **`isFactoryWorkItemTask` 已更名為 `isFactoryWorkItemSpec`**。理由：Task 2 的 `toWorkItemRecord(task)` 收整個 task，而本函式收 `task.spec`——兩個名字相近、吃不同巢狀層級的函式擺在同一個模組是陷阱；傳錯不會拋錯也不會型別錯，只會讓歷史頁永遠空白，而呼叫點在 `backstage/plugins/**`（tooling 照不到）。
> 2. **邊界規則**：本模組所有 exported 函式一律收 `unknown`，內部用 `asString` narrow。`normalizeRepo(raw: unknown)`。**Task 2、3 新增的函式都必須遵守此規則**（下方 Task 1 程式碼區塊保留當時原貌，未回填後續的更名與簽章修正——見 Task 3 的命名裁決註記）。
> 3. `isFactoryWorkItemSpec` 要求 entityRef 以 `template:` 開頭（擋掉 `component:default/factory-work-item`），但**命名空間刻意不釘死**（templates 可能註冊在非 default 命名空間）。
> 4. `normalizeRepo` 另補：畸形百分比編碼逐段退回原編碼字串（不丟例外）、只有 repo 沒有 owner 時回傳解碼後的 repo。
> 5. `vitest.config.ts` 已把 `src/work-item-history/**` 提到 100% 覆蓋率層級——**理由與其他 100% 目錄不同**：本模組不做任何決策，但它是整個功能唯一受測的程式碼（下游 React 元件不在 tsconfig/vitest 範圍內）。

**Files:**
- Create: `src/work-item-history/task-record.ts`
- Test: `src/work-item-history/task-record.test.ts`

- [ ] **Step 1: 寫失敗測試**

建立 `src/work-item-history/task-record.test.ts`：

```ts
/**
 * task-record 純函式測試。
 *
 * 輸入來自 scaffolder API 的 JSON，欄位可能缺失或型別不符（不同 Backstage
 * 版本、不同 template、早期任務），故每個函式都必須在垃圾輸入下不丟例外。
 */
import { describe, expect, it } from 'vitest'
import { isFactoryWorkItemTask, normalizeRepo } from './task-record.js'

describe('normalizeRepo', () => {
  it('把 RepoUrlPicker 格式轉成 owner/repo', () => {
    expect(normalizeRepo('github.com?owner=philipz&repo=camunda_hazelcast')).toBe(
      'philipz/camunda_hazelcast',
    )
  })
  it('只有 owner（template 預設值）時回傳 owner', () => {
    expect(normalizeRepo('github.com?owner=philipz')).toBe('philipz')
  })
  it('已是 owner/repo 時原樣返回', () => {
    expect(normalizeRepo('philipz/software_factory')).toBe('philipz/software_factory')
  })
  it('空字串回傳空字串', () => {
    expect(normalizeRepo('')).toBe('')
  })
})

describe('isFactoryWorkItemTask', () => {
  it('認得 factory-work-item 任務', () => {
    expect(
      isFactoryWorkItemTask({ templateInfo: { entityRef: 'template:default/factory-work-item' } }),
    ).toBe(true)
  })
  it('排除其他 template（agent-add-tests 在同一個清單裡）', () => {
    expect(
      isFactoryWorkItemTask({ templateInfo: { entityRef: 'template:default/agent-add-tests' } }),
    ).toBe(false)
  })
  it('templateInfo 缺失時為 false，不丟例外', () => {
    expect(isFactoryWorkItemTask({})).toBe(false)
    expect(isFactoryWorkItemTask(null)).toBe(false)
    expect(isFactoryWorkItemTask('nonsense')).toBe(false)
  })
})
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm exec vitest run src/work-item-history/task-record.test.ts`
Expected: FAIL，訊息為找不到模組 `./task-record.js`

- [ ] **Step 3: 寫最小實作**

建立 `src/work-item-history/task-record.ts`：

```ts
/**
 * Backstage scaffolder task → 工作項歷史紀錄（純函式）。
 *
 * 資料來源不可信：task 來自 scaffolder API 的 JSON，欄位可能缺失或型別不符。
 * 所有函式以 unknown 收、逐欄 narrow、絕不丟例外——歷史查閱頁寧可少顯示
 * 一個欄位，也不能因一筆壞資料整頁掛掉。
 *
 * 使用者：backstage/plugins/factory-draft/src/work-item-history/*
 */

/** template 名稱（entityRef 的最後一段），與 backstage/templates/factory-work-item/ 對齊。 */
export const FACTORY_WORK_ITEM_TEMPLATE = 'factory-work-item'

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null

const asString = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * 以 spec.templateInfo.entityRef 認出 factory-work-item 任務。
 *
 * 後端 list 端點只支援 createdBy/status 篩選，沒有 template 篩選
 * （DatabaseTaskStore.list 已確認），故過濾必須在前端做。
 */
export function isFactoryWorkItemTask(spec: unknown): boolean {
  const ref = asString(asRecord(asRecord(spec)?.templateInfo)?.entityRef)
  if (ref.length === 0) return false
  return ref.split('/').pop() === FACTORY_WORK_ITEM_TEMPLATE
}

/** RepoUrlPicker 的 `github.com?owner=X&repo=Y` → `X/Y`；其餘格式原樣返回。 */
export function normalizeRepo(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return ''
  const owner = /[?&]owner=([^&]+)/.exec(raw)?.[1]
  const repo = /[?&]repo=([^&]+)/.exec(raw)?.[1]
  if (owner === undefined) return raw
  const decodedOwner = decodeURIComponent(owner)
  return repo === undefined ? decodedOwner : `${decodedOwner}/${decodeURIComponent(repo)}`
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm exec vitest run src/work-item-history/task-record.test.ts`
Expected: PASS，7 tests passed

- [ ] **Step 5: 型別檢查**

Run: `pnpm typecheck`
Expected: 無輸出（成功）

- [ ] **Step 6: Commit**

```bash
git add src/work-item-history/task-record.ts src/work-item-history/task-record.test.ts
git commit -m "feat(work-item-history): 任務辨識與 repo 正規化純函式

後端 list 端點無 template 篩選，過濾只能在前端做；輸入來自
scaffolder API 的 JSON，故一律以 unknown 收再逐欄 narrow。"
```

---

### Task 2: `toWorkItemRecord`、`toWorkItemRecords`、`formatTimestamp`、`summarize`

**Files:**
- Modify: `src/work-item-history/task-record.ts`
- Test: `src/work-item-history/task-record.test.ts`

- [ ] **Step 1: 寫失敗測試**

在 `src/work-item-history/task-record.test.ts` 的 import 行改為：

```ts
import {
  formatTimestamp,
  isFactoryWorkItemSpec,
  normalizeRepo,
  summarize,
  toWorkItemRecord,
  toWorkItemRecords,
} from './task-record.js'
```

並在檔尾追加：

```ts
const fullTask = {
  id: '80f332c5-01c3-4e8f-a7b5-9a829dc9dd96',
  status: 'completed',
  createdBy: 'user:default/philipz',
  createdAt: '2026-09-10T08:47:18.000Z',
  spec: {
    templateInfo: { entityRef: 'template:default/factory-work-item' },
    parameters: {
      oneLiner: '將 Camunda 7.23.0 遷移至 Operaton 2.1.4',
      taskType: 'agent-update-deps',
      targetRepo: 'github.com?owner=philipz&repo=camunda_hazelcast',
      baseBranch: 'software-factory',
      requirement: '【做什麼】\n遷移。',
    },
  },
}

describe('toWorkItemRecord', () => {
  it('抽出完整表單欄位並正規化 repo', () => {
    expect(toWorkItemRecord(fullTask)).toEqual({
      taskId: '80f332c5-01c3-4e8f-a7b5-9a829dc9dd96',
      createdAt: '2026-09-10T08:47:18.000Z',
      createdBy: 'user:default/philipz',
      status: 'completed',
      oneLiner: '將 Camunda 7.23.0 遷移至 Operaton 2.1.4',
      taskType: 'agent-update-deps',
      targetRepo: 'philipz/camunda_hazelcast',
      baseBranch: 'software-factory',
      requirement: '【做什麼】\n遷移。',
    })
  })

  it('個別欄位缺失時補空字串，不丟例外', () => {
    const record = toWorkItemRecord({ id: 'abc', spec: {} })
    expect(record?.taskId).toBe('abc')
    expect(record?.oneLiner).toBe('')
    expect(record?.requirement).toBe('')
    expect(record?.targetRepo).toBe('')
  })

  it('createdBy 缺失時退回 spec.user.ref', () => {
    const record = toWorkItemRecord({
      id: 'abc',
      spec: { user: { ref: 'user:default/philipz' } },
    })
    expect(record?.createdBy).toBe('user:default/philipz')
  })

  it('連 id 都取不到時回傳 null', () => {
    expect(toWorkItemRecord({ spec: {} })).toBeNull()
    expect(toWorkItemRecord(null)).toBeNull()
  })
})

describe('toWorkItemRecords', () => {
  it('挑出 factory-work-item、丟掉其他 template 與壞資料', () => {
    const records = toWorkItemRecords([
      fullTask,
      { id: 'other', spec: { templateInfo: { entityRef: 'template:default/agent-add-tests' } } },
      { spec: { templateInfo: { entityRef: 'template:default/factory-work-item' } } },
      'nonsense',
    ])
    expect(records).toHaveLength(1)
    expect(records[0]?.taskId).toBe('80f332c5-01c3-4e8f-a7b5-9a829dc9dd96')
  })

  it('非陣列輸入回傳空陣列（listTasks 失敗或回傳形狀改變時不炸頁）', () => {
    expect(toWorkItemRecords(undefined)).toEqual([])
    expect(toWorkItemRecords(null)).toEqual([])
    expect(toWorkItemRecords({ tasks: [] })).toEqual([])
  })
})

describe('formatTimestamp', () => {
  it('空字串顯示破折號', () => {
    expect(formatTimestamp('')).toBe('—')
  })
  it('非字串輸入顯示破折號', () => {
    expect(formatTimestamp(undefined)).toBe('—')
    expect(formatTimestamp(42)).toBe('—')
  })
  it('無法解析的字串原樣返回', () => {
    expect(formatTimestamp('not-a-date')).toBe('not-a-date')
  })
  it('可解析的 ISO 時間轉成本地字串', () => {
    expect(formatTimestamp('2026-09-10T08:47:18.000Z')).toContain('2026')
  })
})

describe('summarize', () => {
  it('短於上限時原樣返回（並壓平換行）', () => {
    expect(summarize('a\nb', 10)).toBe('a b')
  })
  it('長於上限時截斷並加省略號', () => {
    expect(summarize('abcdefghij', 5)).toBe('abcde…')
  })
  it('空字串與非字串輸入皆回傳空字串', () => {
    expect(summarize('', 5)).toBe('')
    expect(summarize(null, 5)).toBe('')
  })
})
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm exec vitest run src/work-item-history/task-record.test.ts`
Expected: FAIL，`toWorkItemRecord is not a function`（或 import 錯誤）

- [ ] **Step 3: 寫最小實作**

在 `src/work-item-history/task-record.ts` 檔尾追加：

```ts
/** 歷史清單與詳情頁共用的一筆紀錄。所有欄位皆為字串，缺值以空字串表示。 */
export interface WorkItemRecord {
  taskId: string
  createdAt: string
  createdBy: string
  status: string
  oneLiner: string
  taskType: string
  targetRepo: string
  baseBranch: string
  requirement: string
}

/**
 * scaffolder task → WorkItemRecord。
 *
 * 個別欄位缺失一律補空字串；僅當連 id 都取不到（結構完全不可用）時回傳 null。
 * createdBy 優先取 task.createdBy，缺失時退回 spec.user.ref——內建
 * ListTasksPage 讀的是後者，兩者在實測資料中同值。
 */
export function toWorkItemRecord(task: unknown): WorkItemRecord | null {
  const t = asRecord(task)
  const taskId = asString(t?.id)
  if (taskId.length === 0) return null
  const spec = asRecord(t?.spec)
  const parameters = asRecord(spec?.parameters)
  const createdBy = asString(t?.createdBy) || asString(asRecord(spec?.user)?.ref)
  return {
    taskId,
    createdAt: asString(t?.createdAt),
    createdBy,
    status: asString(t?.status),
    oneLiner: asString(parameters?.oneLiner),
    taskType: asString(parameters?.taskType),
    targetRepo: normalizeRepo(parameters?.targetRepo),
    baseBranch: asString(parameters?.baseBranch),
    requirement: asString(parameters?.requirement),
  }
}

/**
 * listTasks 的整包結果 → 可直接渲染的清單。
 *
 * 篩選 + 轉換 + 丟棄壞資料三步都在這裡完成，元件只拿結果。理由：元件住在
 * backstage/plugins/**，不在 tsconfig 與 vitest 範圍內——留在那裡的邏輯
 * 沒有任何自動化防護。
 */
export function toWorkItemRecords(tasks: unknown): WorkItemRecord[] {
  if (!Array.isArray(tasks)) return []
  const records: WorkItemRecord[] = []
  for (const task of tasks) {
    if (!isFactoryWorkItemSpec(asRecord(task)?.spec)) continue
    const record = toWorkItemRecord(task)
    if (record !== null) records.push(record)
  }
  return records
}

/** ISO 時間 → 本地字串；空值或非字串顯示破折號，無法解析者原樣返回（不假造時間）。 */
export function formatTimestamp(iso: unknown): string {
  const value = asString(iso)
  if (value.length === 0) return '—'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}

/** 清單用的摘要：壓平空白後截斷。詳情頁一律顯示原文，不經過本函式。 */
export function summarize(text: unknown, maxChars: number): string {
  const flat = asString(text).replace(/\s+/g, ' ').trim()
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars)}…`
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `CI=true pnpm exec vitest run src/work-item-history/task-record.test.ts`
Expected: PASS，Task 1 修正後的既有測試 + 本 task 新增的測試全綠（後續 code review 又追加了測試，本檔最終 43 條；條數以實際輸出為準）

- [ ] **Step 5: 型別檢查**

Run: `pnpm typecheck`
Expected: 無輸出

- [ ] **Step 6: Commit**

```bash
git add src/work-item-history/task-record.ts src/work-item-history/task-record.test.ts
git commit -m "feat(work-item-history): task → WorkItemRecord 轉換與顯示格式化

缺欄位補空字串、只有結構完全不可用才回 null——一筆壞資料不該
讓整個歷史清單掛掉。"
```

---

### Task 3: `extractIssueUrl`（獨立模組；新任務讀 output.links、舊任務退回解析 log）

**Files:**
- Create: `src/work-item-history/narrow.ts`（把 `asObject` / `asString` 抽成共用）
- Create: `src/work-item-history/narrow.test.ts`
- Create: `src/work-item-history/issue-url.ts`
- Create: `src/work-item-history/issue-url.test.ts`
- Modify: `src/work-item-history/task-record.ts`（改為 import 共用 narrow helper）

> **為什麼獨立成檔（Task 2 code review 裁決）**：`extractIssueUrl` 吃的輸入完全不同（ANSI 著色的 log 行與 `output.links`，不是 task JSON）、失敗模式也不同（少一個連結是設計上可接受的退化，不是少一個欄位），而且會帶進 regex／ANSI 處理。塞進 `task-record.ts` 會讓那個檔案的職責一句話講不完。現在拆比 Task 4 再搬便宜。

**背景**：DB 內既有 38 筆 factory-work-item 任務建立於 template 加上 `output.links` 之前，它們的 Issue URL 只存在於 log 事件字串中，實測長相為：

```
\u001b[32minfo\u001b[39m: Successfully created issue #28: https://github.com/philipz/camunda_hazelcast/issues/28
```

比對時**不依賴 "Successfully created issue" 這串字**（它屬於 `github:issues:create` 的實作細節，升版可能改），只認 GitHub issue URL 的形狀。

- [ ] **Step 1: 先抽出共用 narrow helper（純搬移，行為不變）**

建立 `src/work-item-history/narrow.ts`：

```ts
/**
 * 不可信 JSON 的收窄工具（純函式）。
 *
 * 本目錄的兩個模組（task-record、issue-url）都吃 scaffolder API 回傳的
 * JSON，欄位可能缺失或型別不符。收窄一律走這裡，避免各自長出不同寫法。
 */

/** 物件（含陣列）才回傳其本身，null 與原始型別一律回傳 null。 */
export const asObject = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null

/** 字串才回傳其本身，其餘一律回傳空字串。 */
export const asString = (v: unknown): string => (typeof v === 'string' ? v : '')
```

> **命名（Task 3 code review 裁決）**：叫 `asObject` 而非 `asRecord`——它會讓陣列通過，而 `Record` 這個名字暗示不會。名字自己講清楚，就不需要一段註解去解釋。**此更名回溯套用**：前面 Task 1、2 展示的程式碼仍寫作 `asRecord`（那是當時的原貌），實際檔案在 Task 3 已全數更名。

建立 `src/work-item-history/narrow.test.ts`，直接測這兩個函式的邊界（物件／陣列／null／undefined／數字／字串），確保 100% 覆蓋。

接著把 `src/work-item-history/task-record.ts` 內原本的兩個私有 helper 刪除，改為在檔首 import：

```ts
import { asObject, asString } from './narrow.js'
```

- [ ] **Step 2: 執行測試確認未破壞既有行為**

Run: `CI=true pnpm exec vitest run src/work-item-history`
Expected: PASS，既有測試全綠（純搬移，數量不變）

- [ ] **Step 3: 寫失敗測試**

建立 `src/work-item-history/issue-url.test.ts`：

```ts
/**
 * Issue URL 抽取測試。
 *
 * 兩條來源刻意分開測：新任務走 template 的 output.links（結構化），
 * 舊任務只能從 log 字串撈——後者是退化路徑，失效只該少一個連結。
 */
import { describe, expect, it } from 'vitest'
import { extractIssueUrl } from './issue-url.js'

describe('extractIssueUrl', () => {
  const ISSUE = 'https://github.com/philipz/camunda_hazelcast/issues/28'

  it('優先讀 output.links 的結構化 URL', () => {
    expect(
      extractIssueUrl({
        output: { links: [{ title: '已建立的 Issue', url: ISSUE }] },
        logLines: [],
      }),
    ).toBe(ISSUE)
  })

  it('沒有 output.links 時退回解析 log（容忍 ANSI 色碼）', () => {
    expect(
      extractIssueUrl({
        output: undefined,
        logLines: [`2026-09-10 \u001b[32minfo\u001b[39m: Successfully created issue #28: ${ISSUE}`],
      }),
    ).toBe(ISSUE)
  })

  it('output.links 有但非 issue 連結時，仍會退回掃 log', () => {
    expect(
      extractIssueUrl({
        output: { links: [{ url: 'https://github.com/philipz/software_factory/actions' }] },
        logLines: [`Successfully created issue #28: ${ISSUE}`],
      }),
    ).toBe(ISSUE)
  })

  it('只有 Actions 連結、log 也沒有時回傳 undefined', () => {
    expect(
      extractIssueUrl({
        output: { links: [{ url: 'https://github.com/philipz/software_factory/actions' }] },
        logLines: [],
      }),
    ).toBeUndefined()
  })

  it('兩邊都沒有時回傳 undefined，不猜測', () => {
    expect(extractIssueUrl({})).toBeUndefined()
    expect(extractIssueUrl({ output: 'nonsense', logLines: ['no url here'] })).toBeUndefined()
  })
})
```

- [ ] **Step 4: 執行測試確認失敗**

Run: `CI=true pnpm exec vitest run src/work-item-history/issue-url.test.ts`
Expected: FAIL，找不到模組 `./issue-url.js`

- [ ] **Step 5: 寫最小實作**

建立 `src/work-item-history/issue-url.ts`：

```ts
/**
 * 從任務產物中取出「本次建立的 GitHub Issue」連結（純函式）。
 *
 * 兩條來源：
 * 1. template 的 output.links（2026-09-10 起的新任務，結構化、穩定）；
 * 2. log 事件字串（更早的任務，唯一留有 URL 的地方）。
 *
 * 兩者皆無時回傳 undefined——呼叫端不顯示連結即可，不得假造。
 */
import { asObject, asString } from './narrow.js'

/**
 * GitHub issue URL 的形狀。刻意不比對 action 的 log 措辭
 * （"Successfully created issue #N:" 是 github:issues:create 的實作細節，
 * 升版即可能改），也不比對 Actions 頁面那類非 issue 連結。
 */
const ISSUE_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+/

export function extractIssueUrl(input: {
  output?: unknown
  // 刻意收 unknown[]：真正的呼叫端把 Backstage 的 stepLogs 攤平後傳進來，
  // 而它住在 backstage/plugins/**，不受型別檢查——防呆必須是真的可達。
  logLines?: readonly unknown[] | undefined
}): string | undefined {
  const links = asObject(input.output)?.links
  if (Array.isArray(links)) {
    for (const link of links) {
      const url = asString(asObject(link)?.url)
      if (ISSUE_URL.test(url)) return url
    }
  }
  // log 掃描取「最後一個」符合的 URL：本次建立的 issue 一定在執行尾聲才被記錄，
  // 而偶然引用到的其他 issue 只會出現在更早的行。取第一個會安靜地連錯 issue——
  // 那比顯示不出連結糟糕得多，且 38/43 筆舊任務只有這條路徑可走。
  let fromLog: string | undefined
  for (const line of input.logLines ?? []) {
    const matched = ISSUE_URL.exec(asString(line))
    if (matched !== null) fromLog = matched[0]
  }
  return fromLog
}
```

- [ ] **Step 6: 執行測試確認通過**

Run: `CI=true pnpm exec vitest run src/work-item-history`
Expected: PASS，全綠

- [ ] **Step 7: 型別檢查與覆蓋率**

Run: `CI=true pnpm typecheck` 與 `CI=true pnpm coverage`
Expected: typecheck 無輸出；coverage 通過，`src/work-item-history/**` 維持 100%（該目錄已在 100% 層級，不得調降門檻）

- [ ] **Step 8: Commit**

```bash
git add src/work-item-history/
git commit -m "feat(work-item-history): Issue URL 抽取獨立成模組

既有 38 筆任務的 Issue URL 只存在 log 字串中；比對只認 URL 形狀，
不綁 github:issues:create 的 log 措辭。

輸入形態與失敗模式都與 task-record 不同（ANSI log 行 vs task JSON、
少一個連結 vs 少一個欄位），故獨立成檔；asObject/asString 抽到
narrow.ts 供兩者共用。"
```

---

### Task 4: template 新增 `output.links`

> **✅ 已完成（commits `78bac40`、`2fcb45f`、`61af6b2`，2026-09-10）。以最終樣貌為準，計畫原文的測試寫法已被否決——見下方裁決。**

**Files:**
- Modify: `backstage/templates/factory-work-item/template.yaml`
- Test: `test/adversarial/factory-assets.test.ts`

**最終 template 樣貌**（`spec.output` 其餘一字不動）：

```yaml
  output:
    # 歷史查閱分頁（ADR-017）以此結構化欄位取得 Issue 連結；在此之前建立的
    # 任務只能從 log 字串解析，故新任務一律走這條。
    links:
      - title: 已建立的 Issue
        url: ${{ steps['create-issue'].output.issueUrl }}
    text:
      ...（原文不動）...
```

**最終測試**：解析 YAML 後斷言結構，**不做字串比對**：

```ts
it('spec.output.links 為解析後的真欄位：與 text 並存、url 取自 create-issue 的 issueUrl', () => {
  const { load } = require('js-yaml') as typeof import('js-yaml')
  const spec = (load(read('backstage/templates/factory-work-item/template.yaml')) as {...}).spec
  expect(spec.output.links, 'spec.output 缺 links 欄位').toBeDefined()
  expect(spec.output.links).toHaveLength(1)
  expect(spec.output.links![0]!.url).toBe("${{ steps['create-issue'].output.issueUrl }}")
  expect(spec.output.links![0]!.title).toBeTruthy()
  // 純新增：既有的 output.text 必須原封不動地並存（ADR-009 局部解凍的前提）
  expect(spec.output.text, 'output.text 不得被 links 取代').toHaveLength(1)
})
```

**裁決一：計畫原文的 `toContain` 斷言已刪除。** 原文是：

```ts
expect(t).toContain('links:')
expect(t).toContain("steps['create-issue'].output.issueUrl")
```

實作者建了反例證明它毫無價值：把真正的 `links:` 區塊整段換成**一行 YAML 註解** `# TODO: 未來也許加 links:，屆時用 steps['create-issue'].output.issueUrl`，該測試照樣綠，而 `js-yaml` 解析出的 `spec.output` 只剩 `text`——Backstage 讀的是解析後的樹，一條連結都不會有。字串比對只問「這些字有沒有出現在檔案某處」，註解裡的字同樣算數。**一條「註解就能滿足」的測試比沒有測試更糟，因為後人會信它。**

**裁決二：加在 `links` 上的 `if:` 守衛已移除——它不可能觸發。** 當初加它是想防「create-issue 失敗時渲染出空 href 的連結」。code review 驅動**實際安裝的** render 路徑後證明它永遠不會生效，兩個獨立原因：

1. **輸入不可達**：`plugin-scaffolder-backend@4.0.2` 的 `NunjucksWorkflowRunner` 在渲染 output **之前**就 `if (firstError) throw firstError`，而 `create-issue` 是第一步且無 `continueOnFailure`——失敗時整個任務中止、根本不會渲染 output，所以 `issueUrl` 在守衛處必然存在。
2. **就算可達也會被抹掉**：`render()` 對渲染成空字串的單一模板回傳 `undefined`，而作為 `JSON.parse` reviver，回傳 `undefined` 會**刪除該 key**——`if` 與 `url` 一起消失，於是 `helper.cjs.js` 的 `filterConditionalItems` 檢查 `"if" in obj` 得到 false，該項目照樣保留。守衛什麼都濾不掉。

UI 本來就有保護：前端 `LinkOutputs` 會濾掉沒有 `url` 也沒有 `entityRef` 的連結，消費端 `src/work-item-history/issue-url.ts` 也用 `asString(...url)` 收窄後再測 `ISSUE_URL`。

> **教訓（給後續 task）**：型別存在 ≠ 行為生效。當初授權這個守衛時只查了 `ScaffolderOutputLink.if` 在 2.2.1 的**型別宣告**，沒有探測**渲染路徑的實際行為**。凡是「加了某個防護欄位」的變更，都要用真實程式碼驗證它真的會攔到東西，否則就是在設定檔裡製造假保證——而這正是本測試檔存在的原因。

**副作用（正面，值得知道）**：`output.links` 不只餵給歷史頁，`DefaultTemplateOutputs` 也會把它渲染成任務完成頁上的按鈕。所以這個改動同時讓每次開單後多一個「已建立的 Issue」按鈕。計畫原本沒提，但它對使用者是有益的。

---

### Task 5: 拆出草稿欄位元件（純搬移，行為不變）

> **✅ 已完成（commit `0b68694`，2026-09-10）。兩處與計畫原文不同，見下方裁決。**
>
> **裁決一：用單一 commit，不拆成「搬移」＋「新 index.tsx」兩個。** 計畫 Step 1 要求「保留 git 歷史」，實作時發現這是個假選項——git 的改名偵測是把**刪除**與**新增**配對，而本變更中 `index.tsx` 是被**改寫**（不是刪除），所以無論怎麼切，搬移都不會被配對出來；連 PR 層級的 base..head diff 也一樣顯示成「新增 225 行 + index.tsx 重寫」。拆成兩個 commit 只換到一個**測試紅燈的中間狀態**（那個 commit 裡 `index.tsx` 不存在，契約測試的 `read()` 直接 ENOENT），會讓 `git bisect` 落在假失敗上。實測確認 `git log --follow` 在單一 commit 形式下仍能跨過搬移（`git blame` 不跨，這是唯一損失）。
>
> **裁決二：計畫 Step 5 的「Expected: PASS」是錯的，測試必須改。** 原文只預期 `index.tsx` 仍含 `FactoryWorkItemDraftField`，但漏了**同一支測試檔還有第二個讀取者**：`test/adversarial/factory-assets.test.ts` 另有一條斷言讀 `index.tsx` 找 `POST_TIMEOUT_MS = 120_000`、`AbortController`、`LLM 回應逾時，請重試`。那些常數隨元件搬到了 `DraftFieldComponent.tsx`，故該條必須改讀新路徑（斷言語意不變）。實作者先實測確認它會紅（`1 failed | 104 passed`，失敗在該行）才改，而不是把字串硬塞回 `index.tsx` 來餵測試——後者就是測試造假。**教訓：改動檔案位置時，先全文檢索該檔被哪些測試讀取，不要只信計畫列舉的那一條。**


**Files:**
- Move: `backstage/plugins/factory-draft/src/index.tsx` → `backstage/plugins/factory-draft/src/draft-field/DraftFieldComponent.tsx`
- Create: `backstage/plugins/factory-draft/src/index.tsx`（新內容）

現有 `index.tsx` 252 行，同時承擔「草稿欄位實作」與「module 組裝」。再塞一個歷史頁會失控，故先拆。本任務**不改變任何行為**。

- [ ] **Step 1: 搬移檔案（保留 git 歷史）**

```bash
mkdir -p backstage/plugins/factory-draft/src/draft-field
git mv backstage/plugins/factory-draft/src/index.tsx \
       backstage/plugins/factory-draft/src/draft-field/DraftFieldComponent.tsx
```

- [ ] **Step 2: 從搬移後的檔案移除 module 組裝段落**

在 `backstage/plugins/factory-draft/src/draft-field/DraftFieldComponent.tsx` 中，刪除從 `/**` 開頭、內容為「new frontend system 客製欄位擴充」的那段註解，一路到檔尾的 `export default factoryDraftModule`（即原 229–252 行整段）。刪除後檔案最後一段應為：

```tsx
export const FactoryWorkItemDraftField = createFormField({
  name: 'FactoryWorkItemDraftField',
  component: DraftFieldComponent,
})
```

- [ ] **Step 3: 移除該檔已不再使用的 import**

刪除這一行：

```tsx
import { createFrontendModule } from '@backstage/frontend-plugin-api'
```

並把：

```tsx
import {
  createFormField,
  FormFieldBlueprint,
  type FieldExtensionComponentProps,
} from '@backstage/plugin-scaffolder-react/alpha'
```

改為：

```tsx
import {
  createFormField,
  type FieldExtensionComponentProps,
} from '@backstage/plugin-scaffolder-react/alpha'
```

- [ ] **Step 4: 建立新的 `index.tsx`**

建立 `backstage/plugins/factory-draft/src/index.tsx`：

```tsx
/**
 * factory-draft 前端 module：software_factory 對 Backstage scaffolder 的客製擴充。
 *
 * 兩個擴充：
 * 1. FactoryWorkItemDraftField —— 開單表單的 LLM 草稿助手欄位（docs/ADR/009）；
 * 2. work-item-history SubPage —— Create 頁的「工作項歷史」唯讀查閱分頁（docs/ADR/017）。
 *
 * 根因備忘（2026-08-21 實測，讀 frontend-app-api resolveAppNodeSpecs 原始碼確認）：
 * `features` 只接受 FrontendPlugin 或 FrontendModule——**裸的 ExtensionDefinition
 * 會被靜默丟棄**（不進 app tree，loadFormFields 永遠拿不到 → RJSF 退回預設欄位）。
 * 正確做法：用 `createFrontendModule` 包裝，pluginId 對應宿主插件（scaffolder）
 * 以取得 plugin 上下文與 attachTo 解析。
 *
 * 使用方式：features: [factoryDraftModule, ...]
 */
import React from 'react'
import { createFrontendModule, SubPageBlueprint } from '@backstage/frontend-plugin-api'
import { FormFieldBlueprint } from '@backstage/plugin-scaffolder-react/alpha'
import { FactoryWorkItemDraftField } from './draft-field/DraftFieldComponent.tsx'

export { FactoryWorkItemDraftField }

const factoryWorkItemDraftField = FormFieldBlueprint.make({
  name: 'factory-work-item-draft',
  params: {
    field: () => Promise.resolve(FactoryWorkItemDraftField),
  },
})

/**
 * Create 頁的新分頁（PageBlueprint 會把 pages input 逐一渲染成頁首 tab）。
 *
 * attachTo 明寫 page:scaffolder——SubPageBlueprint 的預設是
 * { relative: { kind: 'page' }, input: 'pages' }，而本 module 自身沒有
 * page 擴充，不能依賴 relative 解析。
 */
const workItemHistorySubPage = SubPageBlueprint.make({
  name: 'work-item-history',
  attachTo: { id: 'page:scaffolder', input: 'pages' },
  params: {
    path: 'work-items',
    title: '工作項歷史',
    loader: () => import('./work-item-history/SubPage.tsx').then((m) => <m.SubPage />),
  },
})

const factoryDraftModule = createFrontendModule({
  pluginId: 'scaffolder',
  extensions: [factoryWorkItemDraftField, workItemHistorySubPage],
})

export default factoryDraftModule
```

> 此時 `./work-item-history/SubPage.tsx` 尚不存在——Task 6 建立。本 task 不需要 app 能啟動。

- [ ] **Step 5: 確認既有契約測試仍綠**

Run: `pnpm exec vitest run test/adversarial/factory-assets.test.ts`
Expected: PASS。特別注意這條既有測試仍須通過：

```
factory-draft 客製 plugin 存在（backend 路由 + frontend 欄位）
```

它斷言 `backstage/plugins/factory-draft/src/index.tsx` 含 `FactoryWorkItemDraftField`——新 index.tsx 有 `export { FactoryWorkItemDraftField }`，故仍成立。

- [ ] **Step 6: Commit**

```bash
git add backstage/plugins/factory-draft/src/
git commit -m "refactor(factory-draft): 拆開草稿欄位實作與 module 組裝

index.tsx 原本 252 行身兼兩職，再加歷史頁會失控。純搬移，行為不變。"
```

---

### Task 6: 分頁骨架 `SubPage.tsx`

**Files:**
- Create: `backstage/plugins/factory-draft/src/work-item-history/SubPage.tsx`
- Test: `test/adversarial/factory-assets.test.ts`

- [ ] **Step 1: 寫失敗測試**

在 Task 4 建立的 `describe('Backstage 工作項歷史查閱分頁（docs/ADR/017）', ...)` 內追加：

```ts
  it('SubPage 擴充明寫 attachTo page:scaffolder（不依賴 relative 解析）', () => {
    const idx = read('backstage/plugins/factory-draft/src/index.tsx')
    expect(idx).toContain('SubPageBlueprint.make')
    expect(idx).toContain("attachTo: { id: 'page:scaffolder', input: 'pages' }")
    expect(idx).toContain("path: 'work-items'")
  })

  it('分頁有清單與詳情兩條路由，且各自渲染對應元件', () => {
    const sub = read('backstage/plugins/factory-draft/src/work-item-history/SubPage.tsx')
    expect(sub).toContain('path=":taskId"')
    // 用 regex 而非 toContain('<Route index')：後者假設 JSX 寫成單行，但 Prettier
    // 標準是多行 `<Route\n  index`，那個字面根本不在檔案裡。測的是「有一條 index
    // 路由」這個意圖，不是某種排版。
    expect(sub).toMatch(/<Route\s+index/)
    // 更實質的契約：兩條路由各自渲染對應元件——否則兩條空路由也會過上面的斷言。
    expect(sub).toContain('<HistoryList />')
    expect(sub).toContain('<HistoryDetail />')
  })
```

> **這幾條是字串比對，強度有限，理由要寫在測試裡。** Task 4 已證明字串比對可以被註解騙過。這裡仍用它是因為對象是 `.tsx` 原始碼，而本 repo 沒有現成的 TS 結構化解析工具，為此引入 TypeScript compiler API 屬於過度工程。**限制必須明講**：這些斷言只證明「字串出現在檔案裡」，**不證明擴充真的掛進了 app tree**——那件事在 `backstage/plugins/**` 不受任何自動化檢查，唯一的驗證是 Task 10 的瀏覽器實測（第 1 項：Create 頁是否真的出現分頁）。
>
> 因此請在測試的 docblock 寫明這個界線，並在 Task 10 的驗收清單把「分頁出現」列為**必要**項而非選項。不要讓字串斷言看起來像行為保證。

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm exec vitest run test/adversarial/factory-assets.test.ts -t '工作項歷史'`
Expected: FAIL，第二條因找不到 `SubPage.tsx` 而丟 ENOENT

- [ ] **Step 3: 建立 SubPage**

建立 `backstage/plugins/factory-draft/src/work-item-history/SubPage.tsx`：

```tsx
/**
 * 「工作項歷史」分頁的路由（/create/work-items）。
 *
 * 結構刻意與內建的 TasksSubPage 一致：index 為清單、:taskId 為詳情，
 * 讓詳情頁有可分享的網址（稽核情境需要）。
 */
import React from 'react'
import { Route, Routes } from 'react-router-dom'
import { Content } from '@backstage/core-components'
import { HistoryList } from './HistoryList.tsx'
import { HistoryDetail } from './HistoryDetail.tsx'

export function SubPage() {
  return (
    <Routes>
      <Route
        index
        element={
          <Content>
            <HistoryList />
          </Content>
        }
      />
      <Route
        path=":taskId"
        element={
          <Content>
            <HistoryDetail />
          </Content>
        }
      />
    </Routes>
  )
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm exec vitest run test/adversarial/factory-assets.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backstage/plugins/factory-draft/src/work-item-history/SubPage.tsx test/adversarial/factory-assets.test.ts
git commit -m "feat(work-item-history): Create 頁新增工作項歷史分頁骨架

清單與詳情兩條路由，詳情有獨立網址供稽核分享。"
```

---

### Task 7: 清單 `HistoryList.tsx`

**Files:**
- Create: `backstage/plugins/factory-draft/src/work-item-history/HistoryList.tsx`
- Test: `test/adversarial/factory-assets.test.ts`

- [ ] **Step 1: 寫失敗測試**

先補測試檔的 import（原本只有 `readFileSync` 與 `join`）：

```ts
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
```

在同一個 describe 內追加：

```ts
  it('歷史頁元件從 src/ 取用純函式，且相對路徑真的解析得到', () => {
    for (const f of [
      'backstage/plugins/factory-draft/src/work-item-history/HistoryList.tsx',
      'backstage/plugins/factory-draft/src/work-item-history/HistoryDetail.tsx',
    ]) {
      const src = read(f)
      expect(src).toContain('src/work-item-history/task-record.ts')
      // 關鍵：`toContain` 抓不到層數寫錯（4 層與 5 層都含這個子字串），
      // 但 backstage/plugins/** 不受 tsc 檢查，寫錯會一路安靜到瀏覽器才爆。
      // 故把每個相對 import 真的解析出來，斷言目標檔存在。
      for (const m of src.matchAll(/from '(\.\.\/[^']+)'/g)) {
        const resolved = resolve(dirname(f), m[1]!)
        expect(existsSync(resolved), `${f} 的 import ${m[1]} 解析不到（實際指向 ${resolved}）`).toBe(true)
      }
    }
  })
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm exec vitest run test/adversarial/factory-assets.test.ts -t '工作項歷史'`
Expected: FAIL，找不到 `HistoryList.tsx`（ENOENT）

- [ ] **Step 3: 建立 HistoryList**

建立 `backstage/plugins/factory-draft/src/work-item-history/HistoryList.tsx`：

```tsx
/**
 * 工作項歷史清單。
 *
 * 一次 listTasks 即可顯示所有表單欄位——list 端點回傳完整 spec.parameters
 * （secrets 不在 SELECT 範圍內）。但它**不回傳 output**，而舊任務的 Issue URL
 * 只在 log 事件裡，故清單不放 Issue 連結欄位（要放就得每列各發一次請求）；
 * 連結只出現在詳情頁。
 */
import React from 'react'
import { useApi } from '@backstage/core-plugin-api'
import { scaffolderApiRef } from '@backstage/plugin-scaffolder-react'
import { EmptyState, ErrorPanel, Link, Progress, Table } from '@backstage/core-components'
import Typography from '@material-ui/core/Typography'
import useAsync from 'react-use/esm/useAsync'
import {
  formatTimestamp,
  summarize,
  toWorkItemRecords,
  type WorkItemRecord,
} from '../../../../../src/work-item-history/task-record.ts'

/**
 * 後端 list 端點只支援 createdBy/status 篩選，沒有 template 篩選，
 * 故一次取回上限筆數再於前端過濾。實測 DB 共 43 筆任務，200 綽綽有餘。
 */
const FETCH_LIMIT = 200

export function HistoryList() {
  const scaffolderApi = useApi(scaffolderApiRef)
  const { value, loading, error } = useAsync(
    async () => scaffolderApi.listTasks({ filterByOwnership: 'all', limit: FETCH_LIMIT }),
    [scaffolderApi],
  )

  if (loading) return <Progress />
  if (error) return <ErrorPanel error={error} />

  // 拆信封、篩選、轉換、丟壞資料全在 src/ 的純函式裡完成——本元件不做任何判斷。
  // 連 `value?.tasks` 都不自己拆：回應形狀若改變，這裡會安靜地變成「查無資料」，
  // 而那是歷史頁最難察覺的失敗模式。
  const rows: WorkItemRecord[] = toWorkItemRecords(value)

  if (rows.length === 0) {
    return (
      <EmptyState
        missing="data"
        title="尚無工作項歷史"
        description="用「開立 Factory 工作項」送出一張單之後，這裡會列出當時填寫的內容。"
      />
    )
  }

  return (
    <>
      <Table<WorkItemRecord>
        title={`工作項歷史（${rows.length} 筆）`}
        options={{ pageSize: 10, emptyRowsWhenPaging: false, search: true }}
        data={rows}
        columns={[
          {
            title: '建立時間',
            field: 'createdAt',
            render: (row) => formatTimestamp(row.createdAt),
          },
          {
            title: '一句話需求',
            field: 'oneLiner',
            render: (row) => (
              <Link to={row.taskId}>{summarize(row.oneLiner, 60) || '（未填）'}</Link>
            ),
          },
          { title: '任務類型', field: 'taskType' },
          { title: '目標 repo', field: 'targetRepo' },
          { title: '狀態', field: 'status' },
          { title: '建立者', field: 'createdBy' },
        ]}
      />
      {(value?.tasks?.length ?? 0) >= FETCH_LIMIT && (
        <Typography variant="caption">
          僅掃描最近 {FETCH_LIMIT} 筆 scaffolder 任務，更早的紀錄未載入。
        </Typography>
      )}
    </>
  )
}
```

> `<Link to={row.taskId}>` 是相對路徑，react-router v6 會解析為 `/create/work-items/<taskId>`。

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm exec vitest run test/adversarial/factory-assets.test.ts -t '工作項歷史'`
Expected: 仍 FAIL——該測試同時要求 `HistoryDetail.tsx`，由 Task 8 建立。確認失敗訊息已從「找不到 HistoryList.tsx」變成「找不到 HistoryDetail.tsx」。

- [ ] **Step 5: Commit**

```bash
git add backstage/plugins/factory-draft/src/work-item-history/HistoryList.tsx test/adversarial/factory-assets.test.ts
git commit -m "feat(work-item-history): 清單頁

一次 listTasks 取得完整 spec.parameters；template 過濾在前端做
（後端無此篩選）。Issue 連結不放清單，避免每列一次請求。"
```

---

### Task 8: 詳情 `HistoryDetail.tsx`

**Files:**
- Create: `backstage/plugins/factory-draft/src/work-item-history/HistoryDetail.tsx`

- [ ] **Step 1: 建立 HistoryDetail**

建立 `backstage/plugins/factory-draft/src/work-item-history/HistoryDetail.tsx`：

```tsx
/**
 * 工作項歷史詳情（唯讀）。
 *
 * useTaskEventStream 一次給齊三樣東西：task.spec.parameters（表單原值）、
 * output（新任務的 Issue links）、stepLogs（舊任務唯一留有 Issue URL 的地方）。
 * 內建 OngoingTask 用的是同一個 hook，已完成任務會 replay 完整事件。
 *
 * 本頁不重造 log 檢視——底部連回內建任務頁。
 */
import React from 'react'
import { useParams } from 'react-router-dom'
import { useTaskEventStream } from '@backstage/plugin-scaffolder-react'
import { ErrorPanel, InfoCard, Link, Progress } from '@backstage/core-components'
import Box from '@material-ui/core/Box'
import Typography from '@material-ui/core/Typography'
import { extractIssueUrl } from '../../../../../src/work-item-history/issue-url.ts'
import {
  formatTimestamp,
  toWorkItemRecord,
} from '../../../../../src/work-item-history/task-record.ts'

function Field(props: { label: string; value: string }) {
  return (
    <Box marginBottom={1.5}>
      <Typography variant="subtitle2" color="textSecondary">
        {props.label}
      </Typography>
      <Typography variant="body2" component="pre" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
        {props.value.length > 0 ? props.value : '（無內容）'}
      </Typography>
    </Box>
  )
}

export function HistoryDetail() {
  const { taskId } = useParams()
  const stream = useTaskEventStream(taskId ?? '')

  if (stream.error) return <ErrorPanel error={stream.error} />
  if (!stream.task) return <Progress />

  const record = toWorkItemRecord(stream.task)
  if (record === null) {
    return <ErrorPanel error={new Error(`任務 ${taskId ?? ''} 的資料無法解析`)} />
  }

  const logLines = Object.values(stream.stepLogs ?? {}).flat()
  const issueUrl = extractIssueUrl({ output: stream.output, logLines })

  return (
    <Box>
      {issueUrl !== undefined && (
        <Box marginBottom={2}>
          <Typography variant="subtitle2" color="textSecondary">
            已建立的 Issue
          </Typography>
          <Link to={issueUrl}>{issueUrl}</Link>
        </Box>
      )}

      <Box marginBottom={2}>
        <InfoCard title="表單內容（唯讀）" titleTypographyProps={{ component: 'h2' }}>
          <Field label="一句話需求（Issue 標題）" value={record.oneLiner} />
          <Field label="任務類型" value={record.taskType} />
          <Field label="目標 repo" value={record.targetRepo} />
          <Field label="目標分支" value={record.baseBranch} />
          <Field label="需求描述（PRD）" value={record.requirement} />
        </InfoCard>
      </Box>

      <InfoCard title="任務資訊" titleTypographyProps={{ component: 'h2' }}>
        <Field label="Task ID" value={record.taskId} />
        <Field label="建立者" value={record.createdBy} />
        <Field label="建立時間" value={formatTimestamp(record.createdAt)} />
        <Field label="狀態" value={record.status} />
        {/* 內建任務頁的路徑；scaffolder 的 task routeRef 未公開匯出，故直接寫路徑。 */}
        <Link to={`/create/tasks/${record.taskId}`}>查看執行 log</Link>
      </InfoCard>
    </Box>
  )
}
```

- [ ] **Step 2: 執行測試確認通過**

Run: `pnpm exec vitest run test/adversarial/factory-assets.test.ts`
Expected: PASS，含 Task 7 那條「歷史頁元件從 src/ 取用純函式」

- [ ] **Step 3: 跑完整測試套件**

Run: `pnpm test`
Expected: 全綠

- [ ] **Step 4: Commit**

```bash
git add backstage/plugins/factory-draft/src/work-item-history/HistoryDetail.tsx
git commit -m "feat(work-item-history): 唯讀詳情頁

useTaskEventStream 一次取得 parameters/output/log；Issue 連結
新任務讀 output.links、舊任務退回解析 log，取不到就不顯示。"
```

---

### Task 9: ADR-017 與文件更新

**Files:**
- Create: `docs/ADR/017-backstage-work-item-history.md`
- Modify: `docs/ADR/README.md`
- Modify: `docs/03-idp-backstage.md`（§3.4 元件表）

- [ ] **Step 1: 建立 ADR-017**

建立 `docs/ADR/017-backstage-work-item-history.md`：

```markdown
# ADR-017：Backstage 解凍擴大——工作項歷史唯讀查閱

- **狀態**：已接受
- **日期**：2026-09-10
- **決定者**：使用者裁決（brainstorming 設計會談）
- **對應**：`ADR-009`（局部解凍）、`14-observation-period.md` §1.7（#50 凍結裁決）、`03-idp-backstage.md` §3.4

## 脈絡

ADR-009 解凍的最小路徑是「factory-work-item 模板 + LLM 草稿 + direct dispatch」。實際使用後出現一個 ADR-009 未涵蓋的需求：**表單送出後無法回溯當時填了什麼**。

現況（2026-09-10 查證 Backstage 1.53.0 / `@backstage/plugin-scaffolder@1.38.1`）：

- 內建 `/create/tasks` 清單只有 Task ID / Template / Created / Owner / Status 五欄；
- 任務詳情頁只顯示步驟、log 與本專案 template 的 `output.text`（僅含一句話需求與任務類型）；
- 完整表單原值**一直存在** scaffolder DB 的 `spec.parameters`（實測 43 筆任務皆有），只是沒有查閱介面；
- 內建「Start Over」讀得到完整原值，但它開的是一張新表單，不是唯讀檢視。

稽核需求是「某次是誰、在何時、用什麼 PRD 內容、開了哪張 Issue」——資料齊備，缺的只是呈現。

## 決策

**解凍範圍擴大，新增一項**：Create 頁的「工作項歷史」唯讀查閱分頁（`/create/work-items`）。

1. **唯讀**。不新增任何寫入路徑、不新增後端端點、不擴充憑證或權限範圍。資料一律來自現有的 scaffolder read API（`listTasks` / `getTask` / `streamLogs`）。
2. **實作落在本 repo**：以 `SubPageBlueprint` 掛入既有的 `factory-draft` 前端 module，`../backstage-app` 零改動。解析邏輯放 `src/work-item-history/`，受本 repo 的 vitest 與覆蓋率門檻管束。
3. **template 附帶一項純新增**：`output.links` 輸出 `github:issues:create` 的 `issueUrl`。在此之前建立的任務退回解析 log 取得同一資訊。

**維持凍結的其餘範圍**：Backstage 其他 Template、Scoreboard、TechDocs 部署、catalog 探索、維運承諾——全部維持 #50 與 ADR-009 的凍結狀態。

## 後果

### 正面
- 稽核閉環：工作項的「填了什麼」不再只能靠 GitHub Issue 反推或翻 DB。
- 零擴權：唯讀、無新端點、無新憑證，安全邊界與 ADR-009 相同。
- 可逆（D1 延續）：全部工件在本 repo 版控，移除擴充即完全退回 ADR-009 狀態。

### 負面
- Backstage 的維護面再擴大一塊 UI；升版時 `SubPageBlueprint` / `useTaskEventStream` 的簽章變動需重驗。
- 舊任務的 Issue 連結依賴 log 字串解析，屬於已知的脆弱點（退化後果僅為少一個連結）。
- 套件名 `factory-draft` 現在同時裝著草稿欄位與歷史頁，名實不符；日後若再增擴充應考慮更名。

## 未採用的替代方案

- **覆寫內建 Tasks 分頁**：等於 fork 官方頁面，其他 template 的任務歷史會被我們的實作取代，升版維護成本高。
- **新開獨立插件包**：邊界較乾淨，但需修改 `../backstage-app` 的 `package.json` 與 `App.tsx`（另一個 repo），改動半徑大於收益。
- **在清單頁顯示 Issue 連結**：`listTasks` 不回傳 `output`，舊任務的 URL 又只在 log 中，逐列取用會造成 N+1 請求；改為只在詳情頁顯示。
```

- [ ] **Step 2: 更新 ADR 索引**

在 `docs/ADR/README.md` 的表格中，`ADR-016` 那一列之後追加：

```markdown
| [ADR-017](017-backstage-work-item-history.md) | Backstage 解凍擴大——工作項歷史唯讀查閱 | 已接受 | `ADR-009`、`03` §3.4 |
```

- [ ] **Step 3: 更新 docs/03 的元件表**

在 `docs/03-idp-backstage.md` §3.4 的元件表（以 `| Frontend 欄位 |` 開頭那一列）之後追加：

```markdown
| 歷史查閱 | `backstage/plugins/factory-draft/src/work-item-history/`、`src/work-item-history/` | Create 頁的「工作項歷史」唯讀分頁（ADR-017）；解析邏輯為純函式並受 vitest 管束 |
```

- [ ] **Step 4: 確認文件測試仍綠**

Run: `pnpm test`
Expected: 全綠

- [ ] **Step 5: Commit**

```bash
git add docs/ADR/017-backstage-work-item-history.md docs/ADR/README.md docs/03-idp-backstage.md
git commit -m "docs(adr): ADR-017 Backstage 解凍擴大——工作項歷史唯讀查閱

唯讀、無新端點、無擴權；實作全在本 repo，backstage-app 零改動。"
```

---

### Task 10: 瀏覽器實測與驗證結果回寫

**Files:**
- Modify: `backstage/versions.md`

本 repo 沒有前端測試工具鏈，UI 以人工驗收。三個部署時驗證項見 spec §12。

- [ ] **Step 1: 啟動 Backstage**

```bash
cd ../backstage-app && set -a && . ./.env && set +a && yarn dev
```

> `yarn workspace backend start` 不會自動載入 `.env`（versions.md 已記載），故用 repo 級 `yarn dev`。

- [ ] **Step 2: 逐項驗收**

以 GitHub OAuth 登入後，逐項確認：

1. Create 頁出現「工作項歷史」tab（驗證項 1：`attachTo: page:scaffolder` 生效）
2. 清單列出 38 筆 factory-work-item 任務，**不含** 5 筆 agent-add-tests
3. 清單顯示建立時間、一句話需求、任務類型、目標 repo、狀態、建立者
4. 點一句話需求進入詳情，網址為 `/create/work-items/<taskId>`；重新整理後仍正確渲染
5. 詳情顯示完整 PRD 全文（不截斷）——驗證項 2、3：跨 root import 的 `src/work-item-history/task-record.ts` 在 rspack 下可用，且 `useTaskEventStream` replay 帶回 `output`
6. 舊任務（本次變更前建立者）的詳情頁顯示由 log 解析出的 Issue 連結
7. 用「開立 Factory 工作項」新開一張單，其詳情頁顯示由 `output.links` 來的 Issue 連結
8. 「查看執行 log」正確連到 `/create/tasks/<taskId>`

- [ ] **Step 3: 若驗證項 2 失敗（rspack 擋跨 root import）**

啟用 spec §12 的 fallback：

1. 把 `src/work-item-history/` 全部檔案（`narrow.ts`、`task-record.ts`、`issue-url.ts` 與各自的測試）搬到 `backstage/plugins/factory-draft/src/work-item-history/`，並刪除 `src/work-item-history/`；
2. 在 `vitest.config.ts` 的 `test.include` 追加 `'backstage/plugins/**/*.test.ts'`，並把 100% 覆蓋率門檻的路徑改成新位置；
3. 在 `tsconfig.json` 的 `include` 追加 `'backstage/plugins/**/*.ts'`；
4. 更新 Task 7 那條契約測試的斷言字串（改為 `'./task-record.ts'` 與 `'./issue-url.ts'`）；
5. 重跑 `CI=true pnpm test`、`CI=true pnpm typecheck`、`CI=true pnpm coverage`。

- [ ] **Step 4: 回寫驗證結果**

在 `backstage/versions.md` 檔尾追加（把 ✅／⚠️ 依實際結果填寫）：

```markdown
# 2026-09-10 工作項歷史查閱分頁驗證（ADR-017）
# - SubPageBlueprint attachTo { id: 'page:scaffolder', input: 'pages' }：Create 頁 tab 是否出現
# - 插件跨 root import repo 內 src/work-item-history/*.ts（rspack）：是否通過
# - useTaskEventStream 對已完成任務 replay 是否帶回 output（新任務的 Issue links）
# - 舊任務 Issue 連結靠解析 stepLogs：是否成功
```

- [ ] **Step 5: Commit**

```bash
git add backstage/versions.md
git commit -m "docs(backstage): 回寫工作項歷史分頁的部署時驗證結果"
```

---

## 完成標準

- `pnpm test` 全綠、`pnpm typecheck` 無輸出、`pnpm coverage` 門檻通過
- Create 頁有「工作項歷史」tab，清單只列 factory-work-item 任務
- 詳情頁顯示完整表單原值與（可取得時的）Issue 連結，網址可分享
- ADR-017 與 docs/03、ADR/README、versions.md 已更新
- `../backstage-app` 無任何改動（`cd ../backstage-app && git status` 應為 clean）
