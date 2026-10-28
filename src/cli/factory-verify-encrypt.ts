/**
 * factory-verify-encrypt — 把驗證類 run 的產出打包成單一 age 密文（ADR-029 §5）。
 *
 * 背景：`factory-run` 在公開的機制 repo 執行，`target/.factory/run/` 的 artifact
 * 任何登入 GitHub 的人都下載得到；驗證類的產出（agent stdout、specs、測試檔）
 * 可能包含尚未修補的缺陷與目標 repo 的程式碼。因此驗證類**只上傳密文**：
 * 公鑰來自 repo secret `VERIFY_AGE_PUBLIC_KEY`，私鑰只存在 Worker；缺公鑰時
 * fail closed（workflow 的加密步驟直接失敗，絕不回退明文上傳）。
 *
 * Bundle 範圍（plan Task 3「擴大」版，controller 裁決）：
 *   - `target/.factory/run/**`（排除 `gh-token`，那是 1 小時有效的 App token）
 *   - `target/specs/**`（dot files 也帶；排除 `.lake/build/` 建置快取）
 *   - agent 改動／新增、且落在驗證白名單的測試檔
 *
 * 後兩者保留「相對 target 的路徑」——下一個階段（Task 6）解密後要直接還原到
 * `target/` 下，路徑若被壓平或加上前綴，階段串接就會缺檔。
 *
 * 另外，`--mechanism-dir`（workflow 傳 `$GITHUB_WORKSPACE/.factory`）下的機制檔
 * （`VERIFY_MECHANISM_FILES`：issue body、crosscheck 檔案清單、model 等）以
 * `kind: "mechanism"`＋**裸檔名**進 bundle。`issue.json`／`crosscheck.json` 含目標
 * 內容；`model.json`／`verify-mode.json` 只有 tier／旗標（不含目標內容），仍一併
 * 隨 bundle 走（Worker 需要）。驗證模式**不再明文上傳**這些機制檔；明文 artifact
 * 只剩 bundle 與無內容診斷（steps.json／session-diag.json）。
 *
 * 來源只由 `kind` 欄位決定（ruling R7），不靠路徑前綴：前綴慣例要求每個讀取端都
 * 正確實作同一條字串規則，任何一端寫錯就會把機制檔當成 target 檔還原（或反之）。
 * 因此本模組不匯出任何前綴常數；階段輸入的還原端（`factory-verify-input`）只接受
 * `kind: "target"`，看到 `mechanism` 行就整份拒絕。
 *
 * 根目錄（`specs`、`.factory/run`）本身是 symlink、或解析後落在 target 外時一律
 * 拋錯（fail closed）——`readdir` 會跟隨根的 symlink，把 runner 上任意目錄打包。
 * 根不存在（agent 失敗前）則略過；其他 I/O 錯誤照樣往外拋。
 *
 * 格式：age（X25519 recipient）密文，明文是 JSON lines，每行
 * `{"kind":"target"|"mechanism","path":"…","b64":"<原始位元組的 base64>"}`；
 * `target` 的 path 相對 `target/`，`mechanism` 的 path 是機制檔名。base64 而非
 * UTF-8：specs 可能有任意二進位內容（ITF trace、olean 等），文字編碼會壞掉。
 * 整個 payload 在記憶體組好才加密、只寫最終密文，避免任何明文側檔。
 *
 * 為什麼測試檔要經 git 過濾：agent 可以只改少數測試檔，但目標 repo 其他測試檔
 * 不該進 bundle（體積與外洩面都變大）。事實來源是 `git diff`（含本地 commit）
 * ＋ untracked 清單，與 `factory-crosscheck --verify-only` 相同；基準優先取
 * `origin/<base>`（本地分支可能已被 agent 的 commit 推進），再退回 `HEAD`。
 * 若 target 不是 git repo（單元測試、非 git 目標），無法得知「改動」，
 * 退回掃描全部白名單檔案——bundle 本身是密文，寧可多帶也不讓下一階段缺檔。
 *
 * **不可變基準**（`--base-sha`，R19／C2）：分支名終究是可移動的——agent 依 R2
 * 可以本地 commit，`origin/<base>` 在驗證模式的 checkout 也不一定存在。workflow
 * 在 agent 之前把 HEAD 寫進 target 外的 `.factory/base-sha`，本 CLI 以
 * `--base-sha <40-hex>` 使用該 commit；形狀不合或解析不到一律 fail closed。
 *
 * CLI（workflow 呼叫）：
 *   node dist/cli/factory-verify-encrypt.js \
 *     --target target --out .factory/verify-bundle.age \
 *     --recipient "$VERIFY_AGE_PUBLIC_KEY" --mechanism-dir .factory \
 *     --base-sha "$VERIFY_BASE_SHA"
 */
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Encrypter } from 'age-encryption'
import { isVerifyAllowedPath } from '../pipeline/verify-scope.js'
import { isMainModule } from './is-main-module.js'
import { CliError, runCliAsync } from './run-cli.js'

