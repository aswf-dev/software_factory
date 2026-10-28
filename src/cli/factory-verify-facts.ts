/**
 * factory-verify-facts — 在 **clean repo** 裡 materialise 驗證類的 git 事實（R25）。
 *
 * ## 為什麼不再直接對 agent 工作樹跑 git
 *
 * 前五個修正波逐一堵住 target `.git` 的攻擊面（replace refs、global config、
 * repo-local `core.worktree`／`core.fsmonitor`、`diff.<driver>.textconv`、
 * `.git/info/exclude`、`-diff` 屬性、rename 偵測）。第六波承認這是一場打地鼠：
 * agent 有 shell，而 `git diff`／`git status` 會執行的東西還在增加（clean filter、
 * `filter.<driver>.process`、index flags…），而 crosscheck 步驟握有 **WRITE** App
 * token。只要事實推導還會在 target 內執行 git，就永遠有下一個可執行面。
 *
 * 因此本 CLI 把事實搬到 target 外重建：
 *   1. `git -C <target> archive <base-sha>` 取 base（archive 不跑 clean filter），
 *      解到 `$RUNNER_TEMP/<work>/base`；
 *   2. `rsync -a` 把工作樹複製到 `$RUNNER_TEMP/<work>/facts`（排除 `.git`、
 *      `.dsh`、`.agents`、`AGENTS.md`、`CLAUDE.md`）——rsync 不讀 agent 的 git
 *      config，也不執行任何過濾器；
 *   3. 在 `$RUNNER_TEMP/<work>/calc` `git init` 一個乾淨 repo，套用**顯式最小
 *      config**（`core.hooksPath=/dev/null`、`core.fsmonitor=false`、身分與
 *      `commit.gpgsign=false`），把 base 樹複製進去、`git add -A -f`、commit；
 *      再把 facts 覆蓋上去（刪掉 facts 沒有的檔案）、`git add -A -f`；
 *   4. 以 `git diff --cached` 產生 changed／lines／assertion 事實。
 *
 * `-f` 讓所有 ignore 檔（含 agent 自己寫的 `.gitignore`）失效；index flags
 * （assume-unchanged／skip-worktree）不存在於新 repo；attributes／filter 只可能
 * 來自 base 樹與 facts 內容，而 clean repo 的 config 沒有任何 filter driver。
 *
 * ## 邊界
 *
 * - 所有暫存檔都在 `$RUNNER_TEMP`；未設定即 fail closed（不得把 target 內容
 *   寫到 runner 的其他位置）。
 * - 輸出 JSON 是 crosscheck／encrypt 唯一的事實來源；workflow 把它寫在 target
 *   之外的 `.factory/verify-facts.json`。
 * - `.dsh`／`.agents`／`AGENTS.md`／`CLAUDE.md` 在 base 與 facts 兩側都排除：
 *   workflow 在 agent 之前已把他們移到一旁（tracked 的刪除因此不是 agent 的
 *   越界變更），事實層再過濾一次，讓舊 facts 或漏掉的 workflow 步驟也不會
 *   產生 scope 假紅。
 * - `git archive` 仍會讀 target 的 repo-local config；它不執行 clean filter／
 *   hooks／fsmonitor，且 `GIT_NO_REPLACE_OBJECTS=1`、global／system config 指向
 *   `/dev/null`，所以 base 的物件解析不受 agent 的 `git replace` 影響。詳細殘留
 *   見 docs/34 §7。
 */
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { countAssertionDelta } from '../assertion-count/count.js'
import { GIT_HARDENING_ENV } from './git-safe.js'
import { isMainModule } from './is-main-module.js'
import { CliError, runCli } from './run-cli.js'

/** `--base-sha` 的形狀：完整 40 位 hex commit（與 crosscheck／encrypt 相同）。 */
const BASE_SHA_HEX = /^[0-9a-f]{40}$/i

/** 外部命令輸出的上限；超過即 fail closed（不讓 archive 把 runner 記憶體吃光）。 */
const MAX_COMMAND_OUTPUT = 512 * 1024 * 1024

