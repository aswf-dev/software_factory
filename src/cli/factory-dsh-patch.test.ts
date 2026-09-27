/**
 * factory-dsh-patch：模型路由 → DSH 0.1.7 Cordis patch（docs/ADR/011）。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { main, parseArgs } from './factory-dsh-patch.js'
import { buildModelPatch } from '../model-tier/dsh-patch.js'

const PROVIDERS = [
  'llm-pi-ai:',
  '  providers:',
  '    anthropic:',
  '      apiKeyEnv: ANTHROPIC_API_KEY',
  '    qwen:',
  '      apiKeyEnv: QWEN_API_KEY',
  '      api: openai-completions',
  '      models:',
  '        - id: qwen3.8-flash',
  '',
].join('\n')

function setup(): { dir: string; providers: string; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-patch-'))
  const providers = join(dir, 'providers.yaml')
  writeFileSync(providers, PROVIDERS)
  return { dir, providers, out: join(dir, 'model.patch.yml') }
}

describe('buildModelPatch', () => {
  it('覆寫 agent-default-model 與 llm-pi-ai 兩個 entry（id 覆寫整段取代 config）', () => {
    const piAi = { providers: { anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' } } }
    expect(buildModelPatch(piAi, { provider: 'anthropic', model: 'claude-opus-5', reasoningEffort: 'max' })).toEqual([
      { id: 'agent-default-model', config: { provider: 'anthropic', model: 'claude-opus-5', reasoningEffort: 'max' } },
      { id: 'llm-pi-ai', config: piAi },
    ])
  })
  it('沒有 reasoningEffort 時不寫該欄位', () => {
    const rows = buildModelPatch({ providers: {} }, { provider: 'qwen', model: 'qwen3.8-flash' })
    expect(rows[0]!.config).toEqual({ provider: 'qwen', model: 'qwen3.8-flash' })
  })
})

describe('main', () => {
  it('寫出可被 YAML 讀回的 patch，provider 設定原樣帶入', () => {
    const { providers, out } = setup()
    const r = main(['--provider', 'qwen', '--model', 'qwen3.8-flash', '--providers', providers, '--out', out])
    expect(r).toEqual({ out, provider: 'qwen', model: 'qwen3.8-flash' })
    const rows = load(readFileSync(out, 'utf8')) as { id: string; config: Record<string, unknown> }[]
    expect(rows.map((x) => x.id)).toEqual(['agent-default-model', 'llm-pi-ai'])
    expect(rows[0]!.config).toEqual({ provider: 'qwen', model: 'qwen3.8-flash' })
    expect(Object.keys((rows[1]!.config as { providers: object }).providers)).toEqual(['anthropic', 'qwen'])
  })
  it('--effort 寫入 reasoningEffort', () => {
    const { providers, out } = setup()
    main(['--provider', 'anthropic', '--model', 'claude-opus-5', '--effort', 'max', '--providers', providers, '--out', out])
    const rows = load(readFileSync(out, 'utf8')) as { config: Record<string, unknown> }[]
    expect(rows[0]!.config['reasoningEffort']).toBe('max')
  })
  it('provider 未宣告 → fail-loud（不讓 DSH 落回內建預設模型）', () => {
    const { providers, out } = setup()
    expect(() => main(['--provider', 'deepseek-official', '--model', 'x', '--providers', providers, '--out', out])).toThrow(
      /未宣告.*anthropic, qwen/,
    )
  })
})

describe('parseArgs', () => {
  it('預設 providers 路徑為 config/dsh/settings.providers.yaml', () => {
    expect(parseArgs(['--provider', 'a', '--model', 'b', '--out', 'o']).providersPath).toBe(
      'config/dsh/settings.providers.yaml',
    )
  })
  it('缺必填、缺值、未知參數 → 錯誤', () => {
    expect(() => parseArgs(['--provider', 'a', '--out', 'o'])).toThrow(/--model is required/)
    expect(() => parseArgs(['--provider'])).toThrow(/--provider requires a value/)
    expect(() => parseArgs(['--provider', '--model'])).toThrow(/requires a value/)
    expect(() => parseArgs(['--nope', 'x'])).toThrow(/unknown argument: --nope/)
  })
})
