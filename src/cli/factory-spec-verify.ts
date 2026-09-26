/**
 * factory-spec-verify — agent-write-spec 的集中驗證（ADR-018 §7），由 factory-run
 * 在 crosscheck 通過之後、judge 之前執行。結果由 CI 計算，不採信 agent 的自報。
 *
 * - 不變量階段：`invariants.qnt` 能單獨通過 typecheck，且每個 `INV_*` 上方都有
 *   `// source:` 引用。
 * - 模型階段：依 `verify.yml` 逐項執行 `quint run`／`quint verify`（各自逾時），
 *   彙總每條不變量；違反時把反例 ITF 存到 `specs/<name>/traces/`（CI 專屬目錄，
 *   先清空再寫，確保內容只反映本次執行）。
 *
 * 輸出 JSON（stdout）：`{ phase, ok, mismatches, advisories, invariants?, checks? }`；
 * `--summary <file>` 另寫一份 Markdown 摘要供留言。`ok=false` 時 exit 1。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isValidSpecName } from '../write-spec/intake.js'
import { specPaths, type SpecFinding, type SpecPhase } from '../write-spec/scope.js'
import {
  aggregateByInvariant,
  checkInvariantSources,
  judgeEvidence,
  parseQuintOutput,
  parseVerifyConfig,
  type CheckResult,
  type InvariantResult,
  type VerifyCheck,
} from '../write-spec/verify.js'
import { isMainModule } from './is-main-module.js'
import { CliError, formatCliError } from './run-cli.js'

export interface QuintRun {
  exitCode: number | null
  output: string
  timedOut: boolean
}

/** quint 執行注入點；cwd 為規格目錄，timeoutMs 到期即中止。 */
export type QuintRunner = (args: string[], opts: { cwd: string; timeoutMs: number }) => QuintRun

