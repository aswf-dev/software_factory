import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildPreflightComment, main, parseArgs } from './factory-pbt-preflight.js'
import { CliError } from './run-cli.js'

let tmp: string
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pbt-preflight-'))
})
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function target(name: string, files: Record<string, string>): string {
  const root = join(tmp, name)
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true })
    writeFileSync(join(root, p), c)
  }
  return root
}
function issue(name: string, prd: string): string {
  const p = join(tmp, `${name}.json`)
  writeFileSync(p, JSON.stringify({ body: `### 任務類型\n\nagent-pbt-audit\n\n### 需求描述（PRD）\n\n${prd}\n` }))
  return p
}
const READY = {
  'src/Tick.ts': 'export {}',
  'package.json': JSON.stringify({ devDependencies: { '@hegeldev/hegel': '0.4.7' } }),
  '.gitignore': 'node_modules/\n.hegel/\n',
}

describe('parseArgs', () => {
  it('必填與未知參數', () => {
    expect(parseArgs(['--issue-json', 'i.json', '--target-root', 't'])).toEqual({ issueJson: 'i.json', targetRoot: 't' })
    expect(() => parseArgs(['--target-root', 't'])).toThrow(CliError)
    expect(() => parseArgs(['--issue-json', 'i.json'])).toThrow(CliError)
    expect(() => parseArgs(['--issue-json'])).toThrow(/requires a value/)
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument/)
  })
})

describe('main', () => {
  it('前置作業齊全 → ok，留言含稽核目標與 run id', () => {
    const out = main(['--issue-json', issue('ok', '目標模組 / 檔案：src/Tick.ts'), '--target-root', target('ok', READY)], '999')
    expect(out).toMatchObject({ ok: true, target: 'src/Tick.ts', language: 'typescript', smokeOnly: false, errors: [] })
    expect(out.comment).toContain('前置檢查通過**（run: 999）')
  })
  it('缺 Hegel 依賴與 .hegel/ → 不 ok，逐條列出並指向 runbook', () => {
    const root = target('missing', { 'src/Tick.ts': 'export {}', 'package.json': '{}' })
    const out = main(['--issue-json', issue('missing', '目標模組 / 檔案：src/Tick.ts'), '--target-root', root])
    expect(out.ok).toBe(false)
    expect(out.errors).toHaveLength(2)
    expect(out.comment).toContain('agent 未啟動')
    expect(out.comment).toContain('docs/30-pbt-audit-runbook.md')
  })
  it('稽核目標不合格（dispatch 覆寫類型時 issue-check 沒判過）→ 不 ok，不做依賴檢查', () => {
    const out = main(['--issue-json', issue('bad', '目標模組 / 檔案：src/Nope.ts'), '--target-root', target('bad', READY)])
    expect(out.ok).toBe(false)
    expect(out.errors).toEqual([expect.stringContaining('不存在')])
  })
  it('C++ 目標 → smokeOnly，只檢查 .gitignore', () => {
    const root = target('cpp', { 'src/price.cc': '', '.gitignore': '.hegel/\n' })
    const out = main(['--issue-json', issue('cpp', '目標模組 / 檔案：src/price.cc'), '--target-root', root])
    expect(out).toMatchObject({ ok: true, language: 'cpp', smokeOnly: true })
    expect(out.comment).toContain('smoke property 驗證')
  })
  it('issue JSON 壞掉或缺 body → CliError', () => {
    const bad = join(tmp, 'broken.json')
    writeFileSync(bad, '{')
    expect(() => main(['--issue-json', bad, '--target-root', tmp])).toThrow(/非合法 JSON/)
    const nobody = join(tmp, 'nobody.json')
    writeFileSync(nobody, '{"title":"x"}')
    expect(() => main(['--issue-json', nobody, '--target-root', tmp])).toThrow(/缺 body/)
  })
})

describe('buildPreflightComment', () => {
  it('沒有 run id → 不輸出空的 run 標記', () => {
    expect(buildPreflightComment({ ok: true, target: 'a.ts', language: 'typescript', smokeOnly: false, errors: [] })).not.toContain('run:')
  })
})
