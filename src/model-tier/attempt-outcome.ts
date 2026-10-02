/**
 * 一次 DSH 嘗試失敗（非 0、非逾時）時的分類：決定 factory-run.yml 要不要沿
 * model chain 換下一個模型（docs/ADR/011）。
 *
 * 只看 DSH headless 的**終止錯誤行**（`dsh: <CODE>: <message>`，見
 * @deepseek-ai/dsh-headless 的 run()/fail()），不看整份 stderr：stderr 也承載
 * agent 的 reasoning 串流，任何關鍵字掃描都會被 reasoning 的內容誤觸發
 * （run 36838600120：reasoning 的「no auth logic touched」讓 Opus 5.5 的拒答被
 * 誤判成憑證錯誤）。
 */

export interface DshError {
  /** DSH 錯誤代碼（RATE_LIMIT、PI_AI_ERROR…）；啟動期 fail() 的訊息沒有代碼。 */
  code: string | undefined
  message: string
  /** 原始錯誤行，供 workflow 印到 log。 */
  line: string
}

export type AttemptOutcome = 'model-refusal' | 'provider-error' | 'agent-error'

export interface AttemptClassification {
  outcome: AttemptOutcome
  /** true → 沿 chain 換下一項；false → 任務層失敗，停止並交還人類。 */
  fallback: boolean
  code?: string
  errorLine?: string
}

/** provider 層失敗（金鑰、額度、路由）：換 provider/模型有機會成功。 */
const PROVIDER_CODES = new Set(['RATE_LIMIT', 'MISSING_CREDENTIAL', 'UNKNOWN_MODEL', 'AUTH', 'INVALID_CREDENTIAL'])
/** 代碼被歸成通用錯誤、但訊息仍可辨識為 provider 層失敗的情況。 */
const PROVIDER_MESSAGE = /\b(?:401|429)\b|invalid_api_key/i
/**
 * Anthropic 安全分類器拒答（stop_reason=refusal）經 pi-ai 轉成 PI_AI_ERROR，
 * 訊息是 `stop_details.explanation`（官方明言文字不穩定），缺值時為 pi-ai 預設的
 * 「The model refused to complete the request」。另有請求被前置攔截時的
 * 「...blocked under Anthropic's Usage Policy」。三者都要認得。
 */
const REFUSAL_MESSAGE = /usage policy|refus|declin/i

const ERROR_LINE = /^dsh: (.*)$/
const CODED = /^([A-Z][A-Z0-9_]+): (.*)$/

/** stderr 中最後一行 DSH 終止錯誤；只有 reasoning（或沒有錯誤行）時回傳 undefined。 */
export function terminalDshError(stderr: string): DshError | undefined {
  const lines = stderr.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string
    const match = ERROR_LINE.exec(line)
    if (match === null || line === 'dsh: reasoning:') continue
    const rest = match[1] as string
    const coded = CODED.exec(rest)
    return coded === null
      ? { code: undefined, message: rest, line }
      : { code: coded[1] as string, message: coded[2] as string, line }
  }
  return undefined
}

/**
 * 分類一次失敗的嘗試。拒答改用 chain 下一項只限 critical（2026-09-27 用戶裁決：
 * Opus 5.5 拒答時改用 Opus 5）；其他 tier 的拒答仍是任務層失敗。
 */
export function classifyFailedAttempt(input: { stderr: string; tier: string }): AttemptClassification {
  const error = terminalDshError(input.stderr)
  if (error === undefined) return { outcome: 'agent-error', fallback: false }
  const evidence = { errorLine: error.line, ...(error.code === undefined ? {} : { code: error.code }) }
  if (input.tier === 'critical' && error.code === 'PI_AI_ERROR' && REFUSAL_MESSAGE.test(error.message)) {
    return { outcome: 'model-refusal', fallback: true, ...evidence }
  }
  if ((error.code !== undefined && PROVIDER_CODES.has(error.code)) || PROVIDER_MESSAGE.test(error.message)) {
    return { outcome: 'provider-error', fallback: true, ...evidence }
  }
  return { outcome: 'agent-error', fallback: false, ...evidence }
}
