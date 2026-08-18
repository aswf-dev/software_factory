import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isMainModule } from './is-main-module.js'
import { loadScoreInput, main, parseArgs } from './factory-score.js'

let tmp: string
let catalog: string
let riskPaths: string

/** 寫一個暫存 fixture 檔並回傳路徑。 */
function fixture(name: string, ...lines: string[]): string {
  const path = join(tmp, name)
  writeFileSync(path, `${lines.join('\n')}\n`)
  return path
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'factory-score-'))
  catalog = fixture(
    'catalog-info.yaml',
    'apiVersion: backstage.io/v1alpha1',
    'kind: Component',
    'metadata:',
    '  name: demo',
    '  annotations:',
    '    factory.io/business-criticality: tactical',
    '    factory.io/risk-profile: low',
    '    factory.io/complexity: low',
    '    factory.io/agent-automerge: "false"',
    'spec:',
    '  type: service',
  )
  riskPaths = fixture(
    'risk-paths.yml',
    'hard_rules:',
    '  H1: ["src/auth/**"]',
    '  H5: [".github/**", "CODEOWNERS", "catalog-info.yaml", ".dsh/skills/**"]',
  )
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('parseArgs', () => {
  it('無參數時採用 repo 標準路徑（CI 免設定即可執行）', () => {
    expect(parseArgs([])).toEqual({
      catalogPath: 'catalog-info.yaml',
      riskPathsPath: '.github/factory/risk-paths.yml',
    })
  })

  it('讀取兩個明確指定的路徑', () => {
    expect(parseArgs(['--catalog', 'a.yaml', '--risk-paths', 'b.yml'])).toEqual({
      catalogPath: 'a.yaml',
      riskPathsPath: 'b.yml',
    })
  })

  it('旗標位於陣列結尾且缺值 → 拋錯', () => {
    expect(() => parseArgs(['--catalog'])).toThrow('--catalog requires a path argument')
    expect(() => parseArgs(['--risk-paths'])).toThrow('--risk-paths requires a path argument')
  })

  it('旗標後面接的是另一個旗標 → 拋錯，不得把旗標吞成路徑', () => {
    // 迴歸測試：舊版 `argv[++i] ?? fallback` 只防陣列結尾，
    // 會把 "--risk-paths" 當成 catalogPath 的值，再去讀一個名為
    // "--risk-paths" 的檔案 —— CI 只會看到令人困惑的 ENOENT。
    expect(() => parseArgs(['--catalog', '--risk-paths', 'b.yml'])).toThrow(
      '--catalog requires a path argument',
    )
    expect(() => parseArgs(['--risk-paths', '--catalog', 'a.yaml'])).toThrow(
      '--risk-paths requires a path argument',
    )
  })

  it('無法辨識的參數 → 拋錯，不靜默忽略', () => {
    expect(() => parseArgs(['--unknown', 'x'])).toThrow('unknown argument: --unknown')
    // 位置參數（非旗標）同樣不接受，避免打錯字被當成沒事。
    expect(() => parseArgs(['stray.yaml'])).toThrow('unknown argument: stray.yaml')
  })
})

