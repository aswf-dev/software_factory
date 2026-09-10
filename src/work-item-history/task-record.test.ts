/**
 * task-record 純函式測試。
 *
 * 輸入來自 scaffolder API 的 JSON，欄位可能缺失或型別不符（不同 Backstage
 * 版本、不同 template、早期任務），故每個函式都必須在垃圾輸入下不丟例外。
 */
import { describe, expect, it } from 'vitest'
import {
  formatTimestamp,
  isFactoryWorkItemSpec,
  normalizeRepo,
  summarize,
  toWorkItemRecord,
  toWorkItemRecords,
} from './task-record.js'

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
  it('owner 是畸形百分比編碼時退回原編碼字串，不丟例外', () => {
    expect(normalizeRepo('github.com?owner=%zz')).toBe('%zz')
  })
  it('repo 是畸形百分比編碼時退回原編碼字串，不丟例外', () => {
    expect(normalizeRepo('github.com?owner=philipz&repo=%zz')).toBe('philipz/%zz')
  })
  it('只有壞掉的那一段退回原樣，另一段照常解碼', () => {
    expect(normalizeRepo('github.com?owner=%zz&repo=my%20repo')).toBe('%zz/my repo')
  })
  it('repo 值本身已含斜線時不再補 owner（實測資料：使用者把 owner/repo 整串填進 repo 欄）', () => {
    // 實測 scaffolder DB 38 筆 factory-work-item 中有 3 筆長這樣（8%）：
    // 補 owner 會產出 philipz/philipz/docker_practice 這種不存在的路徑。
    expect(normalizeRepo('github.com?owner=philipz&repo=philipz%2Fdocker_practice')).toBe(
      'philipz/docker_practice',
    )
  })
  it('只有 repo 沒有 owner 時回傳 repo，不把整串 URL 塞進 repo 欄位', () => {
    expect(normalizeRepo('github.com?repo=camunda_hazelcast')).toBe('camunda_hazelcast')
  })
  it('參數順序顛倒仍解析得出 owner/repo', () => {
    expect(normalizeRepo('github.com?repo=camunda_hazelcast&owner=philipz')).toBe(
      'philipz/camunda_hazelcast',
    )
  })
  it('owner 為空值時不硬湊：單獨出現時原樣返回，另有 repo 時只回 repo', () => {
    // 刻意不把 [^&]+ 放寬成 [^&]*：放寬後 'github.com?owner=&repo=Y' 會產出 '/Y'
    // 這種開頭多一條斜線的假 repo 名，比原樣返回更難察覺是壞資料。
    expect(normalizeRepo('github.com?owner=')).toBe('github.com?owner=')
    expect(normalizeRepo('github.com?owner=&repo=Y')).toBe('Y')
  })
  it('非字串輸入回傳空字串，不丟例外（呼叫端在 plugins 下不受 tsc 檢查）', () => {
    expect(normalizeRepo(undefined)).toBe('')
    expect(normalizeRepo(null)).toBe('')
    expect(normalizeRepo(42)).toBe('')
    expect(normalizeRepo({})).toBe('')
  })
})