/** 事實計算要排除的路徑 segment／檔名（workflow 在 agent 之前把他們移到一旁）。 */
const NEUTRALISED_SEGMENTS: ReadonlySet<string> = new Set(['.dsh', '.agents'])
const NEUTRALISED_FILE_NAMES: ReadonlySet<string> = new Set(['AGENTS.md', 'CLAUDE.md'])

/** clean repo 的顯式最小 config；不繼承 target 或 global 的任何設定。 */
const CALC_CONFIG = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'core.excludesFile=/dev/null',
  '-c',
  'user.name=factory-verify-facts',
  '-c',
  'user.email=factory-verify-facts@invalid',
  '-c',
  'commit.gpgsign=false',
] as const

export type VerifyFactStatus = 'A' | 'M' | 'D'

export interface VerifyFact {
  path: string
  status: VerifyFactStatus
}

/** `factory-verify-facts` 的輸出；crosscheck／encrypt 的唯一事實來源。 */
export interface VerifyFacts {
  baseSha: string
  changed: VerifyFact[]
  linesAdded: number
  linesDeleted: number
  assertionDelta: number
}

export interface MaterialiseFactsOptions {
  /** agent 工作樹（workflow 中是 `target`）。 */
  targetDir: string
  /** agent 啟動前的 HEAD（40-hex；workflow 由 `.factory/base-sha` 傳入）。 */
  baseSha: string
  /** 輸出 JSON 路徑（workflow 中是 target 外的 `.factory/verify-facts.json`）。 */
  outFile: string
}

/** 路徑是否屬於 agent 不該看到、事實也不該回報的 mechanism／instruction 面。 */
export function isNeutralisedPath(rel: string): boolean {
  return rel
    .split('/')
    .some(
      (segment) => NEUTRALISED_SEGMENTS.has(segment) || NEUTRALISED_FILE_NAMES.has(segment),
    )
}

/** 驗證並正規化 base SHA；形狀不合即 fail closed（不得退回分支名）。 */
export function normalizeFactsBaseSha(value: string): string {
  const sha = value.trim().toLowerCase()
  if (!BASE_SHA_HEX.test(sha)) {
    throw new CliError(
      `--base-sha 必須是完整的 40-hex commit（40 位十六進位；收到「${value}」）——` +
        'verify facts 以 agent 啟動前的 HEAD 為唯一基準（R19／R25，fail closed）',
    )
  }
  return sha
}

/**
 * 解析 `git diff --cached -z --name-status --no-renames` 的輸出。
 *
 * `-z` 的格式是 `status\0path\0status\0path\0…`（`--no-renames` 所以不會有
 * `R100\0old\0new` 這種三欄位）。typechange（`T`）在事實層視為 `M`：clean repo
 * 裡 base 是檔案、facts 是 symlink（或反之）仍是 agent 的變更，不能因此讓
 * `changed` 少一筆。其餘未知狀態 fail closed——寧可紅燈，也不要默默漏掉。
 */
export function parseNameStatus(output: string): VerifyFact[] {
  const tokens = output.split('\0')
  const changed: VerifyFact[] = []
  for (let i = 0; i < tokens.length; i += 2) {
    // 迴圈條件保證 i < tokens.length；這裡不需要（也測不到）undefined 分支。
    const status = tokens[i] as string
    if (status === '') break
    const path = tokens[i + 1] ?? ''
    if (path === '') throw new CliError('fact diff 的 name-status 缺 path（fail closed）')
    const code = status[0]
    if (code === 'A' || code === 'M' || code === 'D') {
      changed.push({ path, status: code })
    } else if (code === 'T') {
      changed.push({ path, status: 'M' })
    } else {
      throw new CliError(`fact diff 出現未知的 diff 狀態「${status}」（fail closed）`)
    }
  }
  return changed
}