describe('loadScoreInput', () => {
  it('抽出 factory.io/ annotation 與 hard_rules', () => {
    const { annotations, hardRulePatterns } = loadScoreInput(catalog, riskPaths)
    expect(annotations.agentAutomerge).toBe('false')
    expect(hardRulePatterns.H1).toEqual(['src/auth/**'])
  })

  it('技術棧 annotation → stack 物件（stack/test-framework/quint-spec）', () => {
    const stackCatalog = fixture(
      'stack.yaml',
      'metadata:',
      '  annotations:',
      '    factory.io/stack: typescript',
      '    factory.io/test-framework: vitest',
      '    factory.io/quint-spec: specs/scoring',
    )
    const { stack } = loadScoreInput(stackCatalog, riskPaths)
    expect(stack).toEqual({ stack: 'typescript', testFramework: 'vitest', quintSpec: 'specs/scoring' })
  })

  it('缺技術棧 annotation → stack 欄位為 undefined（不影響計分）', () => {
    const { stack, annotations } = loadScoreInput(catalog, riskPaths)
    expect(stack.stack).toBeUndefined()
    expect(stack.testFramework).toBeUndefined()
    expect(stack.quintSpec).toBeUndefined()
    expect(annotations.businessCriticality).toBe('tactical')
  })

  it('未加引號的 YAML boolean 標註 → 強制轉成字串，不讓計分崩潰', () => {
    // factory.io/agent-automerge: false（未加引號）在 YAML 是 boolean。
    // 舊版未驗證的 cast 會讓 score() 內 `agentAutomerge?.trim()` 拋
    // TypeError —— 等於擁有者的 automerge 否決權讓整個 CLI 當掉。
    const boolCatalog = fixture(
      'bool.yaml',
      'metadata:',
      '  annotations:',
      '    factory.io/business-criticality: tactical',
      '    factory.io/risk-profile: low',
      '    factory.io/complexity: low',
      '    factory.io/agent-automerge: false',
    )
    const { annotations } = loadScoreInput(boolCatalog, riskPaths)
    expect(annotations.agentAutomerge).toBe('false')
    // 轉型後否決權仍須生效。
    expect(main(['--catalog', boolCatalog, '--risk-paths', riskPaths]).score.automergeAllowed).toBe(
      false,
    )
  })

  it('非字串的三軸標註轉成字串後仍走 fail-safe（非法值 → 2 分）', () => {
    const numeric = fixture(
      'numeric.yaml',
      'metadata:',
      '  annotations:',
      '    factory.io/risk-profile: 3',
    )
    expect(loadScoreInput(numeric, riskPaths).annotations.riskProfile).toBe('3')
    const out = main(['--catalog', numeric, '--risk-paths', riskPaths])
    expect(out.score.riskProfile.value).toBe(2)
    expect(out.score.total).toBe(6)
  })

  it('annotations 不是物件 → 視為未標註，交給 fail-safe 計分', () => {
    const weird = fixture('weird.yaml', 'metadata:', '  annotations: "not-a-map"')
    expect(loadScoreInput(weird, riskPaths).annotations).toEqual({})
  })

  it('空檔 / 只有註解的 YAML → 視為空文件，不拋錯', () => {
    const emptyCatalog = fixture('empty-doc.yaml', '')
    const commentRisk = fixture('comment-only.yml', '# 尚未定義任何硬性規則')
    const { annotations, hardRulePatterns } = loadScoreInput(emptyCatalog, commentRisk)
    expect(annotations).toEqual({})
    expect(hardRulePatterns).toEqual({})
  })

  it('hard_rules 為空或缺席 → 視為無硬性規則', () => {
    expect(
      loadScoreInput(catalog, fixture('null-rules.yml', 'hard_rules:')).hardRulePatterns,
    ).toEqual({})
    expect(
      loadScoreInput(catalog, fixture('other-key.yml', 'version: 1')).hardRulePatterns,
    ).toEqual({})
  })

  it('hard_rules 的值是字串而非清單 → 拋錯（fail-loud）', () => {
    // 若放行，matchHardRules 會逐字元迭代字串，靜默地比對不到任何路徑，
    // 使硬性規則形同虛設。
    const badRules = fixture('bad-rules.yml', 'hard_rules:', '  H1: "src/auth/**"')
    expect(() => loadScoreInput(catalog, badRules)).toThrow(/risk-paths/)
  })

  it('hard_rules 含未知規則代號 → 拋錯，避免打錯字的規則被靜默忽略', () => {
    const badId = fixture('bad-id.yml', 'hard_rules:', '  H9: ["src/x/**"]')
    expect(() => loadScoreInput(catalog, badId)).toThrow(/risk-paths/)
  })

  it('catalog 頂層不是 map → 拋錯', () => {
    const scalar = fixture('scalar.yaml', 'just-a-string')
    expect(() => loadScoreInput(scalar, riskPaths)).toThrow(/catalog/)
  })

  it('catalog 是 YAML 陣列 → 拋錯', () => {
    const list = fixture('list.yaml', '- a', '- b')
    expect(() => loadScoreInput(list, riskPaths)).toThrow(/must be a YAML mapping/)
  })

  it('YAML 語法錯誤 → 單行 CliError，不外洩 parser stack', () => {
    const broken = fixture('broken.yaml', 'metadata:', '  annotations:', '   - [unclosed')
    expect(() => loadScoreInput(broken, riskPaths)).toThrow(/is not valid YAML/)
  })

  it('YAML 文件是 null（例如只有 ---）→ 視為空 map', () => {
    const nullDoc = fixture('null-doc.yaml', '---')
    expect(loadScoreInput(nullDoc, riskPaths).annotations).toEqual({})
  })

  it('metadata 缺席 → 視為未標註', () => {
    const noMeta = fixture('no-meta.yaml', 'apiVersion: v1', 'kind: Component')
    expect(loadScoreInput(noMeta, riskPaths).annotations).toEqual({})
  })

  it('annotation 值是複合結構（map/list）→ 忽略該值，走 fail-safe', () => {
    const nested = fixture(
      'nested.yaml',
      'metadata:',
      '  annotations:',
      '    factory.io/risk-profile:',
      '      nested: value',
    )
    expect(loadScoreInput(nested, riskPaths).annotations.riskProfile).toBeUndefined()
  })
})

