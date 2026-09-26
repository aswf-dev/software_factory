/**
 * write-spec 階段白名單、source.md 快照、關閉關鍵字（ADR-018 §9 護欄①、§12）。
 */
import { describe, expect, it } from 'vitest'
import {
  checkClosingKeywords,
  checkSourceSnapshot,
  checkSpecScope,
  findClosingReferences,
  specPaths,
} from './scope.js'

describe('specPaths', () => {
  it('固定目錄結構（ADR-018 §6）', () => {
    expect(specPaths('redlock')).toEqual({
      dir: 'specs/redlock/',
      source: 'specs/redlock/source.md',
      invariants: 'specs/redlock/invariants.qnt',
      model: 'specs/redlock/model.qnt',
      instances: 'specs/redlock/instances.qnt',
      verify: 'specs/redlock/verify.yml',
      traces: 'specs/redlock/traces/',
    })
  })
})

describe('checkSpecScope：不變量階段', () => {
  it('只動 invariants.qnt、source.md、docs/** → 無 mismatch', () => {
    const paths = ['specs/redlock/invariants.qnt', 'specs/redlock/source.md', 'docs/specs/redlock.md']
    expect(checkSpecScope('invariants', 'redlock', paths)).toEqual([])
  })
  it('寫了 model.qnt 或 src/ → 越界（agent 不得跨到下一階段或改實作）', () => {
    const m = checkSpecScope('invariants', 'redlock', ['specs/redlock/model.qnt', 'src/index.ts'])
    expect(m).toHaveLength(1)
    expect(m[0]!.kind).toBe('write-spec-scope')
    expect(m[0]!.detail).toContain('specs/redlock/model.qnt')
    expect(m[0]!.detail).toContain('src/index.ts')
  })
  it('別的規格目錄也算越界（名稱綁定）', () => {
    expect(checkSpecScope('invariants', 'redlock', ['specs/other/invariants.qnt'])).toHaveLength(1)
  })
})

describe('checkSpecScope：模型階段', () => {
  it('只動 model.qnt、instances.qnt、verify.yml、docs/** → 無 mismatch', () => {
    const paths = [
      'specs/redlock/model.qnt',
      'specs/redlock/instances.qnt',
      'specs/redlock/verify.yml',
      'docs/specs/redlock.md',
    ]
    expect(checkSpecScope('model', 'redlock', paths)).toEqual([])
  })
  it('改 invariants.qnt 或 source.md → 越界，並指明是「已核准、不得修改」', () => {
    const m = checkSpecScope('model', 'redlock', ['specs/redlock/invariants.qnt', 'specs/redlock/source.md'])
    expect(m).toHaveLength(1)
    expect(m[0]!.detail).toContain('已核准')
  })
})

describe('checkSpecScope：traces/ 只能由 CI 寫入', () => {
  it('兩個階段都拒絕 agent 寫 traces/', () => {
    for (const phase of ['invariants', 'model'] as const) {
      const m = checkSpecScope(phase, 'redlock', ['specs/redlock/traces/inv1.itf.json'])
      expect(m).toHaveLength(1)
      expect(m[0]!.detail).toContain('CI')
    }
  })
})

describe('checkSourceSnapshot', () => {
  it('不變量階段：分支上的 source.md 與 CI 快照逐字元一致 → 無 mismatch', () => {
    expect(checkSourceSnapshot('invariants', ['# spec\n'], '# spec\n')).toEqual([])
  })
  it('不變量階段：內容不一致 → mismatch（agent 改寫了意圖原文）', () => {
    const m = checkSourceSnapshot('invariants', ['# spec (edited)\n'], '# spec\n')
    expect(m.map((x) => x.kind)).toEqual(['write-spec-source-tampered'])
  })
  it('不變量階段：任何分支都沒有 source.md → mismatch（不變量沒有可引用的出處）', () => {
    expect(checkSourceSnapshot('invariants', [], '# spec\n').map((x) => x.kind)).toEqual([
      'write-spec-source-missing',
    ])
  })
  it('模型階段不檢查（source.md 已隨不變量核准；改動由白名單攔下）', () => {
    expect(checkSourceSnapshot('model', ['anything'], undefined)).toEqual([])
  })
})

describe('findClosingReferences', () => {
  it('辨識 GitHub 全部九個關閉關鍵字（不分大小寫，可有冒號）', () => {
    const words = ['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved']
    for (const w of words) {
      expect(findClosingReferences(`${w} #7`), w).toEqual([7])
      expect(findClosingReferences(`${w.toUpperCase()}: #7`), w).toEqual([7])
    }
  })
  it('跨 repo 寫法 owner/repo#N 也算', () => {
    expect(findClosingReferences('Closes agent-playground/node-redlock#7')).toEqual([7])
  })
  it('Refs／See／純 #N 不算關閉', () => {
    expect(findClosingReferences('Refs #7\nSee #7\nrelated to #7')).toEqual([])
  })
  it('關鍵字須為獨立單字（prefix、suffix 不算）', () => {
    expect(findClosingReferences('prefixes #7 / hotfix #7')).toEqual([])
  })
})

describe('checkClosingKeywords', () => {
  it('不變量 PR 寫 Closes #N → mismatch（會在第一階段就關掉 Issue）', () => {
    const r = checkClosingKeywords('invariants', 7, ['## 摘要\n\nRefs #7', 'Closes #7'])
    expect(r.mismatches.map((m) => m.kind)).toEqual(['write-spec-closes-in-invariants'])
  })
  it('不變量 PR 關閉的是別的 Issue → 不相干，不擋', () => {
    const r = checkClosingKeywords('invariants', 7, ['Refs #7\nCloses #8'])
    expect(r.mismatches).toEqual([])
  })
  it('不變量 PR 只寫 Refs → 無 mismatch、無 advisory', () => {
    expect(checkClosingKeywords('invariants', 7, ['Refs #7'])).toEqual({ mismatches: [], advisories: [] })
  })
  it('模型 PR 有 Closes #N → 無 advisory', () => {
    expect(checkClosingKeywords('model', 7, ['Closes #7'])).toEqual({ mismatches: [], advisories: [] })
  })
  it('模型 PR 都沒寫 Closes #N → advisory（Issue 會一直開著、在待辦搜尋中誤列）', () => {
    const r = checkClosingKeywords('model', 7, ['Refs #7'])
    expect(r.mismatches).toEqual([])
    expect(r.advisories.map((a) => a.kind)).toEqual(['write-spec-model-no-closes'])
  })
})