/**
 * 從 `--unified=0` 的 clean-repo diff 計算增減行數。
 *
 * 只算 hunk 內以 `+`／`-` 開頭的行：`@@` 之前是檔案標頭（`--- a/x`／`+++ b/x`
 * 也會以 `-`／`+` 開頭），不能算進去；進入 hunk 後，內容剛好以 `++`／`--`
 * 開頭時 diff 會長成 `+++`／`---`，那些**要**算。`\ No newline at end of file`
 * 不是變更行。
 */
export function countDiffLines(diff: string): { added: number; deleted: number } {
  let added = 0
  let deleted = 0
  let inHunk = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHunk = false
      continue
    }
    if (line.startsWith('@@')) {
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) deleted++
  }
  return { added, deleted }
}

/** facts JSON 內的單一路徑必須是安全的相對路徑（供 crosscheck／encrypt 直接使用）。 */
function isSafeFactsPath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false
  return path
    .split('/')
    .every(
      (segment) =>
        segment !== '' && segment !== '.' && segment !== '..' && segment.toLowerCase() !== '.git',
    )
}

function requireInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new CliError(`--facts 的 ${field} 必須是整數（fail closed）`)
  }
  return value
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  const n = requireInteger(value, field)
  if (n < 0) throw new CliError(`--facts 的 ${field} 不得為負（fail closed）`)
  return n
}

/**
 * 讀取並驗證 `factory-verify-facts` 的輸出。
 *
 * facts 檔由 workflow 寫在 target 之外，但它是兩個 CLI 的唯一事實來源；形狀、
 * 路徑安全與數字都必須驗，否則一個壞檔會讓 crosscheck 靜默變成 no-op，或讓
 * encrypt `join(target, path)` 讀到 target 外的檔案。
 */
export function loadVerifyFacts(path: string): VerifyFacts {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new CliError(`--facts (${path}) 無法讀取（fail closed）`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new CliError(`--facts (${path}) 不是合法 JSON（fail closed）`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new CliError(`--facts (${path}) 必須是 JSON 物件（fail closed）`)
  }
  const value = raw as Record<string, unknown>
  if (typeof value.baseSha !== 'string') {
    throw new CliError(`--facts (${path}) 的 baseSha 必須是 40-hex 字串（fail closed）`)
  }
  const baseSha = normalizeFactsBaseSha(value.baseSha)
  if (!Array.isArray(value.changed)) {
    throw new CliError(`--facts (${path}) 的 changed 必須是陣列（fail closed）`)
  }
  const changed: VerifyFact[] = []
  const seen = new Set<string>()
  for (const entry of value.changed) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new CliError(`--facts (${path}) 的 changed 條目必須是 { path, status } 物件（fail closed）`)
    }
    const { path: rel, status } = entry as { path?: unknown; status?: unknown }
    if (typeof rel !== 'string' || !isSafeFactsPath(rel)) {
      throw new CliError(`--facts (${path}) 的 changed 條目含不安全的 path（fail closed）`)
    }
    if (status !== 'A' && status !== 'M' && status !== 'D') {
      throw new CliError(`--facts (${path}) 的 changed 條目 status 必須是 A／M／D（fail closed）`)
    }
    if (seen.has(rel)) {
      throw new CliError(`--facts (${path}) 的 changed 含重複路徑（fail closed）`)
    }
    seen.add(rel)
    changed.push({ path: rel, status })
  }
  return {
    baseSha,
    changed,
    linesAdded: requireNonNegativeInteger(value.linesAdded, 'linesAdded'),
    linesDeleted: requireNonNegativeInteger(value.linesDeleted, 'linesDeleted'),
    assertionDelta: requireInteger(value.assertionDelta, 'assertionDelta'),
  }
}

interface CommandOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  input?: Buffer
}

interface CommandResult {
  status: number | null
  stdout: Buffer
  stderr: Buffer
  error?: Error | undefined
}

function runCommand(command: string, args: readonly string[], opts: CommandOptions = {}): CommandResult {
  return spawnSync(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    input: opts.input,
    maxBuffer: MAX_COMMAND_OUTPUT,
  })
}