describe('isMainModule', () => {
  it('進入點不是本模組（被 import 時）→ false', () => {
    expect(isMainModule(join(tmp, 'catalog-info.yaml'), '/self/path.js')).toBe(false)
  })

  it('沒有進入點（argv[1] 為 undefined）→ false', () => {
    // isMainModule 刻意不使用預設參數：若寫成 `entry = process.argv[1]`，
    // 傳入 undefined 會落回預設值，這條分支便永遠測不到。
    expect(isMainModule(undefined, '/self/path.js')).toBe(false)
  })

  it('selfPath 缺席 → false', () => {
    expect(isMainModule('/some/entry.js', undefined)).toBe(false)
  })

  it('進入點不存在 → false，而非讓 realpath 拋錯把 CLI 弄崩', () => {
    expect(isMainModule(join(tmp, 'does-not-exist.js'), '/self/path.js')).toBe(false)
  })

  it('selfPath === realpath(entry) → true（直接執行的判準）', () => {
    const entry = join(tmp, 'entry.js')
    writeFileSync(entry, '')
    expect(isMainModule(entry, realpathSync(entry))).toBe(true)
  })

  // 「透過 symlink 執行本模組 → true」需要真正的子行程，
  // 由 test/integration/factory-score-cli.test.ts 驗證。
})

describe('main', () => {
  it('讀 catalog 三軸 + risk-paths，輸出計分結果', () => {
    const out = main(['--catalog', catalog, '--risk-paths', riskPaths])
    expect(out.score.total).toBe(0)
    expect(out.score.tier).toBe('on-loop')
    expect(out.score.label).toBe('oversight/on-loop')
    expect(out.annotations.businessCriticality).toBe('tactical')
  })

  it('缺三軸標註 → fail-safe 計 6 分（in-loop）', () => {
    const emptyCatalog = fixture(
      'empty.yaml',
      'apiVersion: backstage.io/v1alpha1',
      'kind: Component',
      'metadata:',
      '  name: x',
    )
    const out = main(['--catalog', emptyCatalog, '--risk-paths', riskPaths])
    expect(out.score.total).toBe(6)
    expect(out.score.tier).toBe('in-loop')
  })
})
