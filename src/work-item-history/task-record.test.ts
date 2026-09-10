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
