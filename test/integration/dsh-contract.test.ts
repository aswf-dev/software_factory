/**
 * Integration tests for the DSH contract (docs/11 §4.2).
 *
 * These test OUR assumptions about DSH, not DSH itself. The fixtures below are
 * the actual observed behaviour from the live verification on 2026-08-16
 * (docs/04 §2.4), so if a future DSH release changes the contract, these fail.
 */

import { describe, expect, it } from 'vitest'
import { interpretDshResult } from '../../src/integration/dsh-result.js'

describe('exit code 判讀（docs/04 §4.2、ADR-002）', () => {
  it('exit 0 → completed，續行後續步驟', () => {
    const r = interpretDshResult({ exitCode: 0, stdout: 'hello factory\n', stderr: '' })
    expect(r.outcome).toBe('completed')
    expect(r.output).toBe('hello factory')
    expect(r.shouldContinue).toBe(true)
    expect(r.errorDetail).toBe('')
  })

  it('exit 1 → failed，附上 stderr，不續行', () => {
    // Verbatim stderr from the real empty-task run (docs/04 §2.4 test 2).
    const stderr = 'error: a task is required, for example: dsh --profile headless "run the tests"'
    const r = interpretDshResult({ exitCode: 1, stdout: '', stderr })
    expect(r.outcome).toBe('failed')
    expect(r.shouldContinue).toBe(false)
    expect(r.errorDetail).toBe(stderr)
  })

  it('exit 1 但 stderr 為空 → 仍須提供可讀訊息', () => {
    const r = interpretDshResult({ exitCode: 1, stdout: '', stderr: '' })
    expect(r.outcome).toBe('failed')
    expect(r.errorDetail).toContain('exit code 1')
    expect(r.errorDetail).not.toBe('')
  })

  it('無 exit code（程序被殺）→ 視同失敗', () => {
    const r = interpretDshResult({ stdout: '' })
    expect(r.outcome).toBe('failed')
    expect(r.shouldContinue).toBe(false)
  })

  it('逾時優先於 exit code 判定', () => {
    // A killed process can report a misleading code, so timeout wins.
    const r = interpretDshResult({ exitCode: 0, timedOut: true, stdout: 'partial' })
    expect(r.outcome).toBe('timeout')
    expect(r.shouldContinue).toBe(false)
  })

  it('其他非零 exit code 一律視為失敗', () => {
    expect(interpretDshResult({ exitCode: 127 }).outcome).toBe('failed')
    expect(interpretDshResult({ exitCode: 2 }).outcome).toBe('failed')
  })
})

describe('關鍵不變量：exit 0 ≠ 任務正確完成（docs/04 §4.2）', () => {
  // The contract's most misread point: a normal turn end says nothing about
  // whether the work is right. Correctness comes from checks and review (D4).
  it('completed 時 taskVerified 仍為 false', () => {
    const r = interpretDshResult({ exitCode: 0, stdout: 'DONE' })
    expect(r.outcome).toBe('completed')
    expect(r.taskVerified).toBe(false)
  })

  it('任何結果的 taskVerified 都是 false', () => {
    for (const inv of [{ exitCode: 0 }, { exitCode: 1 }, { timedOut: true }]) {
      expect(interpretDshResult(inv).taskVerified).toBe(false)
    }
  })
})

describe('輸出處理', () => {
  it('stdout 前後空白會被去除', () => {
    expect(interpretDshResult({ exitCode: 0, stdout: '  DONE  \n\n' }).output).toBe('DONE')
  })

  it('失敗時仍保留已產生的 stdout 供人類參考', () => {
    const r = interpretDshResult({ exitCode: 1, stdout: 'partial work', stderr: 'boom' })
    expect(r.output).toBe('partial work')
    expect(r.errorDetail).toBe('boom')
  })

  it('未提供 stdout/stderr 不會拋錯', () => {
    expect(() => interpretDshResult({ exitCode: 0 })).not.toThrow()
    expect(interpretDshResult({ exitCode: 0 }).output).toBe('')
  })
})

describe('逾時與 exit code 優先權的邊界（mutation 驗證）', () => {
  it('逾時且無 stderr 時 errorDetail 用預設訊息，並保留 stdout', () => {
    const r = interpretDshResult({ timedOut: true, stdout: 'partial work' })
    expect(r.outcome).toBe('timeout')
    expect(r.output).toBe('partial work')
    expect(r.shouldContinue).toBe(false)
    expect(r.errorDetail).toBe('執行超過時間上限，已中止')
  })

  it('逾時優先於非零 exit code（被殺的程序可能帶誤導碼）', () => {
    const r = interpretDshResult({ exitCode: 127, timedOut: true })
    expect(r.outcome).toBe('timeout')
    expect(r.shouldContinue).toBe(false)
    expect(r.taskVerified).toBe(false)
  })

  it('exit 0 即使帶 stderr 仍為 completed（成功時忽略 stderr）', () => {
    const r = interpretDshResult({ exitCode: 0, stdout: 'done', stderr: 'noise' })
    expect(r.outcome).toBe('completed')
    expect(r.errorDetail).toBe('')
    expect(r.shouldContinue).toBe(true)
  })
})
