/**
 * factory-verify-input — 解密階段輸入 bundle，還原到 `target/`（ADR-029 §5；V2 Task 6）。
 *
 * 背景：驗證流程分四個階段（grill → quint → lean → tests），每一階段都在新的
 * runner 上從目標 repo 的預設分支重新 checkout；上一階段的產出只以密文離開 runner
 * （`factory-verify-encrypt`）。aswf.dev（V3）把 G1 確認後的 `specs/quint/RULES.md`、
 * G2 的 `specs/quint/TRIAGE.md` 與上一階段的 `specs/**` 產出，以**同一格式**、用
 * **runner 公鑰**加密成階段輸入 bundle；factory-run 在 agent 之前以 repo secret
 * `VERIFY_RUNNER_AGE_IDENTITY`（runner 私鑰）解密並還原。兩組 keypair 分離：runner
 * 私鑰外洩只影響「進 runner 的輸入」，不影響已上傳的產出密文。
 *
 * 這是把外部輸入寫進 agent 工作區的唯一入口，所以規則是 allowlist、整份 fail closed：
 *   - 只接受 `kind: "target"`；任何 `mechanism` 行 → 整份拒絕（ruling R7：分流只看
 *     kind，不看路徑長相；階段輸入不該含機制檔，出現就代表產生端錯了或被動過）；
 *   - path 必須通過 `isVerifyAllowedPath`（驗證類白名單）或位於 `specs/**`；
 *   - 絕對路徑、反斜線、NUL、空／`.`／`..` segment、`.git` segment、`.factory/**`
 *     （run 目錄與 token 所在）、解析後落在 target 外 → 拒絕；
 *   - 寫入路徑上任何既有 segment 是 symlink（含目標檔本身）→ 拒絕：即使 symlink
 *     指向 target 內也一樣，經 symlink 的寫入讓「實際寫到哪裡」脫離上述字串檢查；
 *   - 重複路徑、或一個路徑是另一個的上層 → 拒絕（結果取決於寫入順序）。
 *
 * **先驗證全部、再寫**：任何一行不合規都在第一個寫入之前拋錯，target 保持原狀
 * （不會留下半套輸入讓 agent 在不完整的規格上工作）。已存在的檔案以 bundle 內容
 * 覆寫（上一輪留下的 RULES.md 必須被 G1 確認版取代）。
 *
 * 輸出只有還原**數量**：run log 是公開的，路徑本身（規格名稱、測試檔位置）就是
 * 目標 repo 的資訊。
 *
 * CLI（workflow 呼叫）：
 *   node dist/cli/factory-verify-input.js \
 *     --bundle "$RUNNER_TEMP/verify-input.age" \
 *     --identity-env VERIFY_RUNNER_AGE_IDENTITY --target target
 *
 * 私鑰以「env 變數名」傳入而非值：值不會出現在 argv（`ps`、錯誤訊息）裡。
 */
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { Decrypter } from 'age-encryption'
import { isVerifyAllowedPath } from '../pipeline/verify-scope.js'
import { isMainModule } from './is-main-module.js'
import { CliError, runCliAsync } from './run-cli.js'

export interface RestoreVerifyInputOptions {
  /** age 密文（JSON lines 明文，格式同 `factory-verify-encrypt`）。 */
  bundle: Uint8Array
  /** runner 的 age X25519 私鑰（`AGE-SECRET-KEY-1…`）。 */
  identity: string
  /** 目標 repo 的 checkout（workflow 中是 `target`）。 */
  targetDir: string
}

export interface RestoreVerifyInputResult {
  /** 實際還原的路徑（相對 target，排序後）。 */
  restored: string[]
}

/** 驗證通過、待寫入的一筆。 */
interface RestoreEntry {
  path: string
  bytes: Uint8Array
}

const IDENTITY_PREFIX = 'AGE-SECRET-KEY-1'
/** 標準 base64（`Buffer.from(…, 'base64')` 會靜默略過非法字元，故先嚴格比對）。 */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

function validateIdentity(identity: string): string {
  const key = identity.trim()
  if (!key.startsWith(IDENTITY_PREFIX)) {
    throw new CliError(
      'identity 必須是非空的 age X25519 私鑰（AGE-SECRET-KEY-1…）。缺 VERIFY_RUNNER_AGE_IDENTITY ' +
        '或值不合法時不得還原任何階段輸入（ADR-029 §5，fail closed）',
    )
  }
  return key
}

