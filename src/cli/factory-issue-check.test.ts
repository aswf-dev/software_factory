/**
 * factory-issue-check 測試（Issue 格式檢查器，零 LLM 成本）。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildCheckComment,
  buildRequirementAnchorLines,
  buildRequirementAnchors,
  checkDodSpecificity,
  checkIssue,
  checkRiskPaths,
  extractDeclaredPaths,
  extractField,
  hasCheckedAcceptance,
  loadHardRules,
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
      selected: { provider: 'deepseek', model: 'deepseek-flash' },
      chain: [
        { provider: 'deepseek', model: 'deepseek-flash' },
        { provider: 'qwen', model: 'qwen3.7-flash' },
      ],
      reason: 'Issue 需求分析：low',
    })
    expect(c).toContain('🤖 **建議模型**')
    expect(c).toContain('deepseek/deepseek-flash')
    expect(c).toContain('low tier')
    expect(c).toContain('qwen/qwen3.7-flash')
  })
  it('無建議模型 → 不出 🤖 行', () => {
    expect(buildCheckComment(checkIssue(COMPLIANT))).not.toContain('🤖')
  })

  /**
   * 2026-09-11 實測缺陷：留言說 deepseek-flash（high），factory-run 實跑 opus-5
   * （critical）——因為本檢查不計分，critical 升級分支在此不可達。留言必須揭露，
   * 否則人看到的建議與實際執行不符（見 fubon-tradingbot#611、ADR-011）。
   */
  describe('critical 升級揭露（留言與實跑可能不一致）', () => {
    const highRec = {
      tier: 'high' as const,
      selected: { provider: 'deepseek', model: 'deepseek-flash' },
      chain: [{ provider: 'deepseek', model: 'deepseek-flash' }],
      reason: 'Issue 需求分析：high',
      criticalPrimary: { provider: 'anthropic', model: 'claude-opus-5' },
    }

    it('tier=high 且有 criticalPrimary → 揭露可能升級，並指名 critical 模型與門檻', () => {
      const c = buildCheckComment(checkIssue(COMPLIANT), highRec)
      expect(c).toContain('⚠️ **實際執行可能升級**')
      expect(c).toContain('anthropic/claude-opus-5')
      expect(c).toContain('≥ 4') // CRITICAL_MIN_TOTAL：只講「可能升級」卻不給判準等於沒說
    })

    it('critical 模型名取自設定而非硬編碼（換模型 → 揭露文字跟著換）', () => {
      const c = buildCheckComment(checkIssue(COMPLIANT), {
        ...highRec,
        criticalPrimary: { provider: 'acme', model: 'future-flagship-9' },
      })
      expect(c).toContain('acme/future-flagship-9')
      expect(c).not.toContain('claude-opus-5')
    })

    it('tier=low → 不揭露（low/medium 永遠不會被升級為 critical）', () => {
      const c = buildCheckComment(checkIssue(COMPLIANT), { ...highRec, tier: 'low' })
      expect(c).not.toContain('實際執行可能升級')
    })

    it('tier=critical → 不揭露（已是最高 tier，無可升級）', () => {
      const c = buildCheckComment(checkIssue(COMPLIANT), { ...highRec, tier: 'critical' })
      expect(c).not.toContain('實際執行可能升級')
    })

    it('未宣告 critical tier → 不揭露（不得憑空宣稱升級到不存在的 tier）', () => {
      const { criticalPrimary: _omit, ...noCritical } = highRec
      const c = buildCheckComment(checkIssue(COMPLIANT), noCritical)
      expect(c).not.toContain('實際執行可能升級')
    })
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

/**
 * 事前風險路徑檢查（路徑 3）：從 PRD 的「目標模組 / 檔案」段落抽出宣告路徑，
 * 比對 risk-paths.yml 的 H1–H7 glob。
 *
 * 動機（factory-scoreboard#3 實證）：初始計分收不到 changedPaths
 * （factory-run.yml 只傳 --catalog/--risk-paths，score.ts 預設 []），
 * 故 agent 啟動前**沒有任何風險訊號**——#3 的 PRD 白紙黑字寫著要改
 * `.github/workflows/ci.yml`（H5），卻一路放行到燒掉 156k tokens 才由
 * agent 依 SR3 停手。本檢查把該訊號提前到開單當下，零 LLM 成本。
 *
 * 效力：**advisory**（人類裁決）——不改 ok/missing、不動 oversight/* 標籤、
 * 不讓 PRD 自由文字成為計分輸入（docs/06 維持只讀 catalog + risk-paths）。
 */
const HARD_RULES = {
  H1: ['src/auth/**'],
  H5: ['.github/**', 'CODEOWNERS'],
  H6: ['migrations/**', '**/*schema*'],
} as const

/** 以「目標模組 / 檔案」段落取代 COMPLIANT 的需求文字。 */
function withTargets(lines: string[]): string {
  return COMPLIANT.replace('為 X 補測試', ['目標模組 / 檔案：', ...lines].join('\n'))
}

describe('extractDeclaredPaths', () => {
  it('抽出「目標模組 / 檔案」段落的 bullet 路徑（去括號註記）', () => {
    const body = withTargets(['  - .github/workflows/ci.yml（新增 coverage 步驟）', '  - src/a.ts'])
    expect(extractDeclaredPaths(body)).toEqual(['.github/workflows/ci.yml', 'src/a.ts'])
  })
  it('段落標題變體（目標檔案／目標模組）皆可辨識', () => {
    expect(extractDeclaredPaths(COMPLIANT.replace('為 X 補測試', '目標檔案：\n  - src/a.ts'))).toEqual([
      'src/a.ts',
    ])
  })
  it('單行冒號形式：目標模組 / 檔案：src/a.ts', () => {
    expect(extractDeclaredPaths(COMPLIANT.replace('為 X 補測試', '目標模組 / 檔案：src/a.ts'))).toEqual([
      'src/a.ts',
    ])
  })
  it('遇到非 bullet 行即停止（不吞噬後續段落）', () => {
    const body = withTargets(['  - src/a.ts', '', '做什麼（一句話）：', '  - 這不是路徑'])
    expect(extractDeclaredPaths(body)).toEqual(['src/a.ts'])
  })
  it('無該段落 → 空陣列（fail-safe 由呼叫端處理）', () => {
    expect(extractDeclaredPaths(COMPLIANT)).toEqual([])
  })
  it('無 requirement 欄位 → 空陣列', () => {
    expect(extractDeclaredPaths('### 任務類型\n\nx\n')).toEqual([])
  })
})

describe('checkRiskPaths', () => {
  it('命中 H5（#3 真實情境：.github/workflows/ci.yml）', () => {
    const r = checkRiskPaths(withTargets(['  - .github/workflows/ci.yml（新增 coverage 步驟）']), HARD_RULES)
    expect(r.declared).toEqual(['.github/workflows/ci.yml'])
    expect(r.hits).toEqual([{ rule: 'H5', path: '.github/workflows/ci.yml', pattern: '.github/**' }])
  })
  it('未命中任何硬規則 → hits 空', () => {
    const r = checkRiskPaths(withTargets(['  - src/util/format.ts']), HARD_RULES)
    expect(r.hits).toEqual([])
    expect(r.declared).toEqual(['src/util/format.ts'])
  })
  it('多路徑多規則 → 逐一列出', () => {
    const r = checkRiskPaths(withTargets(['  - CODEOWNERS', '  - migrations/001.sql']), HARD_RULES)
    expect(r.hits.map((h) => h.rule)).toEqual(['H5', 'H6'])
  })
  it('未宣告目標檔案 → declared 空（觸發 fail-safe 提示）', () => {
    expect(checkRiskPaths(COMPLIANT, HARD_RULES).declared).toEqual([])
  })
  it('無 hardRules（設定缺失）→ 不誤報', () => {
    expect(checkRiskPaths(withTargets(['  - .github/x.yml']), {}).hits).toEqual([])
  })
  it('hardRules 為 undefined（?? {} 的 nullish 分支）→ 不誤報', () => {
    expect(checkRiskPaths(withTargets(['  - .github/x.yml']), undefined).hits).toEqual([])
  })
  it('bullet 只有括號註記（清理後為空）→ 該項略過，不產生空字串路徑', () => {
    // `- （僅說明，非路徑）` → clean() 後為空；若未過濾會變成 '' 並可能誤匹配 glob
    expect(extractDeclaredPaths(withTargets(['  - （僅說明，非路徑）', '  - src/a.ts']))).toEqual([
      'src/a.ts',
    ])
  })
})

describe('buildCheckComment — ⚠️ 事前風險路徑提示（advisory）', () => {
  const hitBody = withTargets(['  - .github/workflows/ci.yml（新增 coverage 步驟）'])

  it('命中硬規則 → ⚠️ 行列出規則、路徑與 pattern', () => {
    const c = buildCheckComment(checkIssue(hitBody, HARD_RULES))
    expect(c).toContain('⚠️ **事前風險路徑提示**')
    expect(c).toContain('H5')
    expect(c).toContain('.github/workflows/ci.yml')
  })
  it('提示為 advisory：不改 ok、不含「格式不合規」（避免誤觸 workflow grep）', () => {
    const r = checkIssue(hitBody, HARD_RULES)
    expect(r.ok).toBe(true)
    expect(buildCheckComment(r)).not.toContain('格式不合規')
  })
  it('未命中 → 不出 ⚠️ 行', () => {
    expect(buildCheckComment(checkIssue(withTargets(['  - src/util/a.ts']), HARD_RULES))).not.toContain(
      '⚠️ **事前風險路徑提示**',
    )
  })
  it('未宣告目標檔案 → fail-safe 提示（不阻擋）', () => {
    const c = buildCheckComment(checkIssue(COMPLIANT, HARD_RULES))
    expect(c).toContain('PRD 未宣告目標檔案')
  })
  it('未傳 hardRules → 完全不輸出風險段落（向後相容）', () => {
    const c = buildCheckComment(checkIssue(hitBody))
    expect(c).not.toContain('⚠️ **事前風險路徑提示**')
    expect(c).not.toContain('PRD 未宣告目標檔案')
  })
  it('宣告路徑但未命中 → 既不出 ⚠️ 也不出 fail-safe 提示', () => {
    const c = buildCheckComment(checkIssue(withTargets(['  - src/util/a.ts']), HARD_RULES))
    expect(c).not.toContain('⚠️ **事前風險路徑提示**')
    expect(c).not.toContain('PRD 未宣告目標檔案')
  })
})

describe('loadHardRules（設定載入；fail-safe 為「不誤報」）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'risk-paths-'))
  const write = (name: string, content: string): string => {
    const p = join(tmp, name)
    writeFileSync(p, content)
    return p
  }

  it('讀出 hard_rules（rule id → glob 陣列）', () => {
    const p = write('ok.yml', 'hard_rules:\n  H5:\n    - ".github/**"\n  H1:\n    - "src/auth/**"\n')
    expect(loadHardRules(p)).toEqual({ H5: ['.github/**'], H1: ['src/auth/**'] })
  })
  it('檔案不存在 → undefined（設定缺失不得使檢查器爆掉）', () => {
    expect(loadHardRules(join(tmp, 'nope.yml'))).toBeUndefined()
  })
  it('YAML 語法錯誤 → undefined', () => {
    expect(loadHardRules(write('bad.yml', 'hard_rules:\n  - [unclosed\n'))).toBeUndefined()
  })
  it('缺 hard_rules 鍵 → undefined', () => {
    expect(loadHardRules(write('empty.yml', 'other: 1\n'))).toBeUndefined()
  })
  it('hard_rules 非物件（純量）→ undefined', () => {
    expect(loadHardRules(write('scalar.yml', 'hard_rules: 42\n'))).toBeUndefined()
  })
  it('空檔（load 回 undefined）→ undefined', () => {
    expect(loadHardRules(write('nil.yml', ''))).toBeUndefined()
  })
  it('非字串陣列的規則值被略過（不致誤報）', () => {
    const p = write('mixed.yml', 'hard_rules:\n  H5:\n    - ".github/**"\n  H9: 3\n  H8:\n    - 7\n')
    expect(loadHardRules(p)).toEqual({ H5: ['.github/**'] })
  })
  it('真實 risk-paths.yml 可載入且含 H5', () => {
    const rules = loadHardRules('.github/factory/risk-paths.yml')
    expect(rules?.H5).toContain('.github/**')
  })
})

describe('main — --risk-paths 接線（advisory，不改紅綠燈）', () => {
  const hitBody = withTargets(['  - .github/workflows/ci.yml（新增 coverage 步驟）'])

  it('傳 --risk-paths → 留言含 ⚠️ 事前風險路徑提示，且 ok 不變', () => {
    const gh = (): string => JSON.stringify({ body: hitBody })
    const out = main(['3', '--risk-paths', '.github/factory/risk-paths.yml'], gh)
    expect(out.comment).toContain('⚠️ **事前風險路徑提示**')
    expect(out.comment).toContain('H5')
    expect(out.result.ok).toBe(true)
    expect(out.comment).not.toContain('格式不合規')
  })
  it('不傳 --risk-paths → 無風險段落（向後相容）', () => {
    const gh = (): string => JSON.stringify({ body: hitBody })
    expect(main(['3'], gh).comment).not.toContain('⚠️ **事前風險路徑提示**')
  })
  it('--risk-paths 指向不存在的檔 → 靜默略過，不影響判定', () => {
    const gh = (): string => JSON.stringify({ body: hitBody })
    const out = main(['3', '--risk-paths', 'no/such/file.yml'], gh)
    expect(out.result.ok).toBe(true)
    expect(out.comment).not.toContain('⚠️ **事前風險路徑提示**')
  })
  it('parseCheckArgs 支援 --risk-paths；預設 undefined', () => {
    expect(parseCheckArgs(['1', '--risk-paths', 'r.yml']).paths.riskPathsPath).toBe('r.yml')
    expect(parseCheckArgs(['1']).paths.riskPathsPath).toBeUndefined()
  })
  it('--risk-paths 缺值 → CliError', () => {
    expect(() => parseCheckArgs(['1', '--risk-paths'])).toThrow()
  })
})

describe('REQ id 錨定（RTM 語意補實）', () => {
  /** 含自訂驗收條目的 Issue body（DoD 三項固定 + 兩條自訂）。 */
  const WITH_CUSTOM_DOD = [
    '### 任務類型',
    '',
    'agent-fix-bug',
    '',
    '### 需求描述（PRD）',
    '',
    '修復 X',
    '',
    '### 驗收標準（DoD）',
    '',
    '- [x] 有可驗證的測試/驗證方式（測試紅→綠或明確驗證命令）',
    '- [x] 不觸碰高風險路徑（H1–H3 等硬規則，見 risk-paths.yml）',
    '- [x] 跑測試確認綠燈（不跑需外部服務的 E2E）',
    '- 執行 `npm test` 全綠',
    '- `parse()` 對空字串回傳 undefined',
    '',
  ].join('\n')

  it('依驗收條目順序產生 REQ-1…REQ-n', () => {
    const anchors = buildRequirementAnchors(checkDodSpecificity(WITH_CUSTOM_DOD))
    expect(anchors.map((a) => a.id)).toEqual(['REQ-1', 'REQ-2'])
    expect(anchors[0]?.text).toContain('npm test')
  })

  it('checkIssue 輸出 requirements 錨點', () => {
    expect(checkIssue(WITH_CUSTOM_DOD).requirements.map((a) => a.id)).toEqual(['REQ-1', 'REQ-2'])
  })

  it('留言含 REQ 清單並指示 agent 沿用編號', () => {
    const comment = buildCheckComment(checkIssue(WITH_CUSTOM_DOD))
    expect(comment).toContain('🔖 **需求追蹤編號（REQ id）**')
    expect(comment).toContain('`REQ-1`')
    expect(comment).toContain('`REQ-2`')
  })

  it('無自訂驗收條目 → 不輸出 REQ 區塊（避免與 G5 提示重複發話）', () => {
    expect(buildRequirementAnchorLines([])).toEqual([])
    expect(buildCheckComment(checkIssue(COMPLIANT))).not.toContain('需求追蹤編號')
  })

  it('過長條目在留言中截斷（留言可讀性）', () => {
    const long = 'x'.repeat(100)
    const lines = buildRequirementAnchorLines([{ id: 'REQ-1', text: long }])
    expect(lines.join('\n')).toContain('…')
    expect(lines.join('\n')).not.toContain(long)
  })
})
