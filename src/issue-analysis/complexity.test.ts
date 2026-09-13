/**
 * 複雜度分析測試（src/issue-analysis/complexity.ts，docs/ADR/011）。
 */
import { describe, expect, it } from 'vitest'
import {
  analyzeComplexity,
  countFileMentions,
  detectComputationalIntensity,
  HIGH_SCOPE_KEYWORDS,
  MEDIUM_SCOPE_KEYWORDS,
  RISK_KEYWORDS,
} from './complexity.js'

describe('countFileMentions', () => {
  it('數出 src/lib 路徑與已知副檔名提及數（去重）', () => {
    const text = '改 src/order/service.ts、src/order/repo.ts、test/order.test.ts 與 config.yml'
    expect(countFileMentions(text)).toBe(4)
  })
  it('同一路徑重複提及只算一次', () => {
    expect(countFileMentions('src/order/service.ts src/order/service.ts')).toBe(1)
  })
  it('無檔案訊號 → 0', () => {
    expect(countFileMentions('只是描述需求，沒有提到檔案')).toBe(0)
  })
})

describe('analyzeComplexity — 需求欄位缺失', () => {
  it('空需求 → fail-safe high（證據註明）', () => {
    const r = analyzeComplexity({ requirement: '' })
    expect(r.complexity).toBe('high')
    expect(r.score).toBe(2)
    expect(r.evidence.join()).toContain('需求欄位缺失')
  })
  it('undefined 需求 → 同 fail-safe', () => {
    expect(analyzeComplexity({}).complexity).toBe('high')
  })
})

describe('analyzeComplexity — scope 關鍵字', () => {
  it('無訊號 → low', () => {
    const r = analyzeComplexity({ requirement: '幫某模組補測試，驗證方式明確' })
    expect(r.complexity).toBe('low')
    expect(r.score).toBe(0)
  })
  it('中 scope 關鍵字（跨模組）→ medium', () => {
    const r = analyzeComplexity({ requirement: '這個需求跨模組，需要動多個檔案' })
    expect(r.complexity).toBe('medium')
    expect(r.evidence.join()).toContain('scope 中')
  })
  it('高 scope 關鍵字（跨服務/架構）→ high', () => {
    for (const kw of ['跨服務', '架構', '共用抽象', '介面變更', '資料庫遷移']) {
      const r = analyzeComplexity({ requirement: `需求涉及${kw}，範圍較大` })
      expect(r.complexity).toBe('high')
    }
    expect(HIGH_SCOPE_KEYWORDS.length).toBeGreaterThan(0)
  })
  it('中與高同時出現 → high（Math.max 語意）', () => {
    const r = analyzeComplexity({ requirement: '跨模組且涉及跨服務架構變更' })
    expect(r.complexity).toBe('high')
  })
  it('低 scope 關鍵字（單一檔案）→ low', () => {
    const r = analyzeComplexity({ requirement: '單一檔案內的小修正' })
    expect(r.complexity).toBe('low')
    expect(r.evidence.join()).toContain('scope 低')
  })
})

describe('analyzeComplexity — 檔案數', () => {
  it('目標檔案 ≥6 → high', () => {
    const req =
      '目標：src/a/1.ts、src/a/2.ts、src/a/3.ts、src/b/1.ts、src/b/2.ts、src/c/1.ts'
    const r = analyzeComplexity({ requirement: req })
    expect(r.complexity).toBe('high')
    expect(r.evidence.join()).toContain('≥6')
  })
  it('目標檔案 3–5 → medium', () => {
    const req = '目標：src/a/1.ts、src/a/2.ts、src/b/1.ts'
    const r = analyzeComplexity({ requirement: req })
    expect(r.complexity).toBe('medium')
    expect(r.evidence.join()).toContain('≥3')
  })
})

describe('analyzeComplexity — 風險關鍵字', () => {
  it('授權/金流/敏感資料任一 → 至少 high（即使 scope 小）', () => {
    for (const kw of ['授權', '認證', '金流', '財務', '敏感資料', 'PII', '憑證', '加密']) {
      const r = analyzeComplexity({ requirement: `只改一個檔案，但涉及${kw}邏輯` })
      expect(r.complexity).toBe('high')
      expect(r.evidence.join()).toContain('風險關鍵字')
    }
    expect(RISK_KEYWORDS.length).toBeGreaterThan(0)
    expect(MEDIUM_SCOPE_KEYWORDS.length).toBeGreaterThan(0)
  })
  it('風險關鍵字與高 scope 併存 → high（evidence 兩條都在）', () => {
    const r = analyzeComplexity({ requirement: '跨服務架構變更，含授權邏輯' })
    expect(r.complexity).toBe('high')
    expect(r.evidence.join()).toContain('scope 高')
    expect(r.evidence.join()).toContain('風險關鍵字')
  })
})

