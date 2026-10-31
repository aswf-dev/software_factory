/**
 * Lean proofs 的**獨立審查**輔助 CLI（aswf-dev/software_factory#143，選項 B）。
 *
 * 背景：`lean-formal-verification` 要求證明完成後做一輪 fresh-context 的對抗式審查。
 * 原本這一步是 proofs agent 在自己的工作項內開子任務，可以被逾時或 agent 自行放棄
 * （run 40812198122：兩個審查子任務都沒回報，改做 self-review）。現在由 workflow 在
 * proofs agent 之後，以**另一個 DSH session** 跑審查。審查者與 proofs agent 共用同一
 * 個檔案系統，所以需要機械化的邊界：
 *
 *   snapshot  審查開始前，對 target 的每個檔案記 sha256（寫在 target 之外）。
 *   check     審查結束後重算：除了 `specs/lean/REVIEW.md`，任何新增／修改／刪除都是
 *             越界；同時解析 REVIEW.md 的 `Verdict:` 行。
 *
 * 用檔案系統 manifest 而不是 git：審查者可以在本地 commit、改 index 或 git config，
 * 但改不了「檔案內容」這個事實（與 factory-verify-facts 的 R25 同一個理由）。
 * `.git/` 與 `.lake/`（`lake build` 的產物）不納入：前者不是交付、後者審查者本來就
 * 要建置。
 *
 * 輸出是 JSON（stdout，由 workflow 導到 target 之外的檔案）。檔名清單屬 metadata，
 * 驗證模式不得印進公開 log，所以越界時**不**以錯誤訊息印出路徑——只有參數錯誤才
 * exit 1。
 *
 * 用法：
 *   factory-lean-review snapshot --target target --out .factory/review/manifest.json
 *   factory-lean-review check --target target --manifest .factory/review/manifest.json
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { isMainModule } from './is-main-module.js'
import { CliError, runCli } from './run-cli.js'

/** 審查者唯一可以新增或修改的檔案。 */
export const REVIEW_PATH = 'specs/lean/REVIEW.md'
/** 不進 manifest 的目錄名（任何深度）。 */
const SKIPPED_DIRS = new Set(['.git', '.lake'])

export type Verdict = 'PASS' | 'PASS-WITH-NITS' | 'FAIL'

export interface Manifest {
  files: Record<string, string>
}

export type Change = 'added' | 'modified' | 'deleted'

export interface CheckResult {
  /** 除了 REVIEW.md 之外沒有任何變更。 */
  scopeOk: boolean
  violations: Array<{ path: string; change: Change }>
  review: { present: boolean; verdict: Verdict | null }
}

/** manifest 一律用 `/` 分隔（與 bundle／crosscheck 的路徑形狀一致）。 */
function toPosix(path: string): string {
  return path.split(sep).join('/')
}

/** target 下每個檔案（含 symlink 本身）的 sha256；跳過 `.git`／`.lake`。 */
export function buildManifest(target: string): Manifest {
  const root = resolve(target)
  const files: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue
        walk(abs)
        continue
      }
      const rel = toPosix(relative(root, abs))
      const stat = lstatSync(abs)
      if (stat.isSymbolicLink()) {
        // symlink 以「指向哪裡」為內容：改指向也是變更，且不跟隨（不讓審查者借道讀寫）。
        files[rel] = createHash('sha256').update(`symlink:${readlinkSync(abs)}`).digest('hex')
        continue
      }
      // FIFO／socket／裝置檔：讀取可能卡住，也不是交付；略過。
      if (!stat.isFile()) continue
      files[rel] = createHash('sha256').update(readFileSync(abs)).digest('hex')
    }
  }
  walk(root)
  return { files }
}

/**
 * REVIEW.md 的判定：第一個 `Verdict: <PASS|PASS-WITH-NITS|FAIL>` 行（容忍粗體、
 * 反引號與全形冒號）。找不到就是 null——呼叫端必須把它當成 FAIL（不猜）。
 */
export function parseVerdict(markdown: string): Verdict | null {
  const match = /^[ \t>*_-]*\**Verdict\**[ \t]*[:：][ \t*`_]*(PASS-WITH-NITS|PASS|FAIL)\b/im.exec(markdown)
  if (match === null) return null
  return match[1]!.toUpperCase() as Verdict
}

export function checkReview(target: string, manifest: Manifest): CheckResult {
  const now = buildManifest(target)
  const violations: CheckResult['violations'] = []
  for (const [path, sha] of Object.entries(now.files)) {
    const before = manifest.files[path]
    const change: Change | null = before === undefined ? 'added' : before !== sha ? 'modified' : null
    if (change !== null && path !== REVIEW_PATH) violations.push({ path, change })
  }
  for (const path of Object.keys(manifest.files)) {
    if (now.files[path] === undefined && path !== REVIEW_PATH) violations.push({ path, change: 'deleted' })
  }
  // 路徑在 manifest 裡唯一，所以不會相等。
  violations.sort((a, b) => (a.path < b.path ? -1 : 1))

  const reviewAbs = join(resolve(target), REVIEW_PATH)
  const present = now.files[REVIEW_PATH] !== undefined && existsSync(reviewAbs) && lstatSync(reviewAbs).isFile()
  const verdict = present ? parseVerdict(readFileSync(reviewAbs, 'utf8')) : null
  return { scopeOk: violations.length === 0, violations, review: { present, verdict } }
}

function parseManifest(raw: string): Manifest {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new CliError('--manifest is not valid JSON')
  }
  const files = (value as { files?: unknown } | null)?.files
  if (files === null || typeof files !== 'object' || Array.isArray(files)) {
    throw new CliError('--manifest has no files object')
  }
  for (const sha of Object.values(files as Record<string, unknown>)) {
    if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) throw new CliError('--manifest has an invalid sha256')
  }
  return { files: files as Record<string, string> }
}

function flags(argv: string[], allowed: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (!allowed.includes(arg)) throw new CliError(`unknown argument: ${arg}`)
    const value = argv[++i]
    if (value === undefined || value.startsWith('--')) throw new CliError(`${arg} requires a value`)
    values[arg] = value
  }
  return values
}

export function main(argv: string[]): unknown {
  const [command, ...rest] = argv
  if (command === 'snapshot') {
    const values = flags(rest, ['--target', '--out'])
    const target = values['--target']
    const out = values['--out']
    if (target === undefined || out === undefined) throw new CliError('snapshot requires --target and --out')
    const manifest = buildManifest(target)
    writeFileSync(out, `${JSON.stringify(manifest)}\n`)
    return { files: Object.keys(manifest.files).length }
  }
  if (command === 'check') {
    const values = flags(rest, ['--target', '--manifest'])
    const target = values['--target']
    const manifestPath = values['--manifest']
    if (target === undefined || manifestPath === undefined) {
      throw new CliError('check requires --target and --manifest')
    }
    return checkReview(target, parseManifest(readFileSync(manifestPath, 'utf8')))
  }
  throw new CliError('usage: factory-lean-review <snapshot|check> …')
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  process.exitCode = runCli(() => main(process.argv.slice(2)))
}
/* v8 ignore stop */