function resolveTargetDir(targetDir: string): string {
  let stats: Stats
  try {
    stats = statSync(targetDir)
  } catch {
    throw new CliError(`target 目錄不存在：${targetDir}`)
  }
  if (!stats.isDirectory()) throw new CliError(`target 不是目錄：${targetDir}`)
  return realpathSync(targetDir)
}

async function decryptBundle(bundle: Uint8Array, identity: string): Promise<string> {
  const decrypter = new Decrypter()
  decrypter.addIdentity(identity)
  let plaintext: Uint8Array
  try {
    plaintext = await decrypter.decrypt(bundle)
  } catch (error) {
    throw new CliError(`階段輸入 bundle 解密失敗（私鑰不符或密文損毀）：${(error as Error).message}`)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
  } catch {
    throw new CliError('階段輸入 bundle 解密後不是 UTF-8 的 JSON lines')
  }
}

/**
 * 單一 path 的字串層檢查（不碰檔案系統）。錯誤訊息不含 path 本身以外的內容；
 * path 只出現在拋錯時（CLI 失敗訊息），成功路徑上從不印出。
 */
function validatePath(path: string, lineNo: number): void {
  const where = `第 ${lineNo} 行`
  if (path === '') throw new CliError(`${where}：path 不得為空`)
  if (path.includes('\0')) throw new CliError(`${where}：path 含 NUL`)
  if (path.includes('\\')) throw new CliError(`${where}：path 含反斜線`)
  if (path.startsWith('/') || isAbsolute(path)) throw new CliError(`${where}：不接受絕對路徑`)
  const segments = path.split('/')
  if (segments.includes('..')) throw new CliError(`${where}：path 不得含 .. segment`)
  if (segments.some((segment) => segment === '' || segment === '.')) {
    throw new CliError(`${where}：path 含空或 . segment`)
  }
  if (segments.some((segment) => segment.toLowerCase() === '.git')) {
    throw new CliError(`${where}：不得寫入 .git（版本庫內部）`)
  }
  if (segments[0] === '.factory') throw new CliError(`${where}：不得寫入 .factory（run 目錄與 token 所在）`)
  if (!(isVerifyAllowedPath(path) || path.startsWith('specs/'))) {
    throw new CliError(`${where}：path 不在驗證白名單內（只收 specs/** 與測試檔）`)
  }
}

/** 解析並驗證一行；任何不合規都拋錯。 */
function parseLine(raw: string, lineNo: number): RestoreEntry {
  const where = `第 ${lineNo} 行`
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new CliError(`${where}：不是合法的 JSON`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CliError(`${where}：必須是 JSON 物件`)
  }
  const { kind, path, b64 } = value as Record<string, unknown>
  if (kind === 'mechanism') {
    throw new CliError(`${where}：kind=mechanism——階段輸入只接受 target 行（ruling R7），整份拒絕`)
  }
  if (kind !== 'target') throw new CliError(`${where}：kind 必須是 "target"`)
  if (typeof path !== 'string') throw new CliError(`${where}：path 必須是字串`)
  if (typeof b64 !== 'string' || !BASE64.test(b64)) throw new CliError(`${where}：b64 不是合法的 base64`)
  validatePath(path, lineNo)
  return { path, bytes: Buffer.from(b64, 'base64') }
}

/** 跨行檢查：重複路徑、或一個路徑是另一個的上層（寫入結果會取決於順序）。 */
function validateDistinct(entries: readonly RestoreEntry[]): void {
  const paths = new Set<string>()
  for (const { path } of entries) {
    if (paths.has(path)) throw new CliError('bundle 含重複路徑')
    paths.add(path)
  }
  for (const { path } of entries) {
    const segments = path.split('/')
    for (let i = 1; i < segments.length; i++) {
      if (paths.has(segments.slice(0, i).join('/'))) throw new CliError('bundle 內一個檔案路徑是另一個路徑的上層目錄')
    }
  }
}