describe('isFactoryWorkItemSpec', () => {
  it('認得 factory-work-item 任務', () => {
    expect(
      isFactoryWorkItemSpec({ templateInfo: { entityRef: 'template:default/factory-work-item' } }),
    ).toBe(true)
  })
  it('排除其他 template（agent-add-tests 在同一個清單裡）', () => {
    expect(
      isFactoryWorkItemSpec({ templateInfo: { entityRef: 'template:default/agent-add-tests' } }),
    ).toBe(false)
  })
  it('namespace 刻意不釘死：非 default namespace 的同名 template 仍算命中', () => {
    // template 可能註冊在非 default namespace，寫死 template:default/... 會漏掉它們。
    // 這裡只釘 kind 前綴，namespace 保持萬用是刻意的設計，不是漏網之魚。
    expect(
      isFactoryWorkItemSpec({ templateInfo: { entityRef: 'template:evil/factory-work-item' } }),
    ).toBe(true)
  })
  it('kind 不是 template 時為 false，同名的 component 不算命中', () => {
    expect(
      isFactoryWorkItemSpec({ templateInfo: { entityRef: 'component:default/factory-work-item' } }),
    ).toBe(false)
  })
  it('沒有 kind 前綴的裸名稱為 false', () => {
    expect(isFactoryWorkItemSpec({ templateInfo: { entityRef: 'factory-work-item' } })).toBe(false)
  })
  it('entityRef 非字串時為 false，不丟例外', () => {
    expect(isFactoryWorkItemSpec({ templateInfo: { entityRef: 123 } })).toBe(false)
  })
  it('templateInfo 缺失時為 false，不丟例外', () => {
    expect(isFactoryWorkItemSpec({})).toBe(false)
    expect(isFactoryWorkItemSpec(null)).toBe(false)
    expect(isFactoryWorkItemSpec(undefined)).toBe(false)
    expect(isFactoryWorkItemSpec('nonsense')).toBe(false)
  })
})

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

  it('createdBy 與 spec.user.ref 同時存在且不同時，以 task.createdBy 為準', () => {
    // task.createdBy 是 scaffolder 自己的 created_by 欄位（送出當下的真實身分）；
    // spec.user.ref 只是送出時凍進 spec JSON 的副本，改名或搬 namespace 後會過時。
    const record = toWorkItemRecord({
      id: 'abc',
      createdBy: 'user:default/philipz',
      spec: { user: { ref: 'user:default/stale-copy' } },
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

  it('直接吃 listTasks 的整包結果 { tasks: [...] }，不需呼叫端自己拆封', () => {
    const records = toWorkItemRecords({ tasks: [fullTask] })
    expect(records).toHaveLength(1)
    expect(records[0]?.taskId).toBe('80f332c5-01c3-4e8f-a7b5-9a829dc9dd96')
  })

  it('整包結果的 tasks 為空陣列時回傳空陣列', () => {
    expect(toWorkItemRecords({ tasks: [] })).toEqual([])
  })

  it('既不是陣列也沒有 tasks 陣列時回傳空陣列（listTasks 失敗或形狀改變時不炸頁）', () => {
    expect(toWorkItemRecords(undefined)).toEqual([])
    expect(toWorkItemRecords(null)).toEqual([])
    expect(toWorkItemRecords({})).toEqual([])
    expect(toWorkItemRecords({ tasks: 'nonsense' })).toEqual([])
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
  it('只有空白的字串也顯示破折號，不留看似渲染失敗的空白格', () => {
    expect(formatTimestamp('   ')).toBe('—')
  })
  it('無法解析的字串原樣返回', () => {
    expect(formatTimestamp('not-a-date')).toBe('not-a-date')
  })
  it('形狀不像 ISO 日期時間的字串一律原樣返回，不交給 new Date 亂猜', () => {
    // '12345' 會被 new Date 當成西元 12345 年；純日期 '2026-09-10' 按 UTC 午夜解析，
    // 在 UTC 以西會顯示成前一天；'2026-09-10 08:47:18'（SQLite 原生格式）則被
    // 當成本地時間，靜靜地位移。三者都寧可原樣顯示，也不假造時間。
    expect(formatTimestamp('12345')).toBe('12345')
    expect(formatTimestamp('2026-09-10')).toBe('2026-09-10')
    expect(formatTimestamp('2026-09-10 08:47:18')).toBe('2026-09-10 08:47:18')
  })
  it('形狀像 ISO 但日期不存在時原樣返回', () => {
    expect(formatTimestamp('2026-13-45T00:00:00Z')).toBe('2026-13-45T00:00:00Z')
  })
  it('可解析的 ISO 時間轉成本地字串（必須真的格式化過）', () => {
    // 單用 toContain('2026') 是套套邏輯：原樣返回輸入也會通過（輸入本身就含 '2026'）。
    // 加上「結果不等於原字串」後，只有真的走過 toLocaleString 才可能成立。
    // 固定值 2026-09-10T08:47Z 在 UTC−12…+14 全時區範圍內都仍落在 2026 年。
    const iso = '2026-09-10T08:47:18.000Z'
    const formatted = formatTimestamp(iso)
    expect(formatted).not.toBe(iso)
    expect(formatted).toContain('2026')
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
  it('maxChars 不是可用的正數時退回預設上限，內容不得消失', () => {
    // 呼叫端在 backstage/plugins/** 底下不受 tsc 檢查，maxChars 傳進 NaN／undefined
    // 是實際會發生的事；原本 NaN 會讓比較與 slice 全數失效，整段內容只剩省略號。
    expect(summarize('abcdefghij', Number.NaN)).toBe('abcdefghij')
    expect(summarize('abcdefghij', undefined)).toBe('abcdefghij')
    expect(summarize('abcdefghij', 0)).toBe('abcdefghij')
    expect(summarize('abcdefghij', -5)).toBe('abcdefghij')
  })
  it('退回的預設上限是 120 個字元', () => {
    expect(summarize('x'.repeat(130), Number.NaN)).toBe(`${'x'.repeat(120)}…`)
  })
  it('小數上限取整數，不產生半個字元的切法', () => {
    expect(summarize('abcdefghij', 5.9)).toBe('abcde…')
  })
  it('以字元而非 UTF-16 code unit 截斷，不切出落單的代理對', () => {
    // 切在 code unit 上會得到 'ab\uD83D…'，渲染成 ab�…。
    expect(summarize('ab👩cd', 3)).toBe('ab👩…')
  })
  it('壓平多行中文，全形空白（U+3000）也視為空白', () => {
    // 實際輸入是兩千字以上的多行繁體中文；全形空白目前靠 JS 的 \s 涵蓋，
    // 這個測試把它釘住：日後把 \s+ 改成 [ \n]+ 會在這裡壞掉，而不是壞在清單上。
    const requirement = '【做什麼】\n將 Camunda 7.23.0 遷移至　Operaton 2.1.4。\n【驗收】\n測試全綠。'
    expect(summarize(requirement, 200)).toBe(
      '【做什麼】 將 Camunda 7.23.0 遷移至 Operaton 2.1.4。 【驗收】 測試全綠。',
    )
  })
})
