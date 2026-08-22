/**
 * DeepSeek（OpenAI-compatible）chat completion 呼叫。
 *
 * ⚠️ 假設待實作驗證（Q03-2 模式）：端點 / 模型名 / 回應結構以部署時的
 * DeepSeek API 文件為準；apiKey 僅存本機 app-config（docs/ADR/009 安全邊界）。
 */
import type { LoggerService } from '@backstage/backend-plugin-api'

export interface CallDeepSeekOptions {
  apiKey: string
  baseUrl: string
  model: string
  system: string
  logger: LoggerService
}

/** LLM 呼叫逾時（毫秒）：DeepSeek 正常約 19 秒，長 prompt 最壞可達 60 秒+。 */
export const LLM_TIMEOUT_MS = 90_000

/**
 * 完成 token 預算。deepseek-v4-flash 是 reasoning 模型——預算由思考
 * （reasoning_content）與最終內容共用；2000 在複雜輸入下會被思考吃光 →
 * content 空白 + finish_reason=length（2026-08-22 實測）。
 * 8000 對草稿 JSON（實測 usage 約 2900）餘裕充足。
 */
export const LLM_MAX_TOKENS = 8000

export async function callDeepSeek(options: CallDeepSeekOptions): Promise<string> {
  const { apiKey, baseUrl, model, system, logger } = options
  // AbortController：卡住的連線必須在時限內以明確錯誤結束（2026-08-22 實測：
  // 無 timeout 時 DeepSeek 卡住會讓請求無限掛起）
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: system }],
        temperature: 0.2,
        max_tokens: LLM_MAX_TOKENS,
      }),
      signal: controller.signal,
    })
  } catch (e) {
    const aborted = controller.signal.aborted
    logger.error(`factory-draft LLM call ${aborted ? 'timed out' : 'failed'}: ${(e as Error).message}`)
    throw new Error(aborted ? `LLM 回應逾時（${LLM_TIMEOUT_MS / 1000} 秒）` : `LLM call failed: ${(e as Error).message}`)
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    logger.error(`factory-draft LLM call failed: ${res.status} ${body.slice(0, 300)}`)
    throw new Error(`LLM call failed: ${res.status}`)
  }
  const json = (await res.json()) as {
    choices?: Array<{
      message?: { content?: string; reasoning_content?: string }
      finish_reason?: string
    }>
  }
  const choice = json.choices?.[0]
  const content = choice?.message?.content
  if (typeof content !== 'string' || content.length === 0) {
    // 記錄原始回應摘要供診斷（2026-08-22：DeepSeek 偶發空回應；
    // reasoning 模型在 max_tokens 內被思考吃光時 content 為空）
    const reasoningLen = choice?.message?.reasoning_content?.length ?? 0
    logger.error(
      `factory-draft LLM response missing content: finish_reason=${choice?.finish_reason ?? 'n/a'} ` +
        `reasoning_len=${reasoningLen} raw=${JSON.stringify(json).slice(0, 300)}`,
    )
    throw new Error(
      `LLM response empty (finish_reason=${choice?.finish_reason ?? 'n/a'}, ` +
        `reasoning_len=${reasoningLen})`,
    )
  }
  return content
}
