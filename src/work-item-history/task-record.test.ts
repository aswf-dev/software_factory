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