describe('analyzeComplexity — taskType 不影響結果（scope 是決定者）', () => {
  it('agent-add-tests 且範圍小 → low', () => {
    const r = analyzeComplexity({ taskType: 'agent-add-tests', requirement: '為單一工具函式補測試' })
    expect(r.complexity).toBe('low')
  })
  it('agent-fix-bug 但跨模組 → medium（scope 凌駕 taskType）', () => {
    const r = analyzeComplexity({ taskType: 'agent-fix-bug', requirement: '跨模組修正，動多個檔案' })
    expect(r.complexity).toBe('medium')
  })
})

/**
 * B5（34735315950 事故修正）：計算強度軸。
 *
 * 契約：heavy-verify 判定必須**保守**——誤報會讓每個普通任務都吃 critical tier
 * 的旗艦成本，漏報則重演「50 分鐘換 0 commit」。故測試同時釘住兩個方向。
 */
describe('detectComputationalIntensity — 工具級關鍵字', () => {
  it('quint/apalache/模型檢查/形式化 任一命中 → heavy-verify 並回報訊號', () => {
    for (const kw of ['quint', 'apalache', '模型檢查', '形式化', 'TLA+', 'Z3']) {
      const r = detectComputationalIntensity(`本單需要以 ${kw} 處理`)
      expect(r.intensity, `${kw} 應判為 heavy-verify`).toBe('heavy-verify')
      expect(r.signals.length).toBeGreaterThan(0)
    }
  })

  it('純文字需求（無工具/泛用詞）→ standard', () => {
    expect(detectComputationalIntensity('修正登入頁的錯字').intensity).toBe('standard')
    expect(detectComputationalIntensity('').intensity).toBe('standard')
  })
})

describe('detectComputationalIntensity — 泛用詞需 sharpener（防誤報）', () => {
  it('單獨的 verify 不算（幾乎每個任務都有「驗證方式」）', () => {
    const r = detectComputationalIntensity('請補測試，驗證方式明確；跑測試確認綠燈')
    expect(r.intensity).toBe('standard')
  })

  it('verify ＋ 規格級 sharpener → heavy-verify', () => {
    const r = detectComputationalIntensity('以 max-steps 12 執行 verify 並記錄反例')
    expect(r.intensity).toBe('heavy-verify')
  })

  it('反例 單獨出現不算；「不變式」sharpener 併存才算', () => {
    expect(detectComputationalIntensity('找出反例').intensity).toBe('standard')
    expect(detectComputationalIntensity('形式化不變式並找出反例').intensity).toBe('heavy-verify')
  })
})

describe('analyzeComplexity — heavy-verify 抬升複雜度與強度欄位', () => {
  it('模型檢查需求 → complexity high ＋ computationalIntensity heavy-verify ＋ evidence 註明', () => {
    const r = analyzeComplexity({
      requirement: '以 quint 建立 as-is 規格，形式化不變式並存證反例，verify 於 max-steps 12',
    })
    expect(r.complexity).toBe('high')
    expect(r.computationalIntensity).toBe('heavy-verify')
    expect(r.evidence.join()).toContain('heavy-verify')
  })

  it('34735315950 實際 Issue 文字形狀 → heavy-verify（回歸鎖）', () => {
    // 取自 agent-playground/node-redlock#7 的需求描述（事故原始輸入）。
    const r = analyzeComplexity({
      requirement:
        '新增 specs/redlock.qnt、specs/redlockTest.qnt；把已核實的 9 項疑點形式化為不變式與 witness，'
        + '把反例軌跡存證，npx quint verify specs/redlock.qnt --invariants mutualExclusionOnNodes --max-steps 12。',
    })
    expect(r.computationalIntensity).toBe('heavy-verify')
    expect(r.complexity).toBe('high')
  })

  it('一般驗證需求 → standard 且不抬升為 high（不誤燒旗艦）', () => {
    const r = analyzeComplexity({ requirement: '為單一工具函式補測試，跑測試確認綠燈' })
    expect(r.complexity).toBe('low')
    expect(r.computationalIntensity).toBe('standard')
  })

  it('需求欄位缺失 → fail-safe high，但強度不臆測為 heavy（無證據不假設 CPU-bound）', () => {
    const r = analyzeComplexity({ requirement: '' })
    expect(r.complexity).toBe('high')
    expect(r.computationalIntensity).toBe('standard')
  })
})
