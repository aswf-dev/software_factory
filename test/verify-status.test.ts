/**
 * 驗證模式的無內容狀態留言（ADR-029 §5；controller ruling R6）。
 *
 * 驗證類的 Issue 在使用者的 repo，可能是公開的；Issue body／留言只能寫範圍與
 * 階段，**不得寫任何發現**。factory-run 在驗證模式下所有會貼到 Issue 的留言
 * （crosscheck 中止、agent 逾時／失敗、Issue 格式不合規）都改由這支 CLI 產生：
 * 階段名稱＋結果字＋run URL，沒有其他東西。
 *
 * 「沒有其他東西」靠的是輸入面只收列舉值與固定形狀的 URL——任何一個欄位能
 * 帶自由文字，就能把路徑、usage 或 agent 輸出帶進公開留言。故本檔同時釘住
 * 正向（輸出逐字固定）與負向（自由文字一律拒絕）。
 */
import { describe, expect, it } from 'vitest'
import {
  main,
  parseArgs,
  renderVerifyStatus,
  VERIFY_STATUS_OUTCOMES,
} from '../src/cli/factory-verify-status.js'
import { VERIFY_TASK_TYPES } from '../src/pipeline/verify-task-types.js'
import { CliError } from '../src/cli/run-cli.js'

const RUN_URL = 'https://github.com/aswf-dev/software_factory/actions/runs/424242'

describe('renderVerifyStatus：只有階段、結果字與 run URL', () => {
  it('結果字固定為 ok／needs-human／timeout', () => {
    expect(VERIFY_STATUS_OUTCOMES).toEqual(['ok', 'needs-human', 'timeout'])
  })

  it('非 lean 階段：一行，逐字固定', () => {
    expect(renderVerifyStatus({ stage: 'agent-verify-quint', outcome: 'needs-human', runUrl: RUN_URL })).toBe(
      `驗證階段 agent-verify-quint：needs-human — ${RUN_URL}`,
    )
  })

  it('lean 階段帶 phase（statements／proofs 是兩個獨立階段，ADR-029 §2）', () => {
    expect(
      renderVerifyStatus({ stage: 'agent-verify-lean', phase: 'proofs', outcome: 'timeout', runUrl: RUN_URL }),
    ).toBe(`驗證階段 agent-verify-lean（proofs）：timeout — ${RUN_URL}`)
  })

  it('非 lean 階段即使傳了 phase 也不顯示（phase 只對 lean 有意義）', () => {
    expect(
      renderVerifyStatus({ stage: 'agent-verify-grill', phase: 'statements', outcome: 'ok', runUrl: RUN_URL }),
    ).toBe(`驗證階段 agent-verify-grill：ok — ${RUN_URL}`)
  })

  it('四個階段 × 三個結果字：輸出都只由列舉值與 URL 組成', () => {
    for (const stage of VERIFY_TASK_TYPES) {
      for (const outcome of VERIFY_STATUS_OUTCOMES) {
        const text = renderVerifyStatus({ stage, phase: 'statements', outcome, runUrl: RUN_URL })
        const stripped = text
          .replace(RUN_URL, '')
          .replace(stage, '')
          .replace(outcome, '')
          .replace('（statements）', '')
        expect(stripped).toBe('驗證階段 ： — ')
      }
    }
  })
})

describe('parseArgs：只收列舉值與固定形狀的 run URL', () => {
  const ok = ['--stage', 'agent-verify-lean', '--phase', 'statements', '--outcome', 'ok', '--run-url', RUN_URL]

  it('合法輸入', () => {
    expect(parseArgs(ok)).toEqual({ stage: 'agent-verify-lean', phase: 'statements', outcome: 'ok', runUrl: RUN_URL })
  })

  it('--phase 選填', () => {
    expect(parseArgs(['--stage', 'agent-verify-tests', '--outcome', 'needs-human', '--run-url', RUN_URL])).toEqual({
      stage: 'agent-verify-tests',
      outcome: 'needs-human',
      runUrl: RUN_URL,
    })
  })

  it('非驗證類 stage 拒絕（一般類型的留言不走這裡）', () => {
    expect(() => parseArgs(['--stage', 'agent-fix-bug', '--outcome', 'ok', '--run-url', RUN_URL])).toThrow(CliError)
  })

  it('結果字以外的 outcome 拒絕（例如把 headline 或路徑塞進來）', () => {
    for (const outcome of ['failed', 'needs-human: src/payments/ledger.ts', '']) {
      expect(() => parseArgs(['--stage', 'agent-verify-quint', '--outcome', outcome, '--run-url', RUN_URL])).toThrow(
        CliError,
      )
    }
  })

  it('phase 只收 statements／proofs', () => {
    expect(() =>
      parseArgs(['--stage', 'agent-verify-lean', '--phase', 'proofs of Ledger.balance', '--outcome', 'ok', '--run-url', RUN_URL]),
    ).toThrow(CliError)
  })

  it('run URL 必須是 https://<host>/<owner>/<repo>/actions/runs/<id>，不得多帶任何字', () => {
    const bad = [
      'http://github.com/aswf-dev/software_factory/actions/runs/1',
      `${RUN_URL}?finding=overflow`,
      `${RUN_URL}#src/payments`,
      `${RUN_URL} src/payments/ledger.ts`,
      `${RUN_URL}\nusage`,
      'https://github.com/aswf-dev/software_factory/issues/1',
      'https://github.com/aswf-dev/software_factory/actions/runs/abc',
    ]
    for (const url of bad) {
      expect(() => parseArgs(['--stage', 'agent-verify-quint', '--outcome', 'ok', '--run-url', url]), url).toThrow(
        CliError,
      )
    }
  })

  it('缺必要旗標、未知旗標、缺值都 fail-loud', () => {
    expect(() => parseArgs(['--outcome', 'ok', '--run-url', RUN_URL])).toThrow('--stage is required')
    expect(() => parseArgs(['--stage', 'agent-verify-quint', '--run-url', RUN_URL])).toThrow('--outcome is required')
    expect(() => parseArgs(['--stage', 'agent-verify-quint', '--outcome', 'ok'])).toThrow('--run-url is required')
    expect(() => parseArgs([...ok, '--body', 'x'])).toThrow('unknown argument: --body')
    expect(() => parseArgs(['--stage'])).toThrow('--stage requires a value')
  })
})

describe('main：輸出 {comment}（workflow 以 jq -r .comment 取出）', () => {
  it('comment 即 renderVerifyStatus 的結果', () => {
    expect(main(['--stage', 'agent-verify-quint', '--outcome', 'needs-human', '--run-url', RUN_URL])).toEqual({
      comment: `驗證階段 agent-verify-quint：needs-human — ${RUN_URL}`,
    })
  })
})