/** run 產出的目錄（相對 target）。 */
const RUN_DIR = '.factory/run'
/** specs 樹（相對 target）。 */
const SPECS_DIR = 'specs'
/** App installation token；1 小時內有效，絕不進 90 天保存的 artifact。 */
const GH_TOKEN_PATH = `${RUN_DIR}/gh-token`
/**
 * 進 bundle 的機制檔（相對 mechanism dir）：Worker 需要的 run metadata。
 * `issue.json`／`crosscheck.json` 含目標內容（Issue body、檔案清單），故只走密文；
 * `model.json`／`verify-mode.json` 本身只有 tier／旗標（不含目標內容），仍一併隨
 * bundle 走。不在清單內的（scoreboard-event／pr-bodies／舊的 verify-bundle.age…）
 * 一律不帶；steps.json／session-diag.json 無內容、走明文 artifact，也不重複放進來。
 */
export const VERIFY_MECHANISM_FILES = [
  'crosscheck.err',
  'crosscheck.json',
  'issue.json',
  'judge.json',
  'model.json',
  'verify-mode.json',
] as const
/** bundle 每一行的來源（ruling R7）：讀取端只依此分流，不看路徑長相。 */
export type BundleKind = 'target' | 'mechanism'
/** 掃描測試檔時不進的目錄：版本庫、依賴、factory 內部檔與已另行處理的 specs。 */
const SKIP_DIR_NAMES: ReadonlySet<string> = new Set(['.git', 'node_modules', '.factory', 'specs'])

export interface EncryptVerifyBundleOptions {
  /** 目標 repo 的 checkout（workflow 中是 `target`）。 */
  targetDir: string
  /** 輸出密文路徑；父目錄不存在時會建立。 */
  outFile: string
  /** age X25519 公鑰（`age1…`）。 */
  recipient: string
  /** 機制檔所在目錄（workflow 中是 `$GITHUB_WORKSPACE/.factory`）；省略時不帶機制檔。 */
  mechanismDir?: string
  /**
   * agent 啟動前的 HEAD（R19）：已知時以這個不可變 commit 為 diff 基準，
   * 完全忽略 base-branch 檔與分支名。非 40-hex 或解析不到 commit → fail closed。
   */
  baseSha?: string | undefined
}

export interface EncryptVerifyBundleResult {
  /** 實際打包的檔案（相對 target，排序後）。 */
  files: string[]
  /** 實際打包的機制檔名（`kind: "mechanism"` 行的 path，排序後）。 */
  mechanism: string[]
}

/**
 * 判斷單一路徑是否進 bundle。
 *
 * 這是 target 路徑進 bundle 的**唯一**決策點：run 目錄全收（gh-token 除外）、specs
 * 全收（`.lake/build/` 除外）、其餘只收驗證白名單的測試檔。target `.factory/` 下非
 * run 的檔案不進 bundle；workflow 的機制 metadata（在 `$GITHUB_WORKSPACE/.factory`，
 * 不在 target 下）另由 `collectMechanismEntries` 以 `kind: "mechanism"` 收進來。
 */
function isBundlePath(rel: string): boolean {
  if (rel === GH_TOKEN_PATH) return false
  if (isLakeBuildArtifact(rel)) return false
  if (rel.startsWith('.factory/')) return rel.startsWith(`${RUN_DIR}/`)
  // specs/** 也由同一個 predicate 放行（C1：`.github` segment 一律拒絕，
  // 所以不能再以 `specs/` 前綴繞過白名單）。
  return isVerifyAllowedPath(rel)
}

