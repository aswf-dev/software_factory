/**
 * factory-dsh-patch — 產生本次模型嘗試的 DSH patch（docs/ADR/011）。
 *
 * 由 factory-run.yml 的 agent 步驟對 chain 的每一項執行，輸出檔再以
 * `dsh --patch <file>` 帶入：
 *
 *   node dist/cli/factory-dsh-patch.js --provider anthropic --model claude-opus-5 \
 *     --effort max --out .factory/run/model.patch.yml
 *
 * provider 必須已宣告於 settings.providers.yaml——未宣告就 fail-loud，
 * 不讓 DSH 落回內建預設模型（那正是 0.1.7 無聲失效的樣子）。
 */
import { writeFileSync } from 'node:fs'
import { dump } from 'js-yaml'
import { buildModelPatch, type ModelSelection } from '../model-tier/dsh-patch.js'
import { loadPiAiConfig } from '../model-tier/resolve.js'
import { CliError, runCli } from './run-cli.js'
import { isMainModule } from './is-main-module.js'

export interface DshPatchArgs extends ModelSelection {
  providersPath: string
  out: string
}

const DEFAULT_PROVIDERS_PATH = 'config/dsh/settings.providers.yaml'

export function parseArgs(argv: string[]): DshPatchArgs {
  const values: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string
    if (!['--provider', '--model', '--effort', '--providers', '--out'].includes(flag)) {
      throw new CliError(`unknown argument: ${flag}`)
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new CliError(`${flag} requires a value`)
    values[flag] = value
    i++
  }
  for (const required of ['--provider', '--model', '--out']) {
    if (values[required] === undefined) throw new CliError(`${required} is required`)
  }
  return {
    provider: values['--provider'] as string,
    model: values['--model'] as string,
    reasoningEffort: values['--effort'],
    providersPath: values['--providers'] ?? DEFAULT_PROVIDERS_PATH,
    out: values['--out'] as string,
  }
}

export function main(argv: string[]): { out: string } & ModelSelection {
  const args = parseArgs(argv)
  const piAi = loadPiAiConfig(args.providersPath)
  if (!(args.provider in piAi.providers)) {
    throw new CliError(
      `provider "${args.provider}" 未宣告於 ${args.providersPath}` +
        `（已宣告：${Object.keys(piAi.providers).join(', ')}）`,
    )
  }
  const selection: ModelSelection = { provider: args.provider, model: args.model }
  if (args.reasoningEffort !== undefined) selection.reasoningEffort = args.reasoningEffort
  writeFileSync(args.out, dump(buildModelPatch(piAi, selection)))
  return { out: args.out, ...selection }
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  process.exitCode = runCli(() => main(process.argv.slice(2)))
}
/* v8 ignore stop */