/** 把外部命令的失敗轉成單行 CliError；不回印 stderr（可能含 runner 絕對路徑）。 */
function requireSuccess(result: CommandResult, label: string): Buffer {
  if (result.error !== undefined) {
    throw new CliError(
      `${label} 無法執行（${String((result.error as NodeJS.ErrnoException).code)}）（fail closed）`,
    )
  }
  if (result.status !== 0) {
    throw new CliError(`${label} 失敗（exit ${String(result.status)}）（fail closed）`)
  }
  return result.stdout
}

/** 所有 git 子行程的硬化環境；caller 的 env 不得覆寫這四個值。 */
function hardenedEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...GIT_HARDENING_ENV,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
  }
}

function resolveTargetDir(targetDir: string): string {
  const target = resolve(targetDir)
  let stats
  try {
    stats = statSync(target)
  } catch {
    // 不轉述底層訊息、不回印傳入路徑（run log 是公開的）
    throw new CliError('target 目錄不存在（fail closed）')
  }
  if (!stats.isDirectory()) throw new CliError('target 不是目錄（fail closed）')
  return target
}

/**
 * `git -C <target> archive <base-sha>` → `tar -x`。
 *
 * archive 只輸出 tree 內容，不執行 clean filter／smudge／hooks／fsmonitor；這是
 * 本設計的關鍵前提。輸出經記憶體轉交 tar（不落任何明文 tar 檔）。
 */
function extractBaseTree(targetDir: string, baseSha: string, baseDir: string): void {
  const archive = runCommand(
    'git',
    ['-C', targetDir, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'archive', baseSha],
    { env: hardenedEnv() },
  )
  const tarInput = requireSuccess(archive, 'git archive')
  const tar = runCommand('tar', ['-x', '-C', baseDir], { input: tarInput })
  requireSuccess(tar, 'tar')
}

/**
 * 把 base 樹裡殘留的 neutralised 路徑刪掉。
 *
 * workflow 在 agent 之前已把 target 的這些路徑移到 `$RUNNER_TEMP/away`，但 base
 * commit 仍可能 **tracked** 它們；若留著，facts 側（rsync 已排除）會把它們算成
 * agent 的刪除，產生 scope 假紅。base 與 facts 兩側都排除後，事實裡根本不會出
 * 現這些路徑。
 */
function removeNeutralisedPaths(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (isNeutralisedPath(entry.name)) {
      rmSync(abs, { recursive: true, force: true })
    } else if (entry.isDirectory()) {
      removeNeutralisedPaths(abs)
    }
  }
}

function rsync(args: readonly string[]): void {
  requireSuccess(runCommand('rsync', args, { env: process.env }), 'rsync')
}

/** 在 clean repo 執行 git；顯式 config 不繼承 target 或 global 設定。 */
function calcGit(calcDir: string, args: readonly string[]): Buffer {
  return requireSuccess(
    runCommand('git', [...CALC_CONFIG, ...args], { cwd: calcDir, env: hardenedEnv() }),
    'git calc',
  )
}

function writeFacts(outFile: string, facts: VerifyFacts): void {
  try {
    mkdirSync(dirname(outFile), { recursive: true })
    writeFileSync(outFile, `${JSON.stringify(facts, null, 2)}\n`)
  } catch {
    throw new CliError(`--out (${outFile}) 無法寫入（fail closed）`)
  }
}

/**
 * 在 `$RUNNER_TEMP` 內重建 base／facts／calc 三個樹並回傳事實。
 *
 * 任何一步失敗（`RUNNER_TEMP` 未設定、target 不存在、base-sha 解析不到、git／
 * rsync／tar 非零、輸出不可寫）都拋 CliError；caller（CLI 或 workflow）以非零
 * 結束，crosscheck／encrypt 因此拿不到 facts 而 fail closed。
 */
