/**
 * factory-draft 後端路由（Express）：/clarify 與 /generate 兩個端點。
 *
 * ⚠️ 假設待實作驗證（Q03-2 模式）：@backstage API 簽章、express 版本、
 * config 讀取方式以部署時鎖定的版本為準。
 *
 * 純邏輯來自 repo 的 src/factory-draft/（prompts / parse）。相對路徑
 * ../../../../src 在「插件隨 repo 一起被外部 Backstage app 引用」的前提下成立
 * （見 backstage/plugins/README.md 的 wiring 說明）。
 */
import type { LoggerService } from '@backstage/backend-plugin-api'
import type { Config } from '@backstage/config'
import express from 'express'
import {
  buildClarifyPrompt,
  buildGeneratePrompt,
  CLARIFY_MAX_ROUNDS,
  type ClarifyQa,
} from '../../../../src/factory-draft/prompts.ts'
import { parseDraftJson } from '../../../../src/factory-draft/parse.ts'
import { callDeepSeek } from './llm.ts'

export interface RouterOptions {
  config: Config
  logger: LoggerService
}

export async function createRouter(options: RouterOptions): Promise<express.Router> {
  const { config, logger } = options
  const apiKey = config.getOptionalString('factoryDraft.apiKey')
  const baseUrl = config.getOptionalString('factoryDraft.baseUrl') ?? 'https://api.deepseek.com'
  const model = config.getOptionalString('factoryDraft.model') ?? 'deepseek-v4-flash'

  const router = express.Router()
  router.use(express.json())

  /** POST /clarify：grill-me 收斂版，回傳一輪 frontier 問題。 */
  router.post('/clarify', async (req, res) => {
    const requirement: unknown = req.body?.requirement
    const round: unknown = req.body?.round
    const history: unknown = req.body?.history
    if (typeof requirement !== 'string' || requirement.trim().length === 0) {
      res.status(400).json({ error: 'requirement 為必填字串' })
      return
    }
    if (typeof round !== 'number' || round < 1 || round > CLARIFY_MAX_ROUNDS) {
      res.status(400).json({ error: `round 必須在 1..${CLARIFY_MAX_ROUNDS}` })
      return
    }
    if (!apiKey) {
      res.status(503).json({ error: 'factoryDraft.apiKey 未設定（app-config，本機）' })
      return
    }
    const qa: ClarifyQa[] = Array.isArray(history) ? (history as ClarifyQa[]) : []
    const prompt = buildClarifyPrompt({ requirement, round, history: qa })
    const text = await callDeepSeek({ apiKey, baseUrl, model, system: prompt, logger })
    res.json({ questions: text, round, maxRounds: CLARIFY_MAX_ROUNDS })
  })

  /** POST /generate：一次生成全部欄位（結構化 JSON + 品質標示）。 */
  router.post('/generate', async (req, res) => {
    // debug：診斷 400（2026-08-21）——確認 body 是否到達
    logger.info(`factory-draft generate body: ${JSON.stringify(req.body).slice(0, 200)}`)
    const requirement: unknown = req.body?.requirement
    const history: unknown = req.body?.history
    if (typeof requirement !== 'string' || requirement.trim().length === 0) {
      res.status(400).json({ error: 'requirement 為必填字串' })
      return
    }
    if (!apiKey) {
      res.status(503).json({ error: 'factoryDraft.apiKey 未設定（app-config，本機）' })
      return
    }
    const qa: ClarifyQa[] = Array.isArray(history) ? (history as ClarifyQa[]) : []
    const prompt = buildGeneratePrompt({ requirement, history: qa })
    const text = await callDeepSeek({ apiKey, baseUrl, model, system: prompt, logger })
    const draft = parseDraftJson(text)
    if (!draft) {
      logger.warn(`factory-draft generate: LLM 輸出無法解析為草稿 JSON: ${text.slice(0, 200)}`)
      res.status(502).json({ error: 'LLM 輸出無法解析，請重試' })
      return
    }
    res.json(draft)
  })

  return router
}