function lstatIfExists(abs: string): Stats | null {
  try {
    return lstatSync(abs)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * 檔案系統層檢查：寫入路徑上的每一個既有 segment 都不得是 symlink；上層必須是
 * 目錄、目標（若存在）必須是一般檔案；解析後必須在 target 內。不存在的 segment
 * 之後由 mkdir 建立（建立的是真目錄，不會變成 symlink）。
 */
function validateOnDisk(target: string, path: string): string {
  const abs = resolve(target, path)
  if (!abs.startsWith(`${target}${sep}`)) throw new CliError('path 解析後落在 target 外')
  const segments = path.split('/')
  for (let i = 1; i <= segments.length; i++) {
    const rel = segments.slice(0, i).join('/')
    const stats = lstatIfExists(join(target, rel))
    if (stats === null) break
    if (stats.isSymbolicLink()) throw new CliError('寫入路徑經過 symlink：拒絕（ADR-029 §5，fail closed）')
    const isLast = i === segments.length
    if (!isLast && !stats.isDirectory()) throw new CliError('寫入路徑的上層不是目錄')
    if (isLast && !stats.isFile()) throw new CliError('寫入目標已存在且不是一般檔案')
  }
  return abs
}

/**
 * 寫一個檔案：`O_NOFOLLOW` 讓最後一段即使在驗證後被換成 symlink 也不跟隨（防禦性；
 * 這一步在 agent 之前執行，沒有並行的寫入者）。既有檔案截斷後覆寫。
 */
function writeEntry(abs: string, bytes: Uint8Array): void {
  mkdirSync(dirname(abs), { recursive: true })
  const fd = openSync(abs, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644)
  try {
    let offset = 0
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
  } finally {
    closeSync(fd)
  }
}

/**
 * 解密階段輸入 bundle 並還原到 targetDir。任何不合規 → 拋錯且不寫任何檔。
 */
export async function restoreVerifyInput(opts: RestoreVerifyInputOptions): Promise<RestoreVerifyInputResult> {
  const identity = validateIdentity(opts.identity)
  const target = resolveTargetDir(opts.targetDir)
  const text = await decryptBundle(opts.bundle, identity)
  const entries = text
    .split('\n')
    .map((raw, index) => ({ raw, lineNo: index + 1 }))
    .filter(({ raw }) => raw.trim() !== '')
    .map(({ raw, lineNo }) => parseLine(raw, lineNo))
  validateDistinct(entries)
  const planned = entries.map((entry) => ({ abs: validateOnDisk(target, entry.path), bytes: entry.bytes, path: entry.path }))
  for (const { abs, bytes } of planned) writeEntry(abs, bytes)
  return { restored: planned.map(({ path }) => path).sort() }
}

export interface VerifyInputCliOptions {
  bundleFile: string
  identityEnv: string
  targetDir: string
}

const FLAGS = {
  '--bundle': 'bundleFile',
  '--identity-env': 'identityEnv',
  '--target': 'targetDir',
} as const satisfies Record<string, keyof VerifyInputCliOptions>

export function parseArgs(argv: string[]): VerifyInputCliOptions {
  const values: Partial<VerifyInputCliOptions> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    const key = (FLAGS as Record<string, keyof VerifyInputCliOptions | undefined>)[arg]
    if (key === undefined) throw new CliError(`unknown argument: ${arg}`)
    const value = argv[++i]
    if (value === undefined || value.startsWith('--')) throw new CliError(`${arg} requires a value`)
    if (value.trim() === '') throw new CliError(`${arg} must not be empty`)
    values[key] = value
  }
  const { bundleFile, identityEnv, targetDir } = values
  if (bundleFile === undefined) throw new CliError('--bundle is required')
  if (identityEnv === undefined) throw new CliError('--identity-env is required')
  if (targetDir === undefined) throw new CliError('--target is required')
  return { bundleFile, identityEnv, targetDir }
}

/** CLI 主體：只回傳還原數量（stdout 進公開 run log，不印路徑）。 */
export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ restored: number }> {
  const { bundleFile, identityEnv, targetDir } = parseArgs(argv)
  const identity = env[identityEnv]
  if (identity === undefined || identity.trim() === '') {
    throw new CliError(`${identityEnv} 未設定：無法解密階段輸入（ADR-029 §5，fail closed）`)
  }
  const { restored } = await restoreVerifyInput({ bundle: readFileSync(bundleFile), identity, targetDir })
  return { restored: restored.length }
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  process.exitCode = await runCliAsync(() => main(process.argv.slice(2)))
}
/* v8 ignore stop */
