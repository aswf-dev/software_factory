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
 *   1. `git -C <target> ls-tree -r -z --full-tree <base-sha>` 列出 base 的
 *      mode／type／oid／path，再以 `git cat-file --batch` 逐 blob 取內容，寫到
 *      `$RUNNER_TEMP/<work>/base`。**兩者都不讀 attributes**（R26）：agent 可寫的
 *      `.git/info/attributes` 因此不能用 `export-ignore` 藏掉刪除、也不能用
 *      `export-subst` 把 base 內容換成 agent 的內容。非 blob 條目（gitlink／
 *      submodule）跳過並留 warning；mode `100755` 保留可執行位。
 *   2. `rsync -a` 把工作樹複製到 `$RUNNER_TEMP/<work>/facts`（只排除 `.git`）——
 *      rsync 不讀 agent 的 git config，也不執行任何過濾器；
 *   3. 依 base 路徑集修剪 facts：neutralised 路徑中與 base blob 相同的檔案移除
 *      （workflow 已把它們移到一旁）；建置／產物目錄下**不在 base** 的條目移除
 *      （agent 的 `npm install`／`coverage`／`.lake/build` 不是交付），但 base
 *      已 commit 的 `dist/` 檔仍保留在事實裡，agent 修改它仍會回報 M；
 *   4. 在 `$RUNNER_TEMP/<work>/calc` `git init` 一個乾淨 repo，套用**顯式最小
 *      config**（`core.hooksPath=/dev/null`、`core.fsmonitor=false`、身分與
 *      `commit.gpgsign=false`），把 base 樹複製進去、`git add -A -f`、commit；
 *      再把 facts 覆蓋上去（刪掉 facts 沒有的檔案）、`git add -A -f`；
 *   5. 以 `git diff --cached` 產生 changed／lines／assertion 事實。
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
 * - neutralised 路徑（`.dsh`／`.agents` 目錄與 `AGENTS.md`／`AGENTS.local.md`／
 *   `CLAUDE.md`／`CLAUDE.local.md` 檔名，任何深度）只在**存在於 base**時被忽略：
 *   base 內的檔案在 agent 之前已移到一旁，不應變成刪除；agent 在這些路徑下
 *   **新建**的檔案仍留在 facts（status A），由 crosscheck 判 verify-scope 紅。
 * - `ls-tree`／`cat-file` 仍以 target 的物件庫解析 base；`GIT_NO_REPLACE_OBJECTS=1`
 *   與指向 `/dev/null` 的 global／system config 讓 `git replace` 不得改寫基準。
 *   兩者都不處理 attributes，也不執行 clean filter／hooks／fsmonitor。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { countAssertionDelta } from '../assertion-count/count.js'
import { GIT_HARDENING_ENV } from './git-safe.js'
import { isMainModule } from './is-main-module.js'
import { CliError, runCli } from './run-cli.js'

/** `--base-sha` 的形狀：完整 40 位 hex commit（與 crosscheck／encrypt 相同）。 */
const BASE_SHA_HEX = /^[0-9a-f]{40}$/i

/** 外部命令輸出的上限；超過即 fail closed（不讓 base 擷取把 runner 記憶體吃光）。 */
const MAX_COMMAND_OUTPUT = 512 * 1024 * 1024

/** 事實計算要排除的路徑 segment／檔名（workflow 在 agent 之前把他們移到一旁）。 */
const NEUTRALISED_SEGMENTS: ReadonlySet<string> = new Set(['.dsh', '.agents'])
const NEUTRALISED_FILE_NAMES: ReadonlySet<string> = new Set([
  'AGENTS.md',
  'AGENTS.local.md',
  'CLAUDE.md',
  'CLAUDE.local.md',
])

