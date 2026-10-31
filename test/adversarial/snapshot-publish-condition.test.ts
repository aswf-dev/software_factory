/**
 * 每日流程快照的發佈條件（2026-10-31 事故）。
 *
 * `snapshot-latest` 從 2026-10-22 起就沒更新：publish job 的條件寫成
 * `inputs.publish != false`，本意是「排程沒有 inputs 就照常發佈」，但 GitHub 表示式把 null
 * 與 false 視為相等（都轉成 0），排程觸發時條件恆為 false → 10-23 起每次排程都跳過發佈。
 * 真實系統（saga-pattern、restate-cloudflare-workers-poc）的流程頁因此停在 10-22。
 *
 * 契約：條件必須先看「是不是手動觸發」，而不是直接拿 inputs 與 false 比較。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '../..')

interface Workflow {
  on: Record<string, unknown>
  jobs: Record<string, { needs?: string[]; if?: string }>
}

const workflow = (): Workflow =>
  load(readFileSync(join(ROOT, '.github/workflows/factory-snapshot.yml'), 'utf8')) as Workflow

describe('factory-snapshot 的 publish 條件', () => {
  it('排程觸發時一定會發佈（不能直接拿 inputs.publish 與 false 比較）', () => {
    const condition = workflow().jobs.publish?.if ?? ''
    // 先按觸發方式分流……
    expect(condition).toContain("github.event_name != 'workflow_dispatch'")
    // ……再用手動輸入；而且不能出現 `inputs.publish != false`（null 會被當成 false）。
    expect(condition).toMatch(/inputs\.publish\s*\)/)
    expect(condition).not.toMatch(/inputs\.publish\s*!=\s*false/)
  })

  it('仍然是「discover 成功且未被取消」才發佈', () => {
    const publish = workflow().jobs.publish
    expect(publish?.needs).toContain('discover')
    expect(publish?.if).toContain('!cancelled()')
    expect(publish?.if).toContain("needs.discover.result == 'success'")
  })

  it('排程與手動兩種觸發都還在（修條件不能把 cron 拿掉）', () => {
    const on = workflow().on
    expect(Object.keys(on)).toEqual(expect.arrayContaining(['workflow_dispatch', 'schedule']))
    const schedule = on.schedule as Array<{ cron: string }>
    expect(schedule[0]?.cron).toBe('0 0 * * *')
  })

  it('手動輸入 publish 是布林值且預設發佈（不是字串，避免型別比較陷阱）', () => {
    const dispatch = (workflow().on.workflow_dispatch ?? {}) as {
      inputs?: Record<string, { type?: string; default?: unknown }>
    }
    expect(dispatch.inputs?.publish?.type).toBe('boolean')
    expect(dispatch.inputs?.publish?.default).toBe(true)
  })
})