/**
 * `specs/lean/.lake/build/**` 之類的建置快取：可重建、體積大、不是 agent 的交付。
 * 還原端（`factory-verify-input`）也用這個 predicate 拒絕同一批路徑，兩端不得漂移。
 */
export function isLakeBuildArtifact(rel: string): boolean {
  const segments = rel.split('/')
  return segments.some((segment, i) => segment === '.lake' && segments[i + 1] === 'build')
}

/**
 * 遞迴列出 root/relDir 下的檔案（相對 root）。呼叫端先以 `isScannableRoot` 確認根
 * 存在且不是 symlink（不存在的根在那裡略過）；這裡的任何 I/O 錯誤（例如 `specs`
 * 不是目錄、權限不足）一律往外拋——打包不完整比 abort 更危險，下一階段會拿到
 * 缺檔的規格卻無從得知。
 * 子項的 symlink 不跟隨（避免把 target 外的路徑打包進來），其他特殊檔一律略過。
 */
function walkFiles(root: string, relDir: string, skipDir: (rel: string) => boolean): string[] {
  let entries
  try {
    entries = readdirSync(join(root, relDir), { withFileTypes: true })
  } catch (error) {
    /* v8 ignore next -- relDir='' 只可能是 target 根在 readdir 前消失的 race；標籤用 target 而非空字串 */
    throw fsFailure('列出', relDir === '' ? 'target' : relDir, error)
  }
  const files: string[] = []
  for (const entry of entries) {
    const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`
    if (entry.isDirectory()) {
      if (!skipDir(rel)) files.push(...walkFiles(root, rel, skipDir))
    } else if (entry.isFile()) {
      files.push(rel)
    }
  }
  return files
}

/** 非 git 目標的退路：掃描整個 target，只留下白名單檔案（不進 .git／node_modules／.factory）。 */
function collectAllBundlePaths(root: string): string[] {
  return walkFiles(root, '', (rel) => SKIP_DIR_NAMES.has(rel.slice(rel.lastIndexOf('/') + 1))).filter(isBundlePath)
}

function runGit(targetDir: string, args: string[]): string {
  return execFileSync('git', ['-C', targetDir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

function tryGit(targetDir: string, args: string[]): string | null {
  try {
    return runGit(targetDir, args)
  } catch {
    return null
  }
}

function splitNul(output: string): string[] {
  return output.split('\0').filter((path) => path !== '')
}

/** target 是否為 git 工作區；不是（或 git 不可用）時回 false，由呼叫端走掃描退路。 */
function isGitWorkTree(targetDir: string): boolean {
  return tryGit(targetDir, ['rev-parse', '--is-inside-work-tree']) !== null
}

/** 讀 workflow 寫入的 base branch（`target/.factory/run/base-branch`）；沒有就 undefined。 */
function readBaseBranch(targetDir: string): string | undefined {
  try {
    const value = readFileSync(join(targetDir, RUN_DIR, 'base-branch'), 'utf8').trim()
    return value === '' ? undefined : value
  } catch {
    return undefined
  }
}

/**
 * 找出可用的 base ref。優先 `origin/<base>`：actions/checkout 會建立
 * remote-tracking ref，而本地 `<base>` 分支可能已被 agent 的本地 commit 推進，
 * 對它 diff 會得到空集合（漏掉 agent 的全部交付）。
 */
function resolveBaseRef(targetDir: string, base: string): string | null {
  for (const ref of [`origin/${base}`, base]) {
    if (tryGit(targetDir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== null) return ref
  }
  return null
}

/** `--base-sha` 的格式（R19）：完整 40 位 hex；分支名／簡短 SHA 一律拒絕。 */
const BASE_SHA_HEX = /^[0-9a-f]{40}$/i

/** 驗證並正規化 `--base-sha`；格式不合即 fail closed（不得退回分支名）。 */
export function normalizeBaseSha(value: string): string {
  const sha = value.trim().toLowerCase()
  if (!BASE_SHA_HEX.test(sha)) {
    throw new CliError(
      `--base-sha 必須是完整的 40-hex commit（40 位十六進位；收到「${value}」）——` +
        'bundle 的「agent 改動」必須以 agent 啟動前的 HEAD 為基準（R19）',
    )
  }
  return sha
}

/** 確認 `--base-sha` 解析得到 commit；不是 git 工作區或不存在 → fail closed。 */
function resolveBaseSha(targetDir: string, sha: string): string {
  const resolved = tryGit(targetDir, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`])
  if (resolved === null || resolved.trim() === '') {
    throw new CliError(
      `--base-sha ${sha} 在此 repo 解析不到 commit——拒絕以分支名或 HEAD 替代（R19，fail closed）`,
    )
  }
  return resolved.trim()
}

