import { describe, expect, it } from 'vitest'
import { checkPbtAuditScope, checkPbtOutsideAudit } from './scope.js'

describe('checkPbtAuditScope', () => {
  it('只新增 PBT 檔 → 無 finding', () => {
    expect(checkPbtAuditScope(['test/jest/Tick.pbt.test.ts', 'test/jest/Spb.pbt.test.ts'], [])).toEqual([])
  })
  it('碰產品程式碼、設定或依賴 → pbt-audit-scope', () => {
    const f = checkPbtAuditScope(['test/jest/Tick.pbt.test.ts', 'src/Tick.ts', 'package.json'], [])
    expect(f).toHaveLength(1)
    expect(f[0]?.kind).toBe('pbt-audit-scope')
    expect(f[0]?.detail).toContain('src/Tick.ts、package.json')
  })
  it('刪除任何檔案（即使是 PBT 檔）→ pbt-audit-deletion，且刪除的路徑不重複報成越界', () => {
    const f = checkPbtAuditScope(['test/a.pbt.test.ts', 'test/old.test.ts'], ['test/a.pbt.test.ts', 'test/old.test.ts'])
    expect(f.map((x) => x.kind)).toEqual(['pbt-audit-deletion'])
    expect(f[0]?.detail).toContain('test/old.test.ts')
  })
  it('既有範例測試被修改（非刪除）→ 越界', () => {
    expect(checkPbtAuditScope(['test/jest/Tick.test.ts'], [])[0]?.kind).toBe('pbt-audit-scope')
  })
})

describe('checkPbtOutsideAudit', () => {
  it('沒有 PBT 檔 → 無 finding', () => {
    expect(checkPbtOutsideAudit(['src/a.ts', 'test/a.test.ts'])).toEqual([])
  })
  it('非 audit 類型產出 PBT 檔 → pbt-outside-audit', () => {
    const f = checkPbtOutsideAudit(['src/a.ts', 'pkg/a_pbt_test.go'])
    expect(f).toEqual([expect.objectContaining({ kind: 'pbt-outside-audit' })])
    expect(f[0]?.detail).toContain('pkg/a_pbt_test.go')
  })
  it('說明指出合法做法：改寫成範例測試，property 於修正合併後另開 agent-pbt-audit 加回', () => {
    const detail = checkPbtOutsideAudit(['test/a.pbt.test.ts'])[0]?.detail ?? ''
    expect(detail).toContain('範例測試')
    expect(detail).toContain('另開 `agent-pbt-audit`')
    expect(detail).toContain('docs/30 §7')
  })
})
