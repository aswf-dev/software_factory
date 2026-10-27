/**
 * factory-verify-encrypt — 把驗證類 run 的產出打包成單一 age 密文（ADR-029 §5、§7）。
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
 * 格式：age（X25519 recipient）密文，明文是 JSON lines，每行
 * `{"path":"<相對 target 的路徑>","b64":"<原始位元組的 base64>"}`。base64 而非
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
 * CLI（workflow 呼叫）：
 *   node dist/cli/factory-verify-encrypt.js \
 *     --target target --out .factory/verify-bundle.age \
 *     --recipient "$VERIFY_AGE_PUBLIC_KEY"
 */
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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
/** 掃描測試檔時不進的目錄：版本庫、依賴、factory 內部檔與已另行處理的 specs。 */
const SKIP_DIR_NAMES: ReadonlySet<string> = new Set(['.git', 'node_modules', '.factory', 'specs'])

export interface EncryptVerifyBundleOptions {
  /** 目標 repo 的 checkout（workflow 中是 `target`）。 */
  targetDir: string
  /** 輸出密文路徑；父目錄不存在時會建立。 */
  outFile: string
  /** age X25519 公鑰（`age1…`）。 */
  recipient: string
}

export interface EncryptVerifyBundleResult {
  /** 實際打包的檔案（相對 target，排序後）。 */
  files: string[]
}

/**
 * 判斷單一路徑是否進 bundle。
 *
 * 這是 bundle 範圍的**唯一**決策點：run 目錄全收（gh-token 除外）、specs 全收
 * （`.lake/build/` 除外）、其餘只收驗證白名單的測試檔。`.factory/` 下非 run 的
 * 檔案（verify-mode.json／model.json 等）是機制 metadata，不是驗證產出，不進
 * bundle；它們走原本的明文 artifact 清單。
 */
function isBundlePath(rel: string): boolean {
  if (rel === GH_TOKEN_PATH) return false
  if (isLakeBuildArtifact(rel)) return false
  if (rel.startsWith('.factory/')) return rel.startsWith(`${RUN_DIR}/`)
  return rel.startsWith(`${SPECS_DIR}/`) || isVerifyAllowedPath(rel)
}

/** `specs/lean/.lake/build/**` 之類的建置快取：可重建、體積大、不是 agent 的交付。 */
function isLakeBuildArtifact(rel: string): boolean {
  const segments = rel.split('/')
  return segments.some((segment, i) => segment === '.lake' && segments[i + 1] === 'build')
}

/**
 * 遞迴列出 root/relDir 下的檔案（相對 root）。目錄不存在時回空陣列：
 * `.factory/run` 在 agent 失敗前可能還沒建立，不該讓整個 bundle 失敗。
 * 其他 I/O 錯誤（例如 `specs` 不是目錄、權限不足）往外拋——打包不完整比
 * abort 更危險，下一階段會拿到缺檔的規格卻無從得知。
 * symlink 不跟隨（避免把 target 外的路徑打包進來），目錄／其他特殊檔一律略過。
 */
function walkFiles(root: string, relDir: string, skipDir: (rel: string) => boolean): string[] {
  let entries
  try {
    entries = readdirSync(join(root, relDir), { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
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

/**
 * agent 改動／新增的路徑（含本地 commit 與未追蹤檔）。
 *
 * - 非 git 工作區 → null（呼叫端改掃描全部白名單檔案，寧可多帶不可缺檔）。
 * - 空 repo（尚無 HEAD）→ null（同上）。
 * - 其餘 → `git diff <base>` ∪ `git ls-files --others`；`--diff-filter=ACMR`
 *   排除刪除，`-z` 避免檔名含空白／引號時被 git 加引號而比對失敗。
 */
function changedPaths(targetDir: string): Set<string> | null {
  if (!isGitWorkTree(targetDir)) return null
  const base = readBaseBranch(targetDir)
  const baseRef = base === undefined ? null : resolveBaseRef(targetDir, base)
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
 * 收集 bundle 內的路徑（相對 target，排序）。只回傳實際存在的 regular file；
 * symlink 不跟隨（`lstat`），避免把 target 外的內容打包。不存在的路徑直接
 * 跳過（git 事實與檔案系統之間可能有 race），但其他 I/O 錯誤會往外拋——
 * 打包不完整比 abort 更危險（下一階段會拿到缺檔的規格）。
 */
function collectBundlePaths(targetDir: string): string[] {
  const files = new Set<string>()
  const add = (rel: string): void => {
    if (!isBundlePath(rel)) return
    if (!lstatSync(join(targetDir, rel)).isFile()) return
    files.add(rel)
  }
  for (const rel of walkFiles(targetDir, RUN_DIR, neverSkip)) add(rel)
  for (const rel of walkFiles(targetDir, SPECS_DIR, neverSkip)) add(rel)
  for (const rel of changedPaths(targetDir) ?? collectAllBundlePaths(targetDir)) add(rel)
  return [...files].sort()
}

/** 把檔案讀成 JSON lines 明文（記憶體組完才加密，不落任何明文側檔）。 */
function serializeBundle(targetDir: string, files: readonly string[]): Buffer {
  const lines = files.map((rel) => {
    const bytes = readFileSync(join(targetDir, rel))
    return JSON.stringify({ path: rel, b64: bytes.toString('base64') })
  })
  return Buffer.from(lines.map((line) => `${line}\n`).join(''), 'utf8')
}

function validateRecipient(recipient: string): string {
  const key = recipient.trim()
  if (key === '' || !key.startsWith('age1')) {
    throw new CliError(
      'recipient 必須是非空的 age X25519 公鑰（age1…）。缺 VERIFY_AGE_PUBLIC_KEY 或值不合法時' +
        '不得產生 bundle——驗證模式拒絕任何明文 fallback（ADR-029 §7，fail closed）',
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
    throw new CliError(`target 目錄不存在：${targetDir}`)
  }
  if (!stats.isDirectory()) throw new CliError(`target 不是目錄：${targetDir}`)
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
  const files = collectBundlePaths(targetDir)
  const payload = serializeBundle(targetDir, files)
  const encrypter = new Encrypter()
  encrypter.addRecipient(key)
  const ciphertext = await encrypter.encrypt(payload)
  const outFile = resolve(opts.outFile)
  mkdirSync(dirname(outFile), { recursive: true })
  writeFileSync(outFile, ciphertext)
  return { files }
}

const FLAGS = {
  '--target': 'targetDir',
  '--out': 'outFile',
  '--recipient': 'recipient',
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
    values[key] = value
  }
  const { targetDir, outFile, recipient } = values
  if (targetDir === undefined) throw new CliError('--target is required')
  if (outFile === undefined) throw new CliError('--out is required')
  if (recipient === undefined) throw new CliError('--recipient is required')
  return { targetDir, outFile, recipient }
}

export async function main(argv: string[]): Promise<EncryptVerifyBundleResult> {
  return encryptVerifyBundle(parseArgs(argv))
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  process.exitCode = await runCliAsync(() => main(process.argv.slice(2)))
}
/* v8 ignore stop */
