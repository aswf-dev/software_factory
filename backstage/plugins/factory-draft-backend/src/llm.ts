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

export async function callDeepSeek(options: CallDeepSeekOptions): Promise<string> {
  const { apiKey, baseUrl, model, system, logger } = options
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }],
      temperature: 0.2,
      max_tokens: 2000,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    logger.error(`factory-draft LLM call failed: ${res.status} ${body.slice(0, 300)}`)
    throw new Error(`LLM call failed: ${res.status}`)
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const content = json.choices?.[0]?.message?.content
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error('LLM response missing content')
  }
  return content
}