/**
 * agent 改動／新增的路徑（含本地 commit 與未追蹤檔）。
 *
 * - 非 git 工作區 → null（呼叫端改掃描全部白名單檔案，寧可多帶不可缺檔）。
 * - 空 repo（尚無 HEAD）→ null（同上）。
 * - 其餘 → `git diff <base>` ∪ `git ls-files --others`；`--diff-filter=ACMR`
 *   排除刪除，`-z` 避免檔名含空白／引號時被 git 加引號而比對失敗。
 *
 * `baseSha` 有值時（R19／C2）先驗形狀與可解析性，再以該 commit 為唯一基準：
 * base-branch 檔與 `origin/<base>` 都不參與。不是 git 工作區卻帶了 baseSha
 * → fail closed（無法驗證「不可變」的主張，不默默退回掃描全部）。
 */
function changedPaths(targetDir: string, baseSha?: string): Set<string> | null {
  const resolvedBaseSha = baseSha === undefined ? undefined : resolveBaseSha(targetDir, normalizeBaseSha(baseSha))
  if (!isGitWorkTree(targetDir)) return null
  let baseRef: string | null
  if (resolvedBaseSha !== undefined) {
    baseRef = resolvedBaseSha
  } else {
    const base = readBaseBranch(targetDir)
    baseRef = base === undefined ? null : resolveBaseRef(targetDir, base)
  }
  const diff = tryGit(targetDir, ['diff', '--name-only', '--diff-filter=ACMR', '-z', baseRef ?? 'HEAD'])
  if (diff === null) return null
  const paths = new Set<string>(splitNul(diff))
  for (const path of splitNul(runGit(targetDir, ['ls-files', '--others', '--exclude-standard', '-z']))) {
    paths.add(path)
  }
  return paths
}

const neverSkip = (): boolean => false

/**
 * 檔案系統錯誤只帶相對路徑與 errno code（公開 run log 不揭露 workspace 絕對路徑；
 * Node 的 ENOENT／EACCES 訊息會把絕對 target 路徑整串印出來）。與
 * `factory-verify-input` 的 fsFailure 同語意，兩支 CLI 的還原／打包錯誤都不得轉述
 * 底層訊息。
 */
function fsFailure(action: string, rel: string, error: unknown): CliError {
  return new CliError(`${action} ${rel} 時發生檔案系統錯誤（${String((error as NodeJS.ErrnoException).code)}）`)
}

/** `lstat`，只有 ENOENT 回 null（路徑不存在）；其他錯誤（ENOTDIR、EACCES…）往外拋。 */
function lstatIfExists(abs: string, rel: string): Stats | null {
  try {
    return lstatSync(abs)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw fsFailure('檢查', rel, error)
  }
}

/**
 * 根目錄（相對 target）是否可掃描。不存在 → false（略過）；本身是 symlink、或任一
 * 上層 segment 經 symlink 使它解析到別處（`target/.factory` → target 外）→ 拋錯。
 * 以 realpath 與「target 的 realpath ＋ rel」逐字比對，任何一段 symlink 都會不等。
 */
