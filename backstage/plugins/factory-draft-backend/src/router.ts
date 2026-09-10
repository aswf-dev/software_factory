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
  const model = config.getOptionalString('factoryDraft.model') ?? 'deepseek-v4.1-flash'

  const router = express.Router()
  router.use(express.json())

  /**
   * Express 4 不會自動捕獲 async handler 的 rejection——handler 丟錯時 response
   * 永不送出，前端會無限轉圈（2026-08-22 實測：DeepSeek 偶發空回應 →
   * unhandledRejection → 無回應）。所有端點一律包 try/catch，任何失敗都回 500。
   */
  const handle = (fn: (req: express.Request, res: express.Response) => Promise<void>) => {
    return (req: express.Request, res: express.Response) => {
      fn(req, res).catch((e) => {
        logger.error(`factory-draft ${req.path} failed: ${(e as Error).message}`)
        res.status(500).json({ error: (e as Error).message ?? 'internal error' })
      })
    }
  }

  /** POST /clarify：grill-me 收斂版，回傳一輪 frontier 問題。 */
  router.post('/clarify', handle(async (req, res) => {
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
  }))

  /** POST /generate：一次生成全部欄位（結構化 JSON + 品質標示）。 */
  router.post('/generate', handle(async (req, res) => {
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
  }))

  return router
}
