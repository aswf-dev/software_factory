/**
 * issue-body 測試：與 factory-issue-check 的 round-trip 契約。
 *
 * 核心主張：buildIssueBody 的產出必須能直接通過 checkIssue（ok=true），
 * 證明 Backstage 模板的 body 格式（同源複製）會通過 CI 檢查器。
 */
import { describe, expect, it } from 'vitest'
import { checkIssue, DOD_LABELS, extractField } from '../cli/factory-issue-check.js'
import { buildIssueBody, buildIssueTitle } from './issue-body.js'

const INPUT = {
  taskType: 'agent-add-tests',
  requirement: '目標模組/檔案：src/scoring\n做什麼：為計分邏輯補測試\n為什麼：提升信心\n範圍：不動 pipeline',
  targetRepo: 'philipz/software_factory',
}

describe('buildIssueTitle', () => {
  it('一律帶 [factory] 前綴（與 ISSUE_TEMPLATE 的 title 模式一致）', () => {
    expect(buildIssueTitle('為計分邏輯補測試')).toBe('[factory] 為計分邏輯補測試')
  })
  it('去除首尾空白', () => {
    expect(buildIssueTitle('  補測試  ')).toBe('[factory] 補測試')
  })
})

describe('buildIssueBody → checkIssue round-trip', () => {
  const body = buildIssueBody(INPUT)

  it('產出可直接通過 factory-issue-check（格式合規）', () => {
    const r = checkIssue(body)
    expect(r.ok).toBe(true)
    expect(r.missing).toEqual([])
    expect(r.taskType).toBe(INPUT.taskType)
  })
  it('extractField 能抽回各欄位值（解析器相容）', () => {
    expect(extractField(body, 'task_type')).toBe(INPUT.taskType)
    expect(extractField(body, 'requirement')).toBe(INPUT.requirement)
  })
  it('DoD 三項全部以 - [x] 輸出（3/3 全勾契約）', () => {
    for (const label of DOD_LABELS) {
      expect(body).toContain(`- [x] ${label}`)
    }
  })
  it('body 包含四個 ### 欄位標題（與表單輸出格式一致）', () => {
    for (const title of ['### 任務類型', '### 需求描述（PRD）', '### 驗收標準（DoD）', '### 目標 repo（預設本 repo）']) {
      expect(body).toContain(title)
    }
  })
})

describe('buildIssueBody 的輸入收斂', () => {
  it('不同 task_type 產出可區分', () => {
    expect(buildIssueBody({ ...INPUT, taskType: 'agent-fix-bug' })).not.toBe(
      buildIssueBody(INPUT),
    )
  })
})