/**
 * 建置／產物目錄（任何深度）。這些是 agent 執行工具鏈的副作用，不是交付；
 * `git add -A -f` 會把它們當成新增，若不排除，合規的 run 會被
 * `verify-scope`／`diff-not-reported` 假紅。清單刻意只收跨語言常見、可重建、
 * 不該進版控的目錄；`.lake/build` 另以兩段式路徑判斷（見 `isArtifactPath`）。
 *
 * **不整棵排除 base 已 commit 的內容**：base 是 tracked 檔案的集合，commit 進
 * `dist/` 的檔案仍是真實交付；排除只套用在 facts 中「不存在於 base」的條目
 * （見 `pruneFactsTree`）。這樣 agent 修改已 commit 的 `dist/app.js` 仍回報 M。
 */
const ARTIFACT_SEGMENTS: ReadonlySet<string> = new Set([
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.gradle',
  'coverage',
  'dist',
  'build',
  'target',
])

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

/** 路徑是否落在建置／產物目錄（任何深度；`.lake/build` 為兩段式前綴）。 */
export function isArtifactPath(rel: string): boolean {
  const segments = rel.split('/')
  return segments.some(
    (segment, i) => ARTIFACT_SEGMENTS.has(segment) || (segment === '.lake' && segments[i + 1] === 'build'),
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

/** `git ls-tree` 的一筆：mode／type／oid／path（path 是 repo 相對路徑）。 */
export interface BaseTreeEntry {
  mode: string
  type: string
  oid: string
  path: string
}

/** base 擷取結果：所有 blob 路徑、neutralised blob 的 oid、以及警告。 */
export interface BaseTreeExtraction {
  /** base 內所有 blob 路徑（含 neutralised；用來判斷 facts 條目是否已 commit）。 */
  paths: Set<string>
  /** neutralised 路徑 → base blob oid；用來辨認「原封不動搬回來」的檔案。 */
  neutralisedOids: Map<string, string>
  /** 非 blob 條目（submodule／gitlink）的警告；不中斷事實計算。 */
  warnings: string[]
}

/**
 * 驗證 git tree 路徑是安全的相對路徑。
 *
 * 正常 git 不允許 `..`／空 segment／`.git` 進 tree，但 base 物件庫是 agent 可寫的；
 * 擷取會把路徑接到 `$RUNNER_TEMP` 下，任何逃逸都必須在寫檔前 fail closed。
 */
export function isSafeTreePath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\0')) return false
  return path
    .split('/')
    .every(
      (segment) =>
        segment !== '' && segment !== '.' && segment !== '..' && segment.toLowerCase() !== '.git',
    )
}

/**
 * 解析 `git ls-tree -r -z --full-tree` 的輸出。
 *
 * `-z` 的每一筆是 `mode SP type SP oid TAB path NUL`；path 可以含空白、換行、
 * 非 ASCII，所以先找第一個 TAB 再切 header，不能對整筆 split 空白。
 */
export function parseLsTree(output: Buffer): BaseTreeEntry[] {
  const entries: BaseTreeEntry[] = []
  for (const raw of output.toString('utf8').split('\0')) {
    if (raw === '') continue
    const tab = raw.indexOf('\t')
    if (tab < 0) throw new CliError('git ls-tree 輸出缺 TAB（fail closed）')
    const header = raw.slice(0, tab)
    const path = raw.slice(tab + 1)
    const match = /^([0-9]{6}) (blob|tree|commit) ([0-9a-f]{40})$/.exec(header)
    if (match === null) throw new CliError('git ls-tree 輸出格式不符（fail closed）')
    if (!isSafeTreePath(path)) {
      throw new CliError(`git ls-tree 出現不安全的 path ${JSON.stringify(path)}（fail closed）`)
    }
    entries.push({
      mode: match[1] as string,
      type: match[2] as string,
      oid: match[3] as string,
      path,
    })
  }
  return entries
}

/**
 * 解析 `git cat-file --batch` 的輸出。
 *
 * 每一筆是 `<oid> blob <size> LF <content> LF`；content 是二進位且可能含 LF，
 * 因此必須依 header 的 size 切，不能用 split。`missing`／型別不符／長度不足
 * 一律 fail closed——部分 base 比完整 base 更危險（刪除會被誤判成事實）。
 */
export function parseCatFileBatch(output: Buffer, oids: readonly string[]): Map<string, Buffer> {
  const contents = new Map<string, Buffer>()
  let offset = 0
  for (const oid of oids) {
    const headerEnd = output.indexOf(0x0a, offset)
    if (headerEnd < 0) throw new CliError('git cat-file --batch 輸出缺 header（fail closed）')
    const header = output.subarray(offset, headerEnd).toString('utf8')
    if (header.endsWith(' missing')) {
      throw new CliError(`git cat-file --batch 找不到 blob ${oid}（fail closed）`)
    }
    const parts = header.split(' ')
    const size = Number(parts[2])
    if (parts.length !== 3 || parts[0] !== oid || parts[1] !== 'blob' || !Number.isInteger(size) || size < 0) {
      throw new CliError('git cat-file --batch 輸出格式不符（fail closed）')
    }
    const contentStart = headerEnd + 1
    const contentEnd = contentStart + size
    if (contentEnd >= output.length || output[contentEnd] !== 0x0a) {
      throw new CliError('git cat-file --batch 內容長度不符（fail closed）')
    }
    contents.set(oid, output.subarray(contentStart, contentEnd))
    offset = contentEnd + 1
  }
  return contents
}

/** git blob 的 SHA-1（`sha1("blob <size>\0" + content)`），用來比對 base 與 facts。 */
function gitBlobOid(content: Buffer): string {
  const hash = createHash('sha1')
  hash.update(`blob ${content.length}\0`)
  hash.update(content)
  return hash.digest('hex')
}

/** 把單一 base blob 寫進 base 樹；symlink 建 symlink，100755 保留可執行位。 */
function writeBaseEntry(baseDir: string, entry: BaseTreeEntry, content: Buffer): void {
  const abs = join(baseDir, entry.path)
  mkdirSync(dirname(abs), { recursive: true })
  if (entry.mode === '120000') {
    symlinkSync(content.toString('utf8'), abs)
    return
  }
  const executable = entry.mode === '100755'
  writeFileSync(abs, content)
  chmodSync(abs, executable ? 0o755 : 0o644)
}

/**
 * 以 `ls-tree` + `cat-file --batch` 重建 base 樹（R26）。
 *
 * 兩者只讀物件庫，**不讀 attributes**：agent 寫在 `.git/info/attributes` 的
 * `export-ignore`／`export-subst` 對它們沒有作用。只寫 blob；gitlink／submodule
 * （type `commit`）跳過並回傳 warning。neutralised 路徑不寫入 base，但 oid 記在
 * `neutralisedOids`——facts 側用它辨認「被移到一旁又被原封不動搬回來」的檔案。
 */
export function extractBaseTree(targetDir: string, baseSha: string, baseDir: string): BaseTreeExtraction {
  const listing = requireSuccess(
    runCommand(
      'git',
      [
        '-C',
        targetDir,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        'ls-tree',
        '-r',
        '-z',
        '--full-tree',
        baseSha,
      ],
      { env: hardenedEnv() },
    ),
    'git ls-tree',
  )
  const entries = parseLsTree(listing)
  const paths = new Set<string>()
  const neutralisedOids = new Map<string, string>()
  const warnings: string[] = []
  const byOid = new Map<string, BaseTreeEntry[]>()
  for (const entry of entries) {
    if (entry.type !== 'blob') {
      warnings.push(
        `skip non-blob git entry ${JSON.stringify(entry.path)} (type ${entry.type}, mode ${entry.mode}); submodules/gitlinks are not materialised`,
      )
      continue
    }
    paths.add(entry.path)
    if (isNeutralisedPath(entry.path)) {
      neutralisedOids.set(entry.path, entry.oid)
      continue
    }
    const group = byOid.get(entry.oid)
    if (group === undefined) byOid.set(entry.oid, [entry])
    else group.push(entry)
  }
  const oids = [...byOid.keys()]
  if (oids.length > 0) {
    const contents = parseCatFileBatch(
      requireSuccess(
        runCommand('git', ['-C', targetDir, 'cat-file', '--batch'], {
          env: hardenedEnv(),
          input: Buffer.from(`${oids.join('\n')}\n`),
        }),
        'git cat-file --batch',
      ),
      oids,
    )
    for (const [oid, group] of byOid) {
      const content = contents.get(oid) as Buffer
      for (const entry of group) writeBaseEntry(baseDir, entry, content)
    }
  }
  return { paths, neutralisedOids, warnings }
}

/**
 * 檔案／symlink 的 git blob oid。只對非目錄條目呼叫；rsync -a 只會產生
 * regular file／symlink，特殊檔不會進 facts。
 */
function entryBlobOid(abs: string, entry: { isFile(): boolean }): string {
  return entry.isFile()
    ? gitBlobOid(readFileSync(abs))
    : gitBlobOid(Buffer.from(readlinkSync(abs)))
}

/**
 * 修剪 facts 樹（R26 (b)／(c)／(d)）：
 *
 * - neutralised 路徑：只有當 facts 的內容與 base blob 完全相同時才移除（workflow
 *   已把它移到一旁，原封不動搬回來不算變更）；新路徑或不同內容留著 → status A，
 *   由 crosscheck 判越界。
 * - 建置／產物目錄：只移除**不存在於 base** 的條目。base 已 commit 的 `dist/app.js`
 *   仍在 base 與 facts 兩側，agent 改它會回報 M；同目錄的未追蹤產物被排除。
 */
function pruneFactsTree(dir: string, relDir: string, base: BaseTreeExtraction): void {
  for (const entry of readdirSync(join(dir, relDir), { withFileTypes: true })) {
    const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`
    const abs = join(dir, rel)
    if (entry.isDirectory()) {
      pruneFactsTree(dir, rel, base)
      continue
    }
    if (isNeutralisedPath(rel)) {
      const baseOid = base.neutralisedOids.get(rel)
      if (baseOid !== undefined && entryBlobOid(abs, entry) === baseOid) {
        rmSync(abs, { force: true })
      }
      // R28：neutralised 路徑**永遠不是**建置產物。base 已有的原樣搬回可以忽略，
      // 但 agent 新建／改寫的一律留在 facts（A）由 crosscheck 判紅——不能落到下面
      // 的 artifact prune（`specs/build/AGENTS.md` 這類會被靜默刪掉，facts 變空、
      // crosscheck 反而綠）。
      continue
    }
    if (isArtifactPath(rel) && !base.paths.has(rel)) rmSync(abs, { force: true })
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
 * 任何一步失敗（`RUNNER_TEMP` 未設定、target 不存在、base-sha 解析不到、
 * ls-tree／cat-file／rsync／git calc 非零、輸出不可寫）都拋 CliError；caller
 * （CLI 或 workflow）以非零結束，crosscheck／encrypt 因此拿不到 facts 而 fail closed。
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

  // (a) base：ls-tree + cat-file --batch，完全不經 attributes（R26 的核心前提）。
  const base = extractBaseTree(targetDir, baseSha, baseDir)
  for (const warning of base.warnings) process.stderr.write(`${warning}\n`)

  // (b) facts：rsync 不讀 agent 的 git config，也不執行任何 filter；只排除 .git，
  //     建置產物與 neutralised 路徑由 pruneFactsTree 依 base 內容判斷。
  rsync(['-a', '--exclude=.git', `${targetDir}/`, `${factsDir}/`])
  pruneFactsTree(factsDir, '', base)

  // (c) calc：乾淨 repo + base commit，再把 facts 覆蓋上去；`-f` 忽略所有 ignore 檔。
  calcGit(calcDir, ['init', '--quiet', '--initial-branch=main'])
  // --checksum：base 與 facts 可能同尺寸、同一秒寫入（agent 立刻改一個字元）；
  // rsync 預設的 size+mtime quick check 會把這種變更當成已同步而漏掉。
  rsync(['-a', '--checksum', '--exclude=.git', `${baseDir}/`, `${calcDir}/`])
  calcGit(calcDir, ['add', '-A', '-f'])
  calcGit(calcDir, ['commit', '--quiet', '--allow-empty', '-m', 'factory-verify-facts base'])
  rsync(['-a', '--delete', '--checksum', '--exclude=.git', `${factsDir}/`, `${calcDir}/`])
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
