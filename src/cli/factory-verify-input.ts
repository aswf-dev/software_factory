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
 *   - path 必須通過 `isVerifyAllowedPath`（驗證類白名單；specs/** 亦由它放行，
 *     因此 `specs/.github/**` 這種含 `.github` segment 的路徑同樣被拒）；
 *   - 絕對路徑、反斜線、NUL、空／`.`／`..` segment、`.git` segment、`.factory/**`
 *     （run 目錄與 token 所在）、解析後落在 target 外 → 拒絕；
 *   - specs 樹內任何 `.lake/build/` 路徑（加密端不打包的建置快取）→ 拒絕，兩端一致；
 *   - path／segment 長度超過檔案系統上限（PATH_MAX 1024、NAME_MAX 255 bytes）→
 *     在寫入前拒絕（避免寫到一半才 ENAMETOOLONG，且 fs 錯誤不帶絕對路徑）；
 *   - 寫入路徑上任何既有 segment 是 symlink（含目標檔本身）→ 拒絕：即使 symlink
 *     指向 target 內也一樣，經 symlink 的寫入讓「實際寫到哪裡」脫離上述字串檢查；
 *   - 重複路徑、或一個路徑是另一個的上層 → 拒絕（結果取決於寫入順序）；
 *   - 空 bundle（零筆）→ 拒絕：階段 ≥2 不得在缺輸入下執行。
 *
 * **先驗證全部、再寫**：任何一行不合規都在第一個寫入之前拋錯，target 保持原狀
 * （不會留下半套輸入讓 agent 在不完整的規格上工作）。已存在的檔案以 bundle 內容
 * 覆寫（上一輪留下的 RULES.md 必須被 G1 確認版取代）。
 *
 * stdout 只有還原**數量**：run log 是公開的，路徑本身（規格名稱、測試檔位置）就是
 * 目標 repo 的資訊。另寫一份還原清單到 `--manifest`（預設
 * `.factory/verify-restored.json`，必須在 target 外）：crosscheck 用它把還原的
 * 輸入從 agent 的實際 diff 扣除（R13），並以清單裡的 sha256 機械驗證「還原輸入
 * 是唯讀的」（R15）。因此清單是
 * `{ "restored": [ { "path": "<相對 target>", "sha256": "<hex>" } ] }`（依 path
 * 排序），雜湊取自**實際寫入的位元組**；清單不進加密 bundle、不上傳 artifact。
 *
 * 舊版的 `{ "restored": ["<path>"] }` 形狀沒有雜湊，agent 改動或刪除還原輸入後
 * crosscheck 仍會通過——那是唯一的機械防線。crosscheck 因此直接拒絕舊形狀，不做
 * 靜默升級（清單由本 CLI 與 crosscheck 同一個 job 產生／消費，兩者必須同步）。
 *
 * CLI（workflow 呼叫）：
 *   node dist/cli/factory-verify-input.js \
 *     --bundle "$RUNNER_TEMP/verify-input.age" \
 *     --identity-env VERIFY_RUNNER_AGE_IDENTITY --target target \
 *     --manifest .factory/verify-restored.json
 *
 * 私鑰以「env 變數名」傳入而非值：值不會出現在 argv（`ps`、錯誤訊息）裡。
 */
import { createHash } from 'node:crypto'
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeFileSync, writeSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { Decrypter } from 'age-encryption'
import { isVerifyAllowedPath } from '../pipeline/verify-scope.js'
import { isLakeBuildArtifact } from './factory-verify-encrypt.js'
import { isMainModule } from './is-main-module.js'
import { CliError, runCliAsync } from './run-cli.js'

