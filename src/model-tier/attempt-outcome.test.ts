/**
 * classifyFailedAttempt：一次 DSH 嘗試以非 0（且非逾時）結束時，決定要不要沿
 * chain 換下一個模型（docs/ADR/011；factory-run.yml 的 agent 步驟）。
 *
 * 回歸背景（run 36838600120，fubon-tradingbot#625）：Opus 5.5 被 Anthropic 的
 * cyber 分類器拒答（stop_reason=refusal），DSH 印出
 * `dsh: PI_AI_ERROR: This request was declined because it could enable cyber harm.`。
 * 舊的 workflow 判斷有兩個錯：
 *   1. 拒答關鍵字只認 `Usage Policy|refused to complete the request`，漏掉
 *      `stop_details.explanation` 的新措辭（Anthropic 文件明言該文字不穩定）。
 *   2. provider 錯誤用 `grep -qiE "...|AUTH|..."` 掃整份 stderr，而 stderr 含
 *      agent 的 reasoning 串流——一句「no auth logic touched」就被當成憑證錯誤。
 * 結果：拒答被誤標成 provider-error（若 reasoning 沒提到 auth，則會誤標成
 * agent-error 而直接交還人類）。
 *
 * 下列 stderr 樣本取自真實 DSH 0.2.0-rc.2 headless 對假 Anthropic API 的輸出。
 */
import { describe, expect, it } from 'vitest'
import { classifyFailedAttempt, terminalDshError } from './attempt-outcome.js'

const REASONING_WITH_AUTH = [
  'dsh: reasoning:',
  "Since `gh pr checks` failed due to permissions, I'll check the workflow runs API.",
  'Double-check: no auth/payment/sensitive-data logic touched; HTTP 401 and 429 never seen.',
  '',
].join('\n')

const CYBER_REFUSAL = `${REASONING_WITH_AUTH}dsh: PI_AI_ERROR: This request was declined because it could enable cyber harm.\n`

describe('terminalDshError', () => {
  it('取最後一行 `dsh: <CODE>: <message>`，忽略 reasoning 標頭', () => {
    expect(terminalDshError(CYBER_REFUSAL)).toEqual({
      code: 'PI_AI_ERROR',
      message: 'This request was declined because it could enable cyber harm.',
      line: 'dsh: PI_AI_ERROR: This request was declined because it could enable cyber harm.',
    })
  })
  it('只有 reasoning、沒有錯誤行 → undefined', () => {
    expect(terminalDshError(REASONING_WITH_AUTH)).toBeUndefined()
  })
  it('reasoning 內文即使以 `dsh: ` 開頭的樣子出現在行中，也不算錯誤行', () => {
    expect(terminalDshError('dsh: reasoning:\nI saw "dsh: RATE_LIMIT: x" in a log\n')).toBeUndefined()
  })
  it('沒有代碼的啟動失敗（fail() 的 `dsh: <message>`）以 code=undefined 回報', () => {
    expect(terminalDshError('dsh: a task is required, for example: dsh --profile headless "run the tests"\n')).toEqual({
      code: undefined,
      message: 'a task is required, for example: dsh --profile headless "run the tests"',
      line: 'dsh: a task is required, for example: dsh --profile headless "run the tests"',
    })
  })
})

describe('classifyFailedAttempt', () => {
  it('回歸：critical 的 cyber 拒答（新措辭）→ model-refusal，不是 provider-error', () => {
    expect(classifyFailedAttempt({ stderr: CYBER_REFUSAL, tier: 'critical' })).toMatchObject({
      outcome: 'model-refusal',
      fallback: true,
      code: 'PI_AI_ERROR',
    })
  })
  it('critical 的舊措辭（Usage Policy／pi-ai 預設訊息）仍是 model-refusal', () => {
    const usagePolicy =
      "dsh: PI_AI_ERROR: This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy.\n"
    const piAiDefault = 'dsh: PI_AI_ERROR: The model refused to complete the request\n'
    expect(classifyFailedAttempt({ stderr: usagePolicy, tier: 'critical' }).outcome).toBe('model-refusal')
    expect(classifyFailedAttempt({ stderr: piAiDefault, tier: 'critical' }).outcome).toBe('model-refusal')
  })
  it('非 critical 的拒答維持任務層失敗（交還人類），不換模型', () => {
    expect(classifyFailedAttempt({ stderr: CYBER_REFUSAL, tier: 'high' })).toMatchObject({
      outcome: 'agent-error',
      fallback: false,
    })
  })
  it('回歸：reasoning 提到 auth/401/429，但錯誤行是任務層錯誤 → agent-error', () => {
    const stderr = `${REASONING_WITH_AUTH}dsh: EMPTY_RESPONSE: model "claude-opus-5-5" returned a completed response with no content\n`
    expect(classifyFailedAttempt({ stderr, tier: 'critical' })).toMatchObject({ outcome: 'agent-error', fallback: false })
  })
  it('回歸：只有 reasoning（提到 auth）、沒有錯誤行 → agent-error', () => {
    expect(classifyFailedAttempt({ stderr: REASONING_WITH_AUTH, tier: 'critical' }).outcome).toBe('agent-error')
  })
  it.each([
    ['RATE_LIMIT', 'dsh: RATE_LIMIT: 429 {"type":"error","error":{"type":"rate_limit_error"}}'],
    ['MISSING_CREDENTIAL', 'dsh: MISSING_CREDENTIAL: llm-pi-ai: no credential for provider route "qwen"'],
    ['UNKNOWN_MODEL', 'dsh: UNKNOWN_MODEL: pi-ai provider "anthropic" has no configured model "claude-opus-5-5"'],
    ['AUTH', 'dsh: AUTH: 401 invalid x-api-key'],
    ['INVALID_CREDENTIAL', "dsh: INVALID_CREDENTIAL: this provider's API key is blank"],
  ])('provider 層錯誤代碼 %s → provider-error（任何 tier）', (_code, line) => {
    for (const tier of ['low', 'high', 'critical']) {
      expect(classifyFailedAttempt({ stderr: `${REASONING_WITH_AUTH}${line}\n`, tier })).toMatchObject({
        outcome: 'provider-error',
        fallback: true,
      })
    }
  })
  it('錯誤訊息本身含 401／429／invalid_api_key（代碼被歸成 PI_AI_ERROR）→ provider-error', () => {
    const stderr = 'dsh: PI_AI_ERROR: Incorrect API key provided (invalid_api_key)\n'
    expect(classifyFailedAttempt({ stderr, tier: 'low' }).outcome).toBe('provider-error')
  })
  it('回傳錯誤行原文，供 workflow 印到 log（證據不再被下一次嘗試覆蓋）', () => {
    expect(classifyFailedAttempt({ stderr: CYBER_REFUSAL, tier: 'critical' }).errorLine).toBe(
      'dsh: PI_AI_ERROR: This request was declined because it could enable cyber harm.',
    )
    expect(classifyFailedAttempt({ stderr: REASONING_WITH_AUTH, tier: 'critical' }).errorLine).toBeUndefined()
  })
})
