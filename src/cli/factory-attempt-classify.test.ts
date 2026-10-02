/**
 * factory-attempt-classify：factory-run.yml 對失敗嘗試的分類入口（docs/ADR/011）。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { main, parseArgs } from './factory-attempt-classify.js'

function stderrFile(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'attempt-classify-')), 'stderr.txt')
  writeFileSync(path, content)
  return path
}

describe('main', () => {
  it('讀 stderr 檔並回傳分類（含錯誤行原文）', () => {
    const path = stderrFile(
      'dsh: reasoning:\nno auth logic touched\ndsh: PI_AI_ERROR: This request was declined because it could enable cyber harm.\n',
    )
    expect(main(['--stderr', path, '--tier', 'critical'])).toEqual({
      outcome: 'model-refusal',
      fallback: true,
      code: 'PI_AI_ERROR',
      errorLine: 'dsh: PI_AI_ERROR: This request was declined because it could enable cyber harm.',
    })
  })
  it('stderr 檔不存在 → 丟出錯誤（fail-loud，不默默當成成功）', () => {
    expect(() => main(['--stderr', '/nonexistent/stderr.txt', '--tier', 'critical'])).toThrow()
  })
})

describe('parseArgs', () => {
  it('--stderr 與 --tier 皆必填', () => {
    expect(() => parseArgs(['--tier', 'critical'])).toThrow('--stderr is required')
    expect(() => parseArgs(['--stderr', 'x'])).toThrow('--tier is required')
  })
  it('未知參數 → 錯誤', () => {
    expect(() => parseArgs(['--stderr', 'x', '--tier', 'low', '--bogus', 'y'])).toThrow('unknown argument: --bogus')
  })
  it('旗標缺值 → 錯誤', () => {
    expect(() => parseArgs(['--stderr', '--tier', 'low'])).toThrow('--stderr requires a value')
  })
})
