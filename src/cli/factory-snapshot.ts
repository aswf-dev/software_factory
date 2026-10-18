/**
 * factory-snapshot — 把「流程現況」與「待開工作項清單」組成一份可發佈的 JSON。
 *
 * 為什麼要有這支 CLI：Scoreboard 是 Worker，不該（也不能）重跑 `factory-graph`／
 * `factory-next` 的判定（ADR-001、ADR-023 §2）。因此由 CI 產出快照，Scoreboard 只讀。
 *
 * 輸出契約 `FactorySnapshotSchema` 是給 consumer 驗證用的：欄位少一個、型別變了，
 * 都會在對方 parse 時失敗，而不是畫出一張半空的圖。
 *
 * 這支 CLI **只讀**：不建立 Issue、不貼 label、不觸發 workflow（ADR-024 §1／§2）。
 */
import { z } from 'zod'
import { CliError, formatCliError } from './run-cli.js'
import { isMainModule } from './is-main-module.js'
import { collectInputs, parseOptions, type GraphDeps, type GraphOptions } from './factory-graph.js'
import { buildGraph, GraphDocumentSchema } from '../graph/build.js'
import { NextActionsSchema, nextActions } from '../process/next-actions.js'
import type { NextActionsDocument } from '../process/next-actions.js'
import { TEMPLATE_ID_PATTERN, validateProcess } from '../process/spec.js'

/** v1。consumer 必須拒絕不認得的版本，而不是猜測相容。 */
export const SNAPSHOT_SCHEMA_VERSION = 1

export const FactorySnapshotSchema = z.object({
  schema_version: z.literal(SNAPSHOT_SCHEMA_VERSION),
  system: z.string().min(1),
  generated_at: z.string().min(1),
  source: z.object({ github: z.string().min(1) }),
  /** 產生這份快照的模板（`<tenant>/<name>`）；null = 未提供 process。 */
  template: z.string().regex(TEMPLATE_ID_PATTERN).nullable(),
  /** 釘選的模板版本；consumer 才能選對定義（ADR-025）。 */
  template_version: z.number().int().positive().nullable(),
  graph: GraphDocumentSchema,
  /** null = 未提供 process／template（或模組清單）；原因寫在 warnings。 */
  next: NextActionsSchema.nullable(),
  warnings: z.array(z.string()),
})

export type FactorySnapshot = z.infer<typeof FactorySnapshotSchema>

/* v8 ignore start -- 真實環境的薄包裝：單元測試一律注入 fake deps */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
const realDeps: GraphDeps = {
  gh: (args) => execFileSync('gh', args, { encoding: 'utf8' }),
  readFile: (path) => readFileSync(path, 'utf8'),
  now: () => new Date().toISOString(),
}
/* v8 ignore stop */

/**
 * 由既有輸入組出快照。
 *
 * `next` 只在 **process 與 template 兩者都有**時才計算；缺一個就回 null 並附
 * advisory warning——「不知道」比「猜一個清單」安全（ADR-024 §4）。
 */
export function snapshot(options: GraphOptions, deps: GraphDeps): FactorySnapshot {
  const inputs = collectInputs(options, deps)
  const graph = buildGraph(inputs)
  const warnings: string[] = []
  let next: NextActionsDocument | null = null

  if (inputs.process !== undefined && inputs.template !== undefined) {
    const template = inputs.template
    const validation = validateProcess(inputs.process, template)
    if (!validation.ok) {
      throw new CliError(`process 與模板不一致：${validation.errors.join('; ')}`)
    }
    if (inputs.modules === undefined) {
      warnings.push('未提供 --modules：待開工作項清單只能包含系統層 warning')
    }
    next = nextActions({
      system: inputs.system,
      template,
      process: inputs.process,
      modules: inputs.modules ?? [],
      issues: inputs.issues,
      gates: inputs.gates ?? [],
      generatedAt: inputs.generatedAt,
    })
    warnings.push(...next.warnings)
  } else {
    warnings.push('未提供 --process／--template：不含待開工作項清單')
  }

  return FactorySnapshotSchema.parse({
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    system: inputs.system,
    generated_at: inputs.generatedAt,
    source: { github: options.repo },
    template: inputs.process?.template ?? null,
    template_version: inputs.process?.template_version ?? null,
    graph,
    next,
    warnings: [...new Set(warnings)],
  })
}

export function main(argv: readonly string[], deps: GraphDeps = realDeps): FactorySnapshot {
  return snapshot(parseOptions(argv), deps)
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  try {
    process.stdout.write(JSON.stringify(main(process.argv.slice(2)), null, 2) + '\n')
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`)
    process.exitCode = 1
  }
}
/* v8 ignore stop */
