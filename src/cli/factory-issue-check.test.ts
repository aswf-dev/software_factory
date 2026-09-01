/**
 * factory-issue-check 測試（Issue 格式檢查器，零 LLM 成本）。
 */
import { describe, expect, it } from 'vitest'
import {
  buildCheckComment,
  checkDodSpecificity,
  checkIssue,
  extractField,
  hasCheckedAcceptance,
  main,
  parseCheckArgs,
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
  it('回傳複雜度分析（需求文字無 scope 訊號 → low）', () => {
    const r = checkIssue(COMPLIANT)
    expect(r.analysis.complexity).toBe('low')
    expect(r.analysis.evidence.length).toBeGreaterThan(0)
  })
  it('需求含跨模組 → 分析 medium', () => {
    const body = COMPLIANT.replace('為 X 補測試', '跨模組的需求，動多個檔案')
    expect(checkIssue(body).analysis.complexity).toBe('medium')
  })
  it('缺需求 → missing requirement，分析 fail-safe high', () => {
    const body = COMPLIANT.replace('### 需求描述（PRD）\n\n為 X 補測試\n\n', '')
    const r = checkIssue(body)
    expect(r.ok).toBe(false)
    expect(r.missing).toContain('requirement')
    expect(r.analysis.complexity).toBe('high')
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
  it('留言包含複雜度分析行（即使格式不合規）', () => {
    expect(buildCheckComment(checkIssue(COMPLIANT))).toContain('📊 **複雜度分析**')
    expect(buildCheckComment(checkIssue(COMPLIANT))).toContain('low')
    expect(buildCheckComment(checkIssue('x'))).toContain('📊 **複雜度分析**')
    expect(buildCheckComment(checkIssue('x'))).toContain('high')
  })
  it('有建議模型時 → 🤖 行含 tier、primary 與 fallback', () => {
    const r = checkIssue(COMPLIANT)
    const c = buildCheckComment(r, {
      tier: 'low',
      selected: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      chain: [
        { provider: 'deepseek', model: 'deepseek-v4-flash' },
        { provider: 'qwen', model: 'qwen3.7-flash' },
      ],
      reason: 'Issue 需求分析：low',
    })
    expect(c).toContain('🤖 **建議模型**')
    expect(c).toContain('deepseek/deepseek-v4-flash')
    expect(c).toContain('low tier')
    expect(c).toContain('qwen/qwen3.7-flash')
  })
  it('無建議模型 → 不出 🤖 行', () => {
    expect(buildCheckComment(checkIssue(COMPLIANT))).not.toContain('🤖')
  })
})

describe('parseCheckArgs', () => {
  it('positional issueNumber + --tiers/--providers 旗標', () => {
    const { issueNumber, paths } = parseCheckArgs(['12', '--tiers', 't.yaml', '--providers', 'p.yaml'])
    expect(issueNumber).toBe('12')
    expect(paths).toEqual({ tiersPath: 't.yaml', providersPath: 'p.yaml' })
  })
  it('無旗標 → 預設路徑', () => {
    const { paths } = parseCheckArgs(['12'])
    expect(paths.tiersPath).toBe('config/dsh/model-tiers.yaml')
    expect(paths.providersPath).toBe('config/dsh/settings.providers.yaml')
  })
  it('缺旗標值 → CliError', () => {
    expect(() => parseCheckArgs(['12', '--tiers'])).toThrow()
  })
  it('未知參數 → CliError', () => {
    expect(() => parseCheckArgs(['12', 'extra'])).toThrow()
  })
})

describe('main（注入 fake gh）', () => {
  it('讀 issue body 並回傳檢查結果與留言（含分析與建議模型）', () => {
    const gh = (args: string[]): string => {
      expect(args[0]).toBe('issue')
      expect(args[1]).toBe('view')
      return JSON.stringify({ body: COMPLIANT })
    }
    const out = main(['12'], gh)
    expect(out.result.ok).toBe(true)
    expect(out.comment).toContain('格式合規')
    expect(out.comment).toContain('📊 **複雜度分析**')
    expect(out.comment).toContain('🤖 **建議模型**')
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

/**
 * DoD 具體性檢查（docs/18 §4 G5、Issue #200）：模板三個 checkbox 對每個 Issue 都
 * 逐字相同，「字面存在」不等於「具體可驗證」。本段釘住「每條含可觀察結果、
 * 無空泛詞彙」的形式檢查與 💡 提示留言（advisory，不影響 ok/計分）。
 */

/** 在模板三項固定 checkbox 之後追加自訂驗收條目。 */
function withDodExtras(extras: string[]): string {
  return COMPLIANT.replace(
    '- [x] 跑測試確認綠燈（不跑需外部服務的 E2E）',
    '- [x] 跑測試確認綠燈（不跑需外部服務的 E2E）\n' + extras.join('\n'),
  )
}

/** requirement 含「驗證方式：…」單行（factory Issue 慣例）。 */
const WITH_VERIFICATION = COMPLIANT.replace(
  '為 X 補測試',
  '修復 Y\n\n驗證方式：跑 `npm test` 全綠，並新增回歸測試',
)

describe('checkDodSpecificity', () => {
  it('模板三項不納審；自訂條目逐條審查（可觀察/空泛各自標記）', () => {
    const r = checkDodSpecificity(
      withDodExtras(['- [x] 跑 `npm test` 輸出 0 failed', '- 介面更好用']),
    )
    expect(r.items).toHaveLength(2)
    expect(r.items[0]?.text).toBe('跑 `npm test` 輸出 0 failed')
    expect(r.items[0]?.observable).toBe(true)
    expect(r.items[0]?.vagueTerms).toEqual([])
    expect(r.items[1]?.observable).toBe(false)
    expect(r.items[1]?.vagueTerms).toContain('更好')
    expect(r.specific).toBe(false)
  })
  it('每條都具體（可觀察＋無空泛）→ specific true', () => {
    const r = checkDodSpecificity(
      withDodExtras(['- [x] `npm run coverage` 輸出 src/cli 分支覆蓋 100%']),
    )
    expect(r.items).toHaveLength(1)
    expect(r.specific).toBe(true)
  })
  it('有可觀察線索但含空泛詞 → 仍不具體（防 every 只查單面）', () => {
    const r = checkDodSpecificity(withDodExtras(['- 跑 `npm test` 綠燈，體驗更好']))
    expect(r.items[0]?.observable).toBe(true)
    expect(r.items[0]?.vagueTerms).toEqual(['更好'])
    expect(r.specific).toBe(false)
  })
  it('混合一具體一空泛 → specific false（防 every 退化為 some）', () => {
    const r = checkDodSpecificity(
      withDodExtras(['- [x] `npm test` 綠燈', '- [x] 盡量完善文檔']),
    )
    expect(r.items).toHaveLength(2)
    expect(r.specific).toBe(false)
  })
  it('裸 bullet 與未勾選自訂條目都納審', () => {
    const r = checkDodSpecificity(
      withDodExtras([
        '- 執行驗證命令回傳 exit 0',
        '- [ ] 補回歸測試（test/ 目錄）',
        '- [ ]', // 裸 checkbox 行：不構成條目，跳過
      ]),
    )
    expect(r.items).toHaveLength(2)
    expect(r.items[0]?.observable).toBe(true)
    expect(r.items[1]?.text).toBe('補回歸測試（test/ 目錄）')
  })
  it('acceptance 僅模板三項 → 退回 requirement 的「驗證方式」單行', () => {
    const r = checkDodSpecificity(WITH_VERIFICATION)
    expect(r.items).toHaveLength(1)
    expect(r.items[0]?.text).toBe('跑 `npm test` 全綠，並新增回歸測試')
    expect(r.specific).toBe(true)
  })
  it('無自訂條目且無驗證方式 → 空清單、specific false（僅模板 checkbox = 空洞）', () => {
    const r = checkDodSpecificity(COMPLIANT)
    expect(r.items).toEqual([])
    expect(r.specific).toBe(false)
  })
  it('驗證方式：接連續 bullet → 收集到非 bullet 為止', () => {
    const body = COMPLIANT.replace(
      '為 X 補測試',
      [
        '修復 Z',
        '',
        '驗證方式：',
        '- 跑 `vitest run` 綠燈',
        '- 錯誤率下降 50%',
        '以上為全部。',
      ].join('\n'),
    )
    const r = checkDodSpecificity(body)
    expect(r.items).toHaveLength(2)
    expect(r.items[1]?.observable).toBe(true)
    expect(r.specific).toBe(true)
  })
  it('半形冒號的驗證方式行亦可抽取', () => {
    const body = COMPLIANT.replace('為 X 補測試', '修復 V\n\n驗證方式: run tests, expect green')
    const r = checkDodSpecificity(body)
    expect(r.items).toHaveLength(1)
    expect(r.specific).toBe(true)
  })
  it('驗證方式：後為空且下一行非 bullet → 空清單', () => {
    const body = COMPLIANT.replace('為 X 補測試', '修復 W\n\n驗證方式：\n稍後補上')
    const r = checkDodSpecificity(body)
    expect(r.items).toEqual([])
    expect(r.specific).toBe(false)
  })
  it('缺 acceptance 欄位 → 仍退回 requirement 驗證方式（合規判定另行處理）', () => {
    const body = [
      '### 任務類型',
      '',
      'agent-fix-bug',
      '',
      '### 需求描述（PRD）',
      '',
      '修復 V',
      '',
      '驗證方式：`npm test` 綠燈',
      '',
    ].join('\n')
    const r = checkDodSpecificity(body)
    expect(r.items).toHaveLength(1)
    expect(r.specific).toBe(true)
    expect(checkIssue(body).missing).toContain('acceptance')
  })
  it('英文空泛詞不分大小寫命中', () => {
    const r = checkDodSpecificity(withDodExtras(['- Make It Better and Optimize the flow']))
    expect(r.items[0]?.vagueTerms).toEqual(expect.arrayContaining(['better', 'optimize']))
    expect(r.items[0]?.observable).toBe(false)
    expect(r.specific).toBe(false)
  })
})

describe('buildCheckComment — 💡 DoD 具體性提示（advisory）', () => {
  it('空泛自訂條目 → 留言列出台詞、空泛詞與缺可觀察原因', () => {
    const c = buildCheckComment(
      checkIssue(
        withDodExtras([
          '- [x] 跑 `npm test` 綠燈', // 具體條目：不應出現在提示中
          '- 介面更好用', // 缺可觀察＋空泛
          '- 介面更親和', // 僅缺可觀察
          '- 跑 `npm test` 綠燈，體驗更好', // 僅空泛（有可觀察線索）
        ]),
      ),
    )
    expect(c).toContain('💡 **DoD 具體性提示**')
    expect(c).toContain('「介面更好用」')
    expect(c).toContain('空泛詞彙：更好')
    expect(c).toContain('「介面更親和」（缺可觀察結果')
    expect(c).toContain('「跑 `npm test` 綠燈，體驗更好」（空泛詞彙：更好）')
    expect(c).not.toContain('「跑 `npm test` 綠燈」（')
    expect(c).toContain('缺可觀察結果')
  })
  it('僅模板 checkbox 且無驗證方式 → 提示補寫可驗證條目', () => {
    const c = buildCheckComment(checkIssue(COMPLIANT))
    expect(c).toContain('💡 **DoD 具體性提示**')
    expect(c).toContain('只有表單固定的 3 個勾選項')
  })
  it('具體驗收描述 → 不發提示', () => {
    const c = buildCheckComment(checkIssue(WITH_VERIFICATION))
    expect(c).not.toContain('💡')
  })
  it('提示不影響合規判定：ok/missing/exit 語義與計分行不變', () => {
    const r = checkIssue(COMPLIANT)
    expect(r.ok).toBe(true)
    expect(r.missing).toEqual([])
    const c = buildCheckComment(r)
    expect(c).toContain('格式合規')
    expect(c).toContain('📊 **複雜度分析**')
  })
  it('提示列不含「格式不合規」——避免誤觸 workflow 的出口 grep', () => {
    expect(buildCheckComment(checkIssue(COMPLIANT))).not.toContain('格式不合規')
  })
  it('超 60 字條目 → 留言截斷顯示', () => {
    const longText = `讓體驗更好${'長'.repeat(70)}`
    const c = buildCheckComment(checkIssue(withDodExtras([`- ${longText}`])))
    expect(c).toContain('💡 **DoD 具體性提示**')
    expect(c).not.toContain(longText)
    expect(c).toContain(`${'長'.repeat(55)}…」`)
  })
})

describe('main — 具體性提示接進留言', () => {
  it('fake gh 回傳空泛 DoD → comment 含 💡 提示', () => {
    const gh = (): string => JSON.stringify({ body: withDodExtras(['- 盡量優化']) })
    const out = main(['200'], gh)
    expect(out.comment).toContain('💡 **DoD 具體性提示**')
  })
})
