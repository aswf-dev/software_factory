import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { GitRunner } from './factory-crosscheck.js'
import { main, parseArgs } from './factory-pbt-audit-comment.js'
import { CliError } from './run-cli.js'

let tmp: string
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pbt-comment-'))
})
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const BASE = ['--issue', '12', '--target', 't', '--base', 'software-factory', '--run-id', '42']

/** 兩個分支：01 只有 A，02 有 A（更新後）與 B；另有一個 Go 檔與一個非 PBT 檔。 */
const git: GitRunner = (args) => {
  if (args[0] === 'for-each-ref') return 'factory/12-01-a\nfactory/12-02-b\n'
  if (args[0] === 'diff' && args[1] === '--name-only') {
    return 'test/A.pbt.test.ts\ntest/B.pbt.test.ts\npkg/x_pbt_test.go\nsrc/helper.ts\n.factory/run/report.json\ntest/Gone.pbt.test.ts\n'
  }
  if (args[0] === 'diff') return ''
  if (args[0] === 'status') return ''
  if (args[0] === 'show') {
    const files: Record<string, string> = {
      'factory/12-02-b:test/A.pbt.test.ts': "test('a', () => hegel.test(f))\ntest('a2', () => hegel.testAsync(g))",
      'factory/12-01-a:test/A.pbt.test.ts': "test('a', () => hegel.test(f))",
      'factory/12-02-b:test/B.pbt.test.ts': "test('b', () => hegel.test(f))",
      'factory/12-02-b:pkg/x_pbt_test.go': 'func TestX(t *testing.T) {}',
    }
    const c = files[args[1] as string]
    if (c === undefined) throw new Error('fatal: path does not exist')
    return c
  }
  throw new Error(`unexpected git ${args.join(' ')}`)
}

function report(name: string, content: unknown): string {
  const p = join(tmp, name)
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content))
  return p
}

describe('parseArgs', () => {
  it('必填、未知參數、缺值、issue 非正整數', () => {
    expect(() => parseArgs(['--issue', '1'])).toThrow(/--report is required/)
    expect(() => parseArgs(['--bogus', 'x'])).toThrow(/unknown argument/)
    expect(() => parseArgs(['--issue'])).toThrow(/requires a value/)
    expect(() => parseArgs([...BASE, '--report', 'r', '--issue', '0'])).toThrow(CliError)
  })
  it('時間戳記：空字串、非數字、非正數 → 量不到', () => {
    for (const bad of ['', 'abc', '-5']) {
      expect(parseArgs([...BASE, '--report', 'r', '--agent-start', bad]).agentStart).toBeUndefined()
    }
    expect(parseArgs([...BASE, '--report', 'r', '--agent-start', '100']).agentStart).toBe(100)
  })
})

describe('main', () => {
  it('實測：只列 PBT 檔、排除 .factory/；property 數取最上層分支；Go 與讀不到的檔未計數', () => {
    const out = main([...BASE, '--report', report('r1.json', { pbtAudit: { findings: [] } }), '--agent-start', '1000', '--agent-end', '1090'], git)
    expect(out.pbtFiles).toEqual(['test/A.pbt.test.ts', 'test/B.pbt.test.ts', 'pkg/x_pbt_test.go', 'test/Gone.pbt.test.ts'])
    expect(out.comment).toContain('（run: 42）')
    expect(out.comment).toContain('agent 牆鐘：1 分 30 秒')
    expect(out.comment).toContain('`test/A.pbt.test.ts`：2 個 property')
    expect(out.comment).toContain('`test/B.pbt.test.ts`：1 個 property')
    expect(out.comment).toContain('`pkg/x_pbt_test.go`：未計數')
    expect(out.comment).toContain('`test/Gone.pbt.test.ts`：未計數')
    expect(out.comment).toContain('候選發現（未回放）：0 條')
  })
  it('report.json 不存在、壞掉或不是物件 → 照樣產生留言，自報段落寫明缺席', () => {
    for (const p of [join(tmp, 'missing.json'), report('bad.json', '{'), report('arr.json', '[1]'), report('null.json', 'null')]) {
      expect(main([...BASE, '--report', p], git).comment).toContain('沒有 `pbtAudit` 欄位')
    }
  })
  it('結束早於開始 → 牆鐘量不到', () => {
    const out = main([...BASE, '--report', join(tmp, 'missing.json'), '--agent-start', '200', '--agent-end', '100'], git)
    expect(out.comment).toContain('agent 牆鐘：量不到')
  })
})