function isScannableRoot(targetDir: string, rel: string): boolean {
  const abs = join(targetDir, rel)
  const stats = lstatIfExists(abs, rel)
  if (stats === null) return false
  if (stats.isSymbolicLink()) {
    throw new CliError(`${rel} 是 symlink：驗證 bundle 不跟隨根目錄的 symlink（ADR-029 §5，fail closed）`)
  }
  /* v8 ignore start -- lstat 已成功；realpath 只因 TOCTOU（並行刪除／換 link）失敗，無法穩定重現，仍須去識別化 */
  let resolvedAbs: string
  let resolvedTarget: string
  try {
    resolvedAbs = realpathSync(abs)
    resolvedTarget = realpathSync(targetDir)
  } catch (error) {
    throw fsFailure('解析', rel, error)
  }
  /* v8 ignore stop */
  if (resolvedAbs !== join(resolvedTarget, rel)) {
    throw new CliError(`${rel} 經 symlink 解析到 target 外：驗證 bundle 拒絕打包（ADR-029 §5，fail closed）`)
  }
  return true
}

/**
 * 收集 bundle 內的路徑（相對 target，排序）。只回傳實際存在的 regular file；
 * symlink 不跟隨（`lstat`），避免把 target 外的內容打包。不存在的路徑（ENOENT）
 * 直接跳過（git 事實與檔案系統之間可能有 race），但其他 I/O 錯誤會往外拋——
 * 打包不完整比 abort 更危險（下一階段會拿到缺檔的規格）。
 */
function collectBundlePaths(targetDir: string, baseSha?: string): string[] {
  const files = new Set<string>()
  const add = (rel: string): void => {
    if (!isBundlePath(rel)) return
    if (lstatIfExists(join(targetDir, rel), rel)?.isFile() !== true) return
    files.add(rel)
  }
  for (const root of [RUN_DIR, SPECS_DIR]) {
    if (!isScannableRoot(targetDir, root)) continue
    for (const rel of walkFiles(targetDir, root, neverSkip)) add(rel)
  }
  for (const rel of changedPaths(targetDir, baseSha) ?? collectAllBundlePaths(targetDir)) add(rel)
  return [...files].sort()
}

/** bundle 的一筆：來源、bundle 內路徑與來源檔的絕對路徑。 */
interface BundleEntry {
  kind: BundleKind
  path: string
  abs: string
}

/**
 * 收集機制檔（依 `VERIFY_MECHANISM_FILES` 的字母序，即 bundle 路徑排序）。不存在（例如驗證模式沒有
 * judge.json）→ 略過；存在但不是 regular file（symlink 等）→ 拋錯：機制目錄由
 * workflow 寫入，出現 symlink 代表被動過，不得把它指向的任意檔案帶進 bundle。
 */
function collectMechanismEntries(mechanismDir: string | undefined): BundleEntry[] {
  if (mechanismDir === undefined) return []
  const dir = resolve(mechanismDir)
  const entries: BundleEntry[] = []
  for (const name of VERIFY_MECHANISM_FILES) {
    const abs = join(dir, name)
    const stats = lstatIfExists(abs, name)
    if (stats === null) continue
    if (!stats.isFile()) {
      throw new CliError(`機制檔 ${name} 不是一般檔案（symlink？）：拒絕打包（ADR-029 §5，fail closed）`)
    }
    entries.push({ kind: 'mechanism', path: name, abs })
  }
  return entries
}

/**
 * 把檔案讀成 JSON lines 明文（記憶體組完才加密，不落任何明文側檔）。
 *
 * 讀檔失敗（列出與讀取之間的 race，或權限不足）→ CliError 只帶 bundle 內的相對
 * 路徑與 errno；Node 的原始訊息會印出 runner 上的絕對 target 路徑。
 */
function serializeBundle(entries: readonly BundleEntry[]): Buffer {
  const lines = entries.map(({ kind, path, abs }) => {
    let bytes: Buffer
    try {
      bytes = readFileSync(abs)
    } catch (error) {
      throw fsFailure('讀取', path, error)
    }
    return JSON.stringify({ kind, path, b64: bytes.toString('base64') })
  })
  return Buffer.from(lines.map((line) => `${line}\n`).join(''), 'utf8')
}

function validateRecipient(recipient: string): string {
  const key = recipient.trim()
  if (key === '' || !key.startsWith('age1')) {
    throw new CliError(
      'recipient 必須是非空的 age X25519 公鑰（age1…）。缺 VERIFY_AGE_PUBLIC_KEY 或值不合法時' +
        '不得產生 bundle——驗證模式拒絕任何明文 fallback（ADR-029 §5，fail closed）',
    )
  }
  return key
}