export interface RestoreVerifyInputOptions {
  /** age 密文（JSON lines 明文，格式同 `factory-verify-encrypt`）。 */
  bundle: Uint8Array
  /** runner 的 age X25519 私鑰（`AGE-SECRET-KEY-1…`）。 */
  identity: string
  /** 目標 repo 的 checkout（workflow 中是 `target`）。 */
  targetDir: string
  /**
   * 還原清單的輸出路徑（workflow 傳 `.factory/verify-restored.json`）。內容是
   * `{ "restored": [ { "path", "sha256" } ] }`（R13、R15）。必須在 `target/` 外：
   * 它不是 agent 工作區的一部分，也不進加密 bundle。省略時不寫。
   */
  manifestPath?: string
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

/** 還原清單的一筆：相對 target 的路徑，以及實際寫入位元組的 sha256（hex）。 */
interface RestoredManifestEntry {
  path: string
  sha256: string
}

const IDENTITY_PREFIX = 'AGE-SECRET-KEY-1'
/** 標準 base64（`Buffer.from(…, 'base64')` 會靜默略過非法字元，故先嚴格比對）。 */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
/**
 * 檔案系統上限（bytes）。`NAME_MAX` 在 Linux／macOS 都是 255；`PATH_MAX` 在
 * macOS（APFS）是 1024、Linux 是 4096——取兩者較小值，讓 dev 與 CI 的 fail-closed
 * 行為一致（較保守的上限只會提早拒絕極端路徑，不會放行逾限路徑）。
 */
const MAX_SEGMENT_BYTES = 255
const MAX_PATH_BYTES = 1024

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

/**
 * 取絕對路徑的實體位置：不存在的尾端先剝掉，對最近的既有祖先做 realpath，再把
 * 尾端接回去。macOS 的 `/var` → `/private/var` 這類系統 symlink 會讓字串比較
 * 誤判「manifest 在 target 外」；以實體路徑比較才可靠。
 */
function canonicalPath(abs: string): string {
  const missing: string[] = []
  let current = abs
  // 根目錄一定存在，迴圈必會終止。
  while (!existsSync(current)) {
    missing.unshift(basename(current))
    current = dirname(current)
  }
  return join(realpathSync(current), ...missing)
}

function resolveTargetDir(targetDir: string): string {
  let stats: Stats
  try {
    stats = statSync(targetDir)
  } catch {
    throw new CliError('target 目錄不存在或不可讀（fail closed）')
  }
  if (!stats.isDirectory()) throw new CliError('target 不是目錄（fail closed）')
  /* v8 ignore start -- stat 後 realpath 只因 TOCTOU 失敗；無法穩定重現，仍須去識別化 */
  try {
    return realpathSync(targetDir)
  } catch {
    // 不轉述底層錯誤：ENOENT／EACCES 的訊息會帶出絕對路徑（公開 run log）。
    throw new CliError('target 路徑無法解析（fail closed）')
  }
  /* v8 ignore stop */
}

async function decryptBundle(bundle: Uint8Array, identity: string): Promise<string> {
  let plaintext: Uint8Array
  try {
    const decrypter = new Decrypter()
    // addIdentity **必須**在這個 try 內：@scure/base 的 bech32 解碼器在 checksum
    // 錯時把整把金鑰插進錯誤訊息（"Invalid checksum in AGE-SECRET-KEY-1…"）。
    // run log 是公開的，任何底層錯誤都不能轉述。
    decrypter.addIdentity(identity)
    plaintext = await decrypter.decrypt(bundle)
  } catch {
    throw new CliError(
      '階段輸入 bundle 解密失敗（私鑰不符或密文損毀）；不轉述底層錯誤（可能含私鑰內容）' +
        '——ADR-029 §5，fail closed',
    )
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
  // 長度在寫入前檢查：逐檔寫入時才由檔案系統回 ENAMETOOLONG 會留下半套輸入
  // （且錯誤訊息帶絕對路徑）。上限對「相對路徑」與「每個 segment」各檢查一次，
  // 絕對路徑再於 validateOnDisk 以 target 實際長度檢查。
  if (Buffer.byteLength(path, 'utf8') > MAX_PATH_BYTES) {
    throw new CliError(`${where}：path 過長（超過 ${MAX_PATH_BYTES} bytes）`)
  }
  for (const segment of segments) {
    if (Buffer.byteLength(segment, 'utf8') > MAX_SEGMENT_BYTES) {
      throw new CliError(`${where}：path 的 segment 過長（超過 ${MAX_SEGMENT_BYTES} bytes）`)
    }
  }
  if (isLakeBuildArtifact(path)) {
    throw new CliError(
      `${where}：path 位於 .lake/build（可重建的建置快取）——加密端不打包，還原端也拒絕（ADR-029 §5）`,
    )
  }
  if (!isVerifyAllowedPath(path)) {
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

/** 檔案系統錯誤只帶相對路徑與 errno code（公開 run log 不揭露 workspace 絕對路徑）。 */
function fsFailure(rel: string, error: unknown): CliError {
  return new CliError(`還原 ${rel} 時發生檔案系統錯誤（${String((error as NodeJS.ErrnoException).code)}）`)
}

function lstatIfExists(abs: string, rel: string): Stats | null {
  try {
    return lstatSync(abs)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new CliError(
      `檢查 ${rel} 的檔案狀態時發生檔案系統錯誤（${String((error as NodeJS.ErrnoException).code)}）`,
    )
  }
}

/**
 * 檔案系統層檢查：寫入路徑上的每一個既有 segment 都不得是 symlink；上層必須是
 * 目錄、目標（若存在）必須是一般檔案；解析後必須在 target 內。不存在的 segment
 * 之後由 mkdir 建立（建立的是真目錄，不會變成 symlink）。
 */
function validateOnDisk(target: string, path: string): string {
  const abs = resolve(target, path)
  /* v8 ignore next -- validatePath 已保證相對、無 ..，此檢查是 defense in depth */
  if (!abs.startsWith(`${target}${sep}`)) throw new CliError('path 解析後落在 target 外')
  // 檔案系統限制的是含 target 的絕對路徑；相對路徑在 validatePath 已檢查過。
  if (Buffer.byteLength(abs, 'utf8') > MAX_PATH_BYTES) {
    throw new CliError(`path 含 target 的絕對路徑過長（超過 ${MAX_PATH_BYTES} bytes）`)
  }
  const segments = path.split('/')
  for (let i = 1; i <= segments.length; i++) {
    const rel = segments.slice(0, i).join('/')
    const stats = lstatIfExists(join(target, rel), rel)
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
function writeEntry(abs: string, bytes: Uint8Array, path: string): void {
  try {
    mkdirSync(dirname(abs), { recursive: true })
    const fd = openSync(abs, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644)
    try {
      let offset = 0
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    // mkdir／open／write 的原始錯誤都帶絕對路徑；只留相對路徑與 errno。
    throw fsFailure(path, error)
  }
}

/** 還原清單用的雜湊：與 crosscheck 重算磁碟位元組的演算法一致（sha256、hex、小寫）。 */
function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 把還原清單寫到 target 外；寫不出來就 fail closed（agent 不得在缺 manifest 下執行）。
 *
 * 格式固定為 `{ "restored": [ { "path", "sha256" }, … ] }`（呼叫端已依 path 排序）：
 * crosscheck 以此雜湊斷定還原輸入未被 agent 動過（R15），所以雜湊必須是**寫入磁碟
 * 的位元組**的 sha256，而不是 bundle 內 base64 字串的雜湊。
 */
function writeManifest(abs: string, restored: readonly RestoredManifestEntry[]): void {
  try {
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, `${JSON.stringify({ restored }, null, 2)}\n`)
  } catch (error) {
    throw new CliError(
      `無法寫入還原清單（${String((error as NodeJS.ErrnoException).code)}）——拒絕在缺 manifest 的情況下執行 agent`,
    )
  }
}

/**
 * 解密階段輸入 bundle 並還原到 targetDir。任何不合規 → 拋錯且不寫任何檔。
 */
export async function restoreVerifyInput(opts: RestoreVerifyInputOptions): Promise<RestoreVerifyInputResult> {
  const identity = validateIdentity(opts.identity)
  const target = resolveTargetDir(opts.targetDir)
  const manifest = opts.manifestPath === undefined ? null : resolve(opts.manifestPath)
  if (manifest !== null) {
    let real: string
    /* v8 ignore start -- 只有 exists 與 realpath 之間的 TOCTOU 會失敗 */
    try {
      real = canonicalPath(manifest)
    } catch {
      throw new CliError('還原清單（manifest）路徑無法解析（fail closed）')
    }
    /* v8 ignore stop */
    if (real === target || real.startsWith(`${target}${sep}`)) {
      throw new CliError('還原清單（manifest）必須在 target 外——它不是 agent 工作區的一部分')
    }
  }
  const text = await decryptBundle(opts.bundle, identity)
  const entries = text
    .split('\n')
    .map((raw, index) => ({ raw, lineNo: index + 1 }))
    .filter(({ raw }) => raw.trim() !== '')
    .map(({ raw, lineNo }) => parseLine(raw, lineNo))
  // 空 bundle 不是「0 個輸入」而是「產生端壞了」：階段 ≥2 若照跑，agent 會在缺
  // RULES.md／TRIAGE.md 的情況下工作，且沒有任何訊號。fail closed。
  if (entries.length === 0) {
    throw new CliError('階段輸入 bundle 沒有任何檔案——拒絕還原（fail closed，階段 ≥2 不得在缺輸入下執行）')
  }
  validateDistinct(entries)
  const planned = entries.map((entry) => ({ abs: validateOnDisk(target, entry.path), bytes: entry.bytes, path: entry.path }))
  // 雜湊只從「真正交給 writeEntry 的位元組」算：manifest 是 crosscheck 判斷還原
  // 輸入是否被動過的唯一依據（R15），不能取自 bundle 的 base64 或正規化後的文字。
  const restored: RestoredManifestEntry[] = []
  for (const { abs, bytes, path } of planned) {
    writeEntry(abs, bytes, path)
    restored.push({ path, sha256: sha256Hex(bytes) })
  }
  // validateDistinct 已保證路徑互異，比較器不需要（也不可能）回傳 0。
  restored.sort((a, b) => (a.path < b.path ? -1 : 1))
  if (manifest !== null) writeManifest(manifest, restored)
  return { restored: restored.map(({ path }) => path) }
}

/** 預設的還原清單路徑（相對 cwd，即 workflow 的 `$GITHUB_WORKSPACE`；在 target 外）。 */
export const DEFAULT_MANIFEST_FILE = '.factory/verify-restored.json'

export interface VerifyInputCliOptions {
  bundleFile: string
  identityEnv: string
  targetDir: string
  /** 還原清單輸出（`--manifest`，預設 {@link DEFAULT_MANIFEST_FILE}）。 */
  manifestFile: string
}

const FLAGS = {
  '--bundle': 'bundleFile',
  '--identity-env': 'identityEnv',
  '--target': 'targetDir',
  '--manifest': 'manifestFile',
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
  const { bundleFile, identityEnv, targetDir, manifestFile } = values
  if (bundleFile === undefined) throw new CliError('--bundle is required')
  if (identityEnv === undefined) throw new CliError('--identity-env is required')
  if (targetDir === undefined) throw new CliError('--target is required')
  return { bundleFile, identityEnv, targetDir, manifestFile: manifestFile ?? DEFAULT_MANIFEST_FILE }
}

/** CLI 主體：只回傳還原數量（stdout 進公開 run log，不印路徑）。 */
export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ restored: number }> {
  const { bundleFile, identityEnv, targetDir, manifestFile } = parseArgs(argv)
  const identity = env[identityEnv]
  if (identity === undefined || identity.trim() === '') {
    throw new CliError(`${identityEnv} 未設定：無法解密階段輸入（ADR-029 §5，fail closed）`)
  }
  let bundle: Uint8Array
  try {
    bundle = readFileSync(bundleFile)
  } catch {
    // ENOENT 的原始訊息帶 RUNNER_TEMP 絕對路徑（公開 run log）。
    throw new CliError('無法讀取階段輸入 bundle（檔案不存在或不可讀；fail closed）')
  }
  const { restored } = await restoreVerifyInput({ bundle, identity, targetDir, manifestPath: manifestFile })
  return { restored: restored.length }
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  process.exitCode = await runCliAsync(() => main(process.argv.slice(2)))
}
/* v8 ignore stop */