export function materialiseVerifyFacts(opts: MaterialiseFactsOptions): VerifyFacts {
  const runnerTemp = process.env.RUNNER_TEMP
  if (runnerTemp === undefined || runnerTemp.trim() === '') {
    throw new CliError('RUNNER_TEMP 未設定——verify facts 只允許在 runner 的暫存目錄內materialise（fail closed）')
  }
  const baseSha = normalizeFactsBaseSha(opts.baseSha)
  const targetDir = resolveTargetDir(opts.targetDir)
  const workDir = mkdtempSync(join(runnerTemp, 'factory-verify-facts-'))
  const baseDir = join(workDir, 'base')
  const factsDir = join(workDir, 'facts')
  const calcDir = join(workDir, 'calc')
  mkdirSync(baseDir, { recursive: true })
  mkdirSync(factsDir, { recursive: true })
  mkdirSync(calcDir, { recursive: true })

  // (a) base：archive 不執行 clean filter（R25 的核心前提）。
  extractBaseTree(targetDir, baseSha, baseDir)
  removeNeutralisedPaths(baseDir)

  // (b) facts：rsync 不讀 agent 的 git config，也不執行任何 filter。
  rsync([
    '-a',
    '--exclude=.git',
    '--exclude=.dsh',
    '--exclude=.agents',
    '--exclude=AGENTS.md',
    '--exclude=CLAUDE.md',
    `${targetDir}/`,
    `${factsDir}/`,
  ])

  // (c) calc：乾淨 repo + base commit，再把 facts 覆蓋上去；`-f` 忽略所有 ignore 檔。
  calcGit(calcDir, ['init', '--quiet', '--initial-branch=main'])
  rsync(['-a', '--exclude=.git', `${baseDir}/`, `${calcDir}/`])
  calcGit(calcDir, ['add', '-A', '-f'])
  calcGit(calcDir, ['commit', '--quiet', '--allow-empty', '-m', 'factory-verify-facts base'])
  rsync(['-a', '--delete', '--exclude=.git', `${factsDir}/`, `${calcDir}/`])
  calcGit(calcDir, ['add', '-A', '-f'])

  const changed = parseNameStatus(
    calcGit(calcDir, ['diff', '--cached', '-z', '--name-status', '--no-renames', 'HEAD']).toString('utf8'),
  )
  const unified = calcGit(calcDir, [
    'diff',
    '--cached',
    '--unified=0',
    '--no-renames',
    '--no-textconv',
    '--text',
    'HEAD',
  ]).toString('utf8')
  const lines = countDiffLines(unified)
  const facts: VerifyFacts = {
    baseSha,
    changed,
    linesAdded: lines.added,
    linesDeleted: lines.deleted,
    assertionDelta: countAssertionDelta(unified).delta,
  }
  writeFacts(opts.outFile, facts)
  return facts
}

function readValue(argv: string[], i: number, flag: string): string {
  const value = argv[i]
  if (value === undefined || value.startsWith('--') || value.trim() === '') {
    throw new CliError(`${flag} requires a non-empty value`)
  }
  return value
}

/**
 * 解析 CLI 參數：`--target <dir> --base-sha <40-hex> --out <file>`。
 * 所有三個參數都是必要輸入；缺一即 fail closed（不猜 cwd、不產生半套事實）。
 */
export function parseArgs(argv: string[]): MaterialiseFactsOptions {
  let targetDir: string | undefined
  let baseSha: string | undefined
  let outFile: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--target') {
      targetDir = readValue(argv, ++i, arg)
    } else if (arg === '--base-sha') {
      baseSha = normalizeFactsBaseSha(readValue(argv, ++i, arg))
    } else if (arg === '--out') {
      outFile = readValue(argv, ++i, arg)
    } else {
      throw new CliError(`unknown argument: ${arg}`)
    }
  }
  if (targetDir === undefined) throw new CliError('--target is required')
  if (baseSha === undefined) throw new CliError('--base-sha is required')
  if (outFile === undefined) throw new CliError('--out is required')
  return { targetDir, baseSha, outFile }
}

export function main(argv: string[]): VerifyFacts {
  return materialiseVerifyFacts(parseArgs(argv))
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  process.exitCode = runCli(() => main(process.argv.slice(2)))
}
/* v8 ignore stop */