function resolveTargetDir(targetDir: string): string {
  const target = resolve(targetDir)
  let stats
  try {
    stats = statSync(target)
  } catch {
    // 不轉述底層訊息，也不回印傳入路徑：workflow 傳的是絕對路徑，run log 是公開的。
    throw new CliError('target 目錄不存在（fail closed）')
  }
  if (!stats.isDirectory()) throw new CliError('target 不是目錄（fail closed）')
  return target
}

/**
 * 把驗證類產出打包並以 age 公鑰加密到 outFile。
 *
 * Fail closed：recipient 空白或不是 `age1…` 時在**任何寫入之前**拋錯，因此不會
 * 產生輸出檔（含父目錄）；加密失敗同理，只有 `encrypt()` 成功後才寫密文。
 */
export async function encryptVerifyBundle(
  opts: EncryptVerifyBundleOptions,
): Promise<EncryptVerifyBundleResult> {
  const key = validateRecipient(opts.recipient)
  const targetDir = resolveTargetDir(opts.targetDir)
  // R19：先驗 base-sha（形狀＋可解析性）才掃描；任何寫入都還沒發生，失敗即不產出。
  const baseSha = opts.baseSha === undefined ? undefined : normalizeBaseSha(opts.baseSha)
  const files = collectBundlePaths(targetDir, baseSha)
  const mechanism = collectMechanismEntries(opts.mechanismDir)
  const targetEntries = files.map((rel): BundleEntry => ({ kind: 'target', path: rel, abs: join(targetDir, rel) }))
  const payload = serializeBundle([...targetEntries, ...mechanism])
  const encrypter = new Encrypter()
  encrypter.addRecipient(key)
  const ciphertext = await encrypter.encrypt(payload)
  const outFile = resolve(opts.outFile)
  mkdirSync(dirname(outFile), { recursive: true })
  writeFileSync(outFile, ciphertext)
  return { files, mechanism: mechanism.map((entry) => entry.path) }
}

const FLAGS = {
  '--target': 'targetDir',
  '--out': 'outFile',
  '--recipient': 'recipient',
  '--mechanism-dir': 'mechanismDir',
  '--base-sha': 'baseSha',
} as const satisfies Record<string, keyof EncryptVerifyBundleOptions>

/**
 * 解析 CLI 參數。`--recipient ''` 刻意放行到加密層：那裡的錯誤訊息會解釋
 * fail-closed 語意，且保證在任何寫入之前失敗（workflow 另有 shell 檢查）。
 */
export function parseArgs(argv: string[]): EncryptVerifyBundleOptions {
  const values: Partial<EncryptVerifyBundleOptions> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    const key = (FLAGS as Record<string, keyof EncryptVerifyBundleOptions | undefined>)[arg]
    if (key === undefined) throw new CliError(`unknown argument: ${arg}`)
    const value = argv[++i]
    if (value === undefined || value.startsWith('--')) throw new CliError(`${arg} requires a value`)
    // 目標與輸出空白＝危險的預設（cwd 可能是機制 repo 本身）；recipient 例外，
    // 交由 validateRecipient 給出 fail-closed 的說明。
    if (key !== 'recipient' && value.trim() === '') throw new CliError(`${arg} must not be empty`)
    // `--base-sha` 在此正規化（大小寫）但格式驗證留給加密層：錯誤訊息要說明
    // fail-closed 語意，且必須在掃描／寫入之前發生。
    values[key] = key === 'baseSha' ? value.trim().toLowerCase() : value
  }
  const { targetDir, outFile, recipient, mechanismDir, baseSha } = values
  if (targetDir === undefined) throw new CliError('--target is required')
  if (outFile === undefined) throw new CliError('--out is required')
  if (recipient === undefined) throw new CliError('--recipient is required')
  const parsed: EncryptVerifyBundleOptions = { targetDir, outFile, recipient }
  if (mechanismDir !== undefined) parsed.mechanismDir = mechanismDir
  if (baseSha !== undefined) parsed.baseSha = baseSha
  return parsed
}

export async function main(argv: string[]): Promise<EncryptVerifyBundleResult> {
  return encryptVerifyBundle(parseArgs(argv))
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  process.exitCode = await runCliAsync(() => main(process.argv.slice(2)))
}
/* v8 ignore stop */
