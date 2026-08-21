/**
 * factory-issue-check 測試（Issue 格式檢查器，零 LLM 成本）。
 */
import { describe, expect, it } from 'vitest'
import {
  buildCheckComment,
  checkIssue,
  extractField,
  hasCheckedAcceptance,
  main,
} from './factory-issue-check.js'

const COMPLIANT = [
  '### 任務類型',
  '',
  'agent-add-tests',
  '',
  '### 需求描述（PRD）',
  '',
  '為 X 補測試',
  '',
  '### 驗收標準（DoD）',
  '',
  '- [x] 有可驗證的測試/驗證方式（測試紅→綠或明確驗證命令）',
  '- [x] 不觸碰高風險路徑（H1–H3 等硬規則，見 risk-paths.yml）',
  '- [x] 跑測試確認綠燈（不跑需外部服務的 E2E）',
  '',
  '### 目標 repo（預設本 repo）',
  '',
  'philipz/software_factory',
  '',
].join('\n')

describe('extractField', () => {
  it('抽取表單欄位值（`### <id>` 後的內容）', () => {
    expect(extractField(COMPLIANT, 'task_type')).toBe('agent-add-tests')
    expect(extractField(COMPLIANT, 'requirement')).toBe('為 X 補測試')
  })
  it('欄位不存在或空白 → undefined', () => {
    expect(extractField(COMPLIANT, 'nonexistent')).toBeUndefined()
    expect(extractField('### 任務類型\n\n', 'task_type')).toBeUndefined() // 標題在但值空白
  })
  it('多欄位時不跨欄位吞噬（停在上一個 `###`）', () => {
    const body =
      '### 任務類型\n\nagent-fix-bug\n\n### 需求描述（PRD）\n\n需求\n\n### 驗收標準（DoD）\n\n- [x] a\n'
    expect(extractField(body, 'task_type')).toBe('agent-fix-bug')
    expect(extractField(body, 'requirement')).toBe('需求')
  })
})

describe('hasCheckedAcceptance', () => {
  it('3 個 DoD 選項全部勾選 → true', () => {
    expect(hasCheckedAcceptance(COMPLIANT)).toBe(true)
  })
  it('無 acceptance 欄位 → false', () => {
    expect(hasCheckedAcceptance('### task_type\n\nx\n')).toBe(false)
  })
  it('acceptance 欄位存在但無勾選（未勾選項不輸出）→ false', () => {
    expect(hasCheckedAcceptance('### 驗收標準（DoD）\n\n- [ ] 未勾\n')).toBe(false)
  })
  it('只勾 1 項（其餘未勾選不輸出）→ false', () => {
    const body = COMPLIANT.replace(
      '- [x] 不觸碰高風險路徑（H1–H3 等硬規則，見 risk-paths.yml）\n',
      '',
    ).replace('- [x] 跑測試確認綠燈（不跑需外部服務的 E2E）\n', '')
    expect(hasCheckedAcceptance(body)).toBe(false)
  })
  it('只勾 2 項 → false', () => {
    const body = COMPLIANT.replace(
      '- [x] 跑測試確認綠燈（不跑需外部服務的 E2E）\n',
      '',
    )
    expect(hasCheckedAcceptance(body)).toBe(false)
  })
  it('勾選的 label 與規定不符（文字漂移）→ false', () => {
    const body = COMPLIANT.replace(
      '- [x] 不觸碰高風險路徑（H1–H3 等硬規則，見 risk-paths.yml）',
      '- [x] 不觸碰高風險路徑',
    )
    expect(hasCheckedAcceptance(body)).toBe(false)
  })
})

describe('checkIssue', () => {
  it('欄位齊全 → ok', () => {
    const r = checkIssue(COMPLIANT)
    expect(r.ok).toBe(true)
    expect(r.missing).toEqual([])
    expect(r.taskType).toBe('agent-add-tests')
  })
  it('缺需求 → missing requirement', () => {
    const body = COMPLIANT.replace('### 需求描述（PRD）\n\n為 X 補測試\n\n', '')
    const r = checkIssue(body)
    expect(r.ok).toBe(false)
    expect(r.missing).toContain('requirement')
  })
  it('缺任務類型 → missing task_type', () => {
    const body = COMPLIANT.replace('### 任務類型\n\nagent-add-tests\n\n', '')
    const r = checkIssue(body)
    expect(r.ok).toBe(false)
    expect(r.missing).toContain('task_type')
  })
  it('缺 DoD 勾選 → missing acceptance', () => {
    // GitHub 表單：未勾選的選項不輸出；此處模擬「勾選項全消失」→ 只有未勾選內容
    const body = COMPLIANT.replaceAll('- [x]', '- [ ]')
    const r = checkIssue(body)
    expect(r.ok).toBe(false)
    expect(r.missing).toContain('acceptance')
  })
  it('全缺 → 列出全部缺失', () => {
    const r = checkIssue('隨便的文字')
    expect(r.ok).toBe(false)
    expect(r.missing).toEqual(['task_type', 'requirement', 'acceptance'])
  })
})

describe('buildCheckComment', () => {
  it('合規 → 正面留言含任務類型', () => {
    expect(buildCheckComment(checkIssue(COMPLIANT))).toContain('格式合規')
    expect(buildCheckComment(checkIssue(COMPLIANT))).toContain('agent-add-tests')
  })
  it('不合規 → 列出缺失欄位', () => {
    const c = buildCheckComment(checkIssue('x'))
    expect(c).toContain('格式不合規')
    expect(c).toContain('task_type')
    expect(c).toContain('requirement')
    expect(c).toContain('acceptance')
  })
})

describe('main（注入 fake gh）', () => {
  it('讀 issue body 並回傳檢查結果與留言', () => {
    const gh = (args: string[]): string => {
      expect(args[0]).toBe('issue')
      expect(args[1]).toBe('view')
      return JSON.stringify({ body: COMPLIANT })
    }
    const out = main(['12'], gh)
    expect(out.result.ok).toBe(true)
    expect(out.comment).toContain('格式合規')
  })
  it('缺 issueNumber → CliError', () => {
    const gh = (): string => {
      throw new Error('should not call gh')
    }
    expect(() => main([], gh)).toThrow()
  })
  it('gh 回傳非 JSON → CliError', () => {
    const gh = (): string => 'not json'
    expect(() => main(['1'], gh)).toThrow()
  })
})
