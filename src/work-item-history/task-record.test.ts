/**
 * task-record 純函式測試。
 *
 * 輸入來自 scaffolder API 的 JSON，欄位可能缺失或型別不符（不同 Backstage
 * 版本、不同 template、早期任務），故每個函式都必須在垃圾輸入下不丟例外。
 */
import { describe, expect, it } from 'vitest'
import { isFactoryWorkItemSpec, normalizeRepo } from './task-record.js'

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