function realQuint(bin: string): QuintRunner {
  return (args, { cwd, timeoutMs }) => {
    const r = spawnSync(bin, args, { cwd, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM'
    return { exitCode: r.status, output: `${r.stdout}${r.stderr}`, timedOut }
  }
}

export interface SpecVerifyArgs {
  phase: SpecPhase
  specName: string
  target: string
  quintBin: string
  summaryPath?: string | undefined
}

export interface SpecVerifyOutput {
  phase: SpecPhase
  ok: boolean
  mismatches: SpecFinding[]
  advisories: SpecFinding[]
  invariants?: InvariantResult[] | undefined
  checks?: CheckResult[] | undefined
}

const TYPECHECK_TIMEOUT_MS = 120_000

export function parseArgs(argv: string[]): SpecVerifyArgs {
  let phase: string | undefined
  let specName: string | undefined
  let target = 'target'
  let quintBin = 'node_modules/.bin/quint'
  let summaryPath: string | undefined
  const value = (i: number, flag: string): string => {
    const v = argv[i]
    if (v === undefined || v.startsWith('--')) throw new CliError(`${flag} requires a value`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--phase') phase = value(++i, arg)
    else if (arg === '--spec-name') specName = value(++i, arg)
    else if (arg === '--target') target = value(++i, arg)
    else if (arg === '--quint') quintBin = value(++i, arg)
    else if (arg === '--summary') summaryPath = value(++i, arg)
    else throw new CliError(`unknown argument: ${arg}`)
  }
  if (phase !== 'invariants' && phase !== 'model') {
    throw new CliError(`--phase must be invariants or model, got ${phase ?? '(missing)'}`)
  }
  if (specName === undefined || !isValidSpecName(specName)) {
    throw new CliError(`--spec-name is missing or invalid: ${specName ?? '(missing)'}`)
  }
  return { phase, specName, target, quintBin: resolve(quintBin), summaryPath }
}

const finding = (kind: string, detail: string): SpecFinding => ({ kind, detail })

function typecheck(quint: QuintRunner, cwd: string, file: string): SpecFinding[] {
  const r = quint(['typecheck', file], { cwd, timeoutMs: TYPECHECK_TIMEOUT_MS })
  if (r.exitCode === 0 && !r.timedOut) return []
  const tail = r.output.split('\n').filter((l) => l.trim() !== '').slice(-5).join(' / ')
  return [finding('write-spec-typecheck', `\`${file}\` 未通過 quint typecheck：${r.timedOut ? '逾時' : tail}`)]
}

function verifyInvariants(quint: QuintRunner, specDir: string): SpecVerifyOutput {
  if (!existsSync(join(specDir, 'invariants.qnt'))) {
    return result('invariants', [finding('write-spec-missing-file', '缺 `invariants.qnt`')], [])
  }
  const mismatches = [
    ...typecheck(quint, specDir, 'invariants.qnt'),
    ...checkInvariantSources(readFileSync(join(specDir, 'invariants.qnt'), 'utf8')).map((e) =>
      finding('write-spec-source-comment', e),
    ),
  ]
  return result('invariants', mismatches, [])
}

function runCheck(quint: QuintRunner, specDir: string, check: VerifyCheck, tracesRel: string): CheckResult {
  const base = { instance: check.instance, invariant: check.invariant, mode: check.mode }
  const tmp = `.tmp-${check.instance}.${check.invariant}.itf.json`
  const common = [
    'instances.qnt',
    `--main=${check.instance}`,
    `--invariant=${check.invariant}`,
    `--max-steps=${check.max_steps}`,
    `--out-itf=${tmp}`,
  ]
  const timeoutMs = check.timeout_seconds * 1000
  const witnessArgs = ['--max-steps', String(check.max_steps), '--max-samples', String(check.max_samples), '--witnesses', ...check.witnesses]
  const first =
    check.mode === 'verify'
      ? quint(['verify', ...common], { cwd: specDir, timeoutMs })
      : quint(['run', ...common, ...witnessArgs.slice(2)], { cwd: specDir, timeoutMs })
  let parsed = parseQuintOutput(first.exitCode, first.output, first.timedOut)

  let trace: string | undefined
  const tmpPath = join(specDir, tmp)
  if (parsed.status === 'violated' && existsSync(tmpPath)) {
    const name = `${check.instance}.${check.invariant}.itf.json`
    renameSync(tmpPath, join(specDir, 'traces', name))
    trace = `${tracesRel}${name}`
  }
  rmSync(tmpPath, { force: true })

  // verify（Apalache）不回報 witness：成立時另以 quint run 量測情境 witness 是否可達
  if (check.mode === 'verify' && parsed.status === 'holds') {
    const w = quint(['run', 'instances.qnt', `--main=${check.instance}`, ...witnessArgs], { cwd: specDir, timeoutMs })
    parsed = parseQuintOutput(w.exitCode, w.output, w.timedOut)
  }
  return { ...base, ...parsed, trace }
}

function verifyModel(quint: QuintRunner, specDir: string, specName: string): SpecVerifyOutput {
  const required = ['invariants.qnt', 'model.qnt', 'instances.qnt', 'verify.yml']
  const missing = required.filter((f) => !existsSync(join(specDir, f)))
  if (missing.length > 0) {
    return result('model', missing.map((f) => finding('write-spec-missing-file', `缺 \`${f}\``)), [])
  }
  const typeErrors = typecheck(quint, specDir, 'instances.qnt')
  if (typeErrors.length > 0) return result('model', typeErrors, [])

  const read = (f: string): string => readFileSync(join(specDir, f), 'utf8')
  const { config, errors } = parseVerifyConfig(read('verify.yml'), {
    invariantsText: read('invariants.qnt'),
    modelText: read('model.qnt'),
    instancesText: read('instances.qnt'),
  })
  if (config === undefined || errors.length > 0) {
    return result('model', errors.map((e) => finding('write-spec-verify-config', e)), [])
  }

  // traces/ 是 CI 專屬目錄：先清掉舊的 ITF，內容只反映本次執行
  const tracesDir = join(specDir, 'traces')
  mkdirSync(tracesDir, { recursive: true })
  for (const f of readdirSync(tracesDir)) {
    if (f.endsWith('.itf.json')) rmSync(join(tracesDir, f))
  }
  const checks = config.checks.map((c) => runCheck(quint, specDir, c, specPaths(specName).traces))
  const invariants = aggregateByInvariant(checks)
  const { mismatches, advisories } = judgeEvidence(invariants)
  return { ...result('model', mismatches, advisories), invariants, checks }
}

function result(phase: SpecPhase, mismatches: SpecFinding[], advisories: SpecFinding[]): SpecVerifyOutput {
  return { phase, ok: mismatches.length === 0, mismatches, advisories }
}

const STATUS_LABEL: Record<InvariantResult['status'], string> = {
  holds: '✅ 成立（witness 可達）',
  violated: '🔴 違反（候選發現，未回放）',
  vacuous: '⚠️ 成立但 witness 皆不可達（假綠燈嫌疑）',
  timeout: '⏱️ 逾時',
  error: '❌ 執行失敗',
}

/** 留言用的 Markdown 摘要。 */
export function renderSummary(out: SpecVerifyOutput, runId: string): string {
  const lines = [
    `## 🧮 規格驗證（ADR-018 §7，${out.phase} 階段，run: ${runId}）`,
    '',
    out.ok ? '證據完整。' : '**證據不完整，已交還人類。**',
  ]
  if (out.invariants !== undefined && out.invariants.length > 0) {
    lines.push('', '| 不變量 | 結果 | 反例 |', '|---|---|---|')
    for (const r of out.invariants) {
      lines.push(`| \`${r.invariant}\` | ${STATUS_LABEL[r.status]} | ${r.traces.map((t) => `\`${t}\``).join('<br>')} |`)
    }
  }
  for (const m of out.mismatches) lines.push(`- ❌ ${m.detail}`)
  for (const a of out.advisories) lines.push(`- 💡 ${a.detail}`)
  return `${lines.join('\n')}\n`
}

export function main(argv: string[], quint?: QuintRunner, runId = 'local'): SpecVerifyOutput {
  const args = parseArgs(argv)
  const runner = quint ?? realQuint(args.quintBin)
  const specDir = join(args.target, specPaths(args.specName).dir)
  const out =
    args.phase === 'invariants' ? verifyInvariants(runner, specDir) : verifyModel(runner, specDir, args.specName)
  if (args.summaryPath !== undefined) writeFileSync(args.summaryPath, renderSummary(out, runId))
  return out
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  try {
    const out = main(process.argv.slice(2), undefined, process.env.GITHUB_RUN_ID ?? 'local')
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
    if (!out.ok) process.exitCode = 1
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`)
    process.exitCode = 1
  }
}
/* v8 ignore stop */
