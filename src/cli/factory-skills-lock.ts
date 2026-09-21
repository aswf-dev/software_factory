/**
 * factory-skills-lock — 技能版本鎖定（ADR-016 §5、docs/25 §4.3）。
 *
 * **鎖的是傳輸完整性，不是創作權限**（ADR-016 §5 的重要澄清）。它保護的恰恰是
 * 「agent 拿到完整能力」——`factory-run.yml` 目前以無校驗的
 * `cp -r .dsh/skills/. $HOME/.dsh/skills/` 同步技能；若該 copy 不完整、或機制 repo
 * 誤刪某個 SKILL.md，**agent 會安靜地在缺少 `factory-stop-rules` 的情況下執行**
 * ——停手規則消失卻無任何紅燈。本 CLI 就是那盞燈。
 *
 * 三個子命令：
 *   --verify            比對實際 skills 目錄與 lock（CI 用）
 *   --update            重算 hash 寫回 lock（人類改 skill 後執行，同 pnpm-lock 性質）
 *   --promote <name>    proposals/skills/<name> → .dsh/skills/（人類放行，docs/25 §4.3）
 *
 * **`--verify` 永遠 exit 0**（ADR-016 §5：第一階段僅發 warning 不擋 run）。
 * 校驗結果以 stdout 的 `ok` 欄位表達，由 workflow 決定是否發 `::warning::`。
 * 理由與 factory-usage／factory-push-event 一致：**校驗與量測不得成為新的失敗來源**。
 * 何時升為紅燈是人類的裁決（Q16-2），不是本 CLI 的預設。
 *
 * **`--promote` 對 agent 必然失敗**（ADR-016 §5，已實測）：沙箱 workspaceRoot 為
 * `target/`，機制 repo 路徑在其外。因此這裡不需要、也刻意不加額外的身分檢查
 * ——多一層自製檢查只會製造「看似有防護」的錯覺，真正的防護在沙箱與 CODEOWNERS。
 *
 * **內容閘門：具體 model id（ADR-011）。** 本檔原本只管傳輸完整性（hash），不看
 * 內容；`detectModelIds` 是唯一的例外，理由是這類缺陷**只有在放行那一刻擋得住**：
 * 一份釘死 model id 的 SKILL.md 在該 id 退役之後，會**安靜地**繼續指導 agent——
 * 沒有任何既有機制會紅燈（`docs/25` §2.4 記載訊號曾斷三週無人察覺）。
 * `--promote` 為 fail closed（拋 CliError），`--verify` 只回報 `modelPins`
 * **不影響 `ok`**：`ok` 的既有語意是傳輸完整性，混入內容政策會讓 workflow 既有的
 * `::warning::` 判讀失去單一意義。
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  type Dirent,
} from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { isMainModule } from './is-main-module.js'
import { CliError, runCli } from './run-cli.js'

/** lock 檔中的單筆技能紀錄（ADR-016 §5：name／sha256／lastChangedPR）。 */
export const SkillLockEntrySchema = z.object({
  name: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lowercase hex chars'),
  lastChangedPR: z.number().int().positive().optional(),
})

export const SkillsLockSchema = z.object({
  version: z.literal(1),
  skills: z.array(SkillLockEntrySchema),
})

export type SkillLockEntry = z.infer<typeof SkillLockEntrySchema>
export type SkillsLock = z.infer<typeof SkillsLockSchema>

export const DEFAULT_LOCK_PATH = 'config/factory/skills-lock.json'
export const DEFAULT_SKILLS_DIR = '.dsh/skills'
export const DEFAULT_PROPOSALS_DIR = 'proposals/skills'

/** 文字內容的 sha256。 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** 檔案**位元組**的 sha256。不解碼——bundle 可能含非文字檔。 */
function hashFileBytes(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * 掃描 skills 根目錄，回傳技能名清單。
 *
 * 只認 `<root>/<name>/SKILL.md` 這一種形狀（DSH 的 directory-bundle 慣例）。
 * 目錄不存在時回傳空陣列而非拋錯——「目錄整個不見」正是 verify 要報告的
 * 情況之一，在讀取階段就中止會讓它變成無法診斷的例外。
 *
 * **「什麼算一個技能」只有這一份判定。** verify 有三個讀者（bundle 雜湊、
 * model id 掃描、lock 比對），第二份判定一旦與這份分歧（例如只有一邊認得
 * `SKILL.md` 是目錄的壞形狀），寬鬆的那一份就會成為實際生效的規則。
 */
export function listSkillDirs(root: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  return entries.sort().filter((name) => {
    try {
      return statSync(join(root, name, 'SKILL.md')).isFile()
    } catch {
      return false
    }
  })
}

/**
 * 技能 bundle 內的所有一般檔案，相對路徑、以 `/` 正規化、遞迴、排序。
 *
 * **排序必須是碼元順序（`Array.sort()` 的預設），不得用 `localeCompare`**：
 * 後者依 locale 而異，同一個 bundle 在不同 runner 上會算出不同的 hash，
 * 於是 `changed` 變成一個與內容無關的隨機訊號。
 *
 * 非一般檔案（symlink、fifo…）不納入：`Dirent.isFile()` 對 symlink 回傳 false，
 * 跟隨它會把樹外的內容算進 bundle，而 `cp -r` 對 symlink 的行為本身就依平台而異。
 */
export function listBundleFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string, prefix: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(join(current, entry.name), rel)
      else if (entry.isFile()) out.push(rel)
    }
  }
  walk(dir, '')
  return out.sort()
}

/**
 * 整個技能 bundle 的 sha256——**路徑與內容都納入**。
 *
 * 先前只雜湊 `<name>/SKILL.md`，但技能是 bundle：`quint-modeling` 的
 * `guidelines/*.md` 由 SKILL.md 明確指示 agent 去讀（progressive disclosure）。
 * 實測 `.dsh/skills` 有 24 個檔案而 lock 只涵蓋 6 個——也就是說這盞燈要抓的
 * 「`cp -r` 不完整導致 SOP 靜默消失」，對其中 18 個檔案完全不亮：
 * `guidelines/review.md` 整個消失，`--verify` 仍回報 `ok: true`。
 *
 * 路徑寫進 manifest 而不只是串接內容，否則「把 `a.md` 改名成 `b.md`」
 * 這種會讓 SKILL.md 的引用失效的變更算出同一個 hash。
 */
export function hashBundle(dir: string): string {
  const manifest = listBundleFiles(dir)
    .map((rel) => `${rel}\n${hashFileBytes(join(dir, rel))}\n`)
    .join('')
  return hashContent(manifest)
}

/**
 * 掃描 skills 根目錄，回傳 name → bundle 的可解碼文字（供 model id 掃描）。
 *
 * 含 NUL 位元組的檔案視為二進位而跳過：把它硬解成 UTF-8 只會產生亂碼，對內容
 * 掃描毫無意義。它們仍計入 `hashBundle`——完整性與內容政策是兩件事。
 */
export function readSkillTexts(root: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const name of listSkillDirs(root)) {
    const dir = join(root, name)
    const parts: string[] = []
    for (const rel of listBundleFiles(dir)) {
      const buf = readFileSync(join(dir, rel))
      if (buf.includes(0)) continue
      parts.push(buf.toString('utf8'))
    }
    found.set(name, parts.join('\n'))
  }
  return found
}

/** 掃描 skills 根目錄，回傳 name → bundle sha256（lock 記錄的就是這個值）。 */
export function scanSkills(root: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const name of listSkillDirs(root)) {
    found.set(name, hashBundle(join(root, name)))
  }
  return found
}

/** 已知的模型廠商字首。退役與否都留著——退役的 id 正是最危險的那一種。 */
const MODEL_FAMILIES = ['claude', 'deepseek', 'qwen', 'gpt', 'gemini', 'llama', 'mistral', 'grok']

/**
 * 具體 model id 的**形狀**樣式——刻意不是「現役模型清單」。
 *
 * 從 `config/dsh/model-tiers.yaml` 推導現役 id 是很自然的想法，但它在**最需要
 * 生效的那一刻恰好失效**：`deepseek-v4-pro` 於 2026-09-11 退役並自設定檔移除，
 * 若字典來自設定檔，那一刻起它就不再被偵測——而正是那一刻起，任何釘著它的
 * SKILL.md 才開始造成傷害。因此比對的是**形狀**（廠商字首＋版本/型號尾綴），
 * 不是成員資格；同一取捨見 KiroCrew `lesson_validation.py` 的
 * `MODEL_ID_LITERAL_PATTERN`（以正則釘住家族，而非枚舉現役 id）。
 *
 * lookbehind 排除前面接 `/` `.` `-` 或字元的情形，使 `docs/claude-key` 這類路徑
 * 不被誤判。刻意**寬鬆地偏向誤報**：誤報的代價是 promote 時改一行措辭，
 * 漏報的代價是一條在模型退役後仍安靜生效的錯誤 SOP。
 */
export const MODEL_ID_PATTERN = new RegExp(
  `(?<![\\w/.-])(?:${MODEL_FAMILIES.join('|')})(?:-[a-z]|[-.]?\\d)[\\w.-]*`,
  'gi',
)

/**
 * 找出內容中所有具體 model id（小寫、去重、排序）。
 *
 * 尾綴的 `.` / `-` 會被剝掉，否則英文句末的 `use claude-opus-5.` 會把句點
 * 一併報進錯誤訊息，讓人誤以為 id 本身打錯。
 */
export function detectModelIds(content: string): string[] {
  const found = new Set<string>()
  for (const m of content.matchAll(MODEL_ID_PATTERN)) {
    found.add(m[0].replace(/[.-]+$/, '').toLowerCase())
  }
  return [...found].sort()
}

export type MismatchKind = 'missing' | 'extra' | 'changed'

export interface SkillMismatch {
  kind: MismatchKind
  name: string
  detail: string
}

/**
 * 比對實際目錄與 lock。
 *
 * 三類 mismatch 的嚴重性不同，但一律回報，由人類判讀：
 *  - `missing`：lock 有、實際無 → **這是本機制要防的靜默缺失**（停手規則消失）
 *  - `changed`：hash 不符 → 技能被改動但未經 --update／未經審查
 *  - `extra`  ：實際有、lock 無 → 多出未登錄的技能（可能是忘了 --update）
 */
export function compareSkills(actual: Map<string, string>, lock: SkillsLock): SkillMismatch[] {
  const mismatches: SkillMismatch[] = []
  const locked = new Map(lock.skills.map((s) => [s.name, s.sha256]))

  for (const [name, sha] of locked) {
    const got = actual.get(name)
    if (got === undefined) {
      mismatches.push({
        kind: 'missing',
        name,
        detail: `lock 宣告的技能未出現在實際目錄——agent 將在缺少此 SOP 的情況下執行`,
      })
    } else if (got !== sha) {
      mismatches.push({
        kind: 'changed',
        name,
        detail: `內容 hash 不符（lock ${sha.slice(0, 12)}… / 實際 ${got.slice(0, 12)}…）`,
      })
    }
  }
  for (const name of actual.keys()) {
    if (!locked.has(name)) {
      mismatches.push({ kind: 'extra', name, detail: '實際目錄有此技能但 lock 未登錄' })
    }
  }
  return mismatches
}

export function loadLock(lockPath: string): SkillsLock {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch (err) {
    throw new CliError(`lock (${lockPath}) 無法讀取或非合法 JSON：${(err as Error).message}`)
  }
  const parsed = SkillsLockSchema.safeParse(raw)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new CliError(`lock (${lockPath}) 格式不合法：${detail}`)
  }
  return parsed.data
}

/** SKILL.md frontmatter 的最小驗證（docs/04 §3.2：name kebab-case、description 必填）。 */
export function validateFrontmatter(content: string): string[] {
  const errors: string[] = []
  const m = content.match(/^---\n([\s\S]*?)\n---/)
  if (m === null) {
    errors.push('缺少 YAML frontmatter（--- 區塊）')
    return errors
  }
  const body = m[1] as string
  const name = body.match(/^name:\s*(.+)$/m)?.[1]?.trim()
  const description = body.match(/^description:\s*(.+)$/m)?.[1]?.trim()
  if (name === undefined || name === '') errors.push('frontmatter 缺 name')
  else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) errors.push(`name 非 kebab-case：${name}`)
  if (description === undefined || description === '') errors.push('frontmatter 缺 description')
  return errors
}

/** 某個技能內含的具體 model id（內容政策發現，非傳輸完整性問題）。 */
export interface SkillModelPin {
  name: string
  ids: string[]
}

export interface VerifyOutput {
  mode: 'verify'
  ok: boolean
  mismatches: SkillMismatch[]
  checked: number
  /**
   * 已生效技能中被偵測到的具體 model id。
   *
   * **不計入 `ok`**（見檔首）：`ok` 回答的是「agent 拿到的技能是否與 lock 一致」，
   * 這裡回答的是「技能內容是否釘死了會退役的模型」。兩者的處置不同——前者要重同步，
   * 後者要改文字——合成一個布林會讓 workflow 無法分辨該做哪一件事。
   */
  modelPins: SkillModelPin[]
}

export interface UpdateOutput {
  mode: 'update'
  lockPath: string
  skills: SkillLockEntry[]
}

export interface PromoteOutput {
  mode: 'promote'
  name: string
  from: string
  to: string
  sha256: string
  /** promote 後仍須人類 commit 並經 CODEOWNERS 審查（docs/25 §4.3 第 5 步）。 */
  nextStep: string
}

export type SkillsLockOutput = VerifyOutput | UpdateOutput | PromoteOutput

export interface SkillsLockArgs {
  mode: 'verify' | 'update' | 'promote'
  lockPath: string
  skillsDir: string
  proposalsDir: string
  name?: string | undefined
  pr?: number | undefined
}

export function parseArgs(argv: string[]): SkillsLockArgs {
  let mode: SkillsLockArgs['mode'] | undefined
  let lockPath = DEFAULT_LOCK_PATH
  let skillsDir = DEFAULT_SKILLS_DIR
  let proposalsDir = DEFAULT_PROPOSALS_DIR
  let name: string | undefined
  let pr: number | undefined

  const setMode = (m: SkillsLockArgs['mode']): void => {
    if (mode !== undefined) throw new CliError(`只能指定一個模式（已有 --${mode}）`)
    mode = m
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    const need = (flag: string): string => {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) throw new CliError(`${flag} requires a value`)
      return v
    }
    if (arg === '--verify') setMode('verify')
    else if (arg === '--update') setMode('update')
    else if (arg === '--promote') {
      setMode('promote')
      name = need('--promote')
    } else if (arg === '--lock') lockPath = need('--lock')
    else if (arg === '--skills-dir') skillsDir = need('--skills-dir')
    else if (arg === '--proposals-dir') proposalsDir = need('--proposals-dir')
    else if (arg === '--pr') {
      const raw = need('--pr')
      const n = Number(raw)
      if (!Number.isInteger(n) || n <= 0) throw new CliError(`--pr must be a positive integer, got ${raw}`)
      pr = n
    } else throw new CliError(`unknown argument: ${arg}`)
  }

  if (mode === undefined) throw new CliError('需指定 --verify / --update / --promote <name>')
  return { mode, lockPath, skillsDir, proposalsDir, name, pr }
}

export function main(argv: string[]): SkillsLockOutput {
  const args = parseArgs(argv)

  if (args.mode === 'verify') {
    const actual = scanSkills(args.skillsDir)
    const lock = loadLock(args.lockPath)
    const mismatches = compareSkills(actual, lock)
    const modelPins: SkillModelPin[] = []
    for (const [name, text] of readSkillTexts(args.skillsDir)) {
      const ids = detectModelIds(text)
      if (ids.length > 0) modelPins.push({ name, ids })
    }
    return {
      mode: 'verify',
      ok: mismatches.length === 0,
      mismatches,
      checked: lock.skills.length,
      modelPins,
    }
  }

  if (args.mode === 'update') {
    const actual = scanSkills(args.skillsDir)
    // 保留既有 lastChangedPR：--update 的職責是同步 hash，不是清掉來源紀錄。
    let previous: SkillsLock | undefined
    try {
      previous = loadLock(args.lockPath)
    } catch {
      previous = undefined
    }
    const prevPr = new Map((previous?.skills ?? []).map((s) => [s.name, s.lastChangedPR]))
    const skills: SkillLockEntry[] = [...actual.entries()].map(([name, sha256]) => {
      const carried = args.pr ?? prevPr.get(name)
      return carried === undefined ? { name, sha256 } : { name, sha256, lastChangedPR: carried }
    })
    const lock: SkillsLock = { version: 1, skills }
    writeFileSync(args.lockPath, `${JSON.stringify(lock, null, 2)}\n`)
    return { mode: 'update', lockPath: args.lockPath, skills }
  }

  // promote（人類執行；agent 在沙箱內必然失敗——見檔首註解）
  const name = args.name as string
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    throw new CliError(`技能名稱須為 kebab-case：${name}`)
  }
  const from = join(args.proposalsDir, name, 'SKILL.md')
  let content: string
  try {
    content = readFileSync(from, 'utf8')
  } catch {
    throw new CliError(`提案不存在：${from}`)
  }
  const errors = validateFrontmatter(content)
  if (errors.length > 0) {
    // fail closed：frontmatter 不合法的 skill 會被 DSH 靜默丟棄（docs/04 §3.2），
    // 若在此放行，結果是「promote 成功但技能從未生效」——最難察覺的失敗。
    throw new CliError(`提案 frontmatter 不合法：${errors.join('；')}`)
  }
  const pinned = detectModelIds(content)
  if (pinned.length > 0) {
    // fail closed：model id 會退役（實證：2026-08-28 claude-fable-5、2026-09-11
    // deepseek-v4-pro／deepseek-v4-flash，兩個月內三個 id 失效），而退役不會讓
    // SKILL.md 紅燈——它只會安靜地繼續指導 agent。模型選擇的單一事實來源是
    // config/dsh/model-tiers.yaml（ADR-011）；skill 裡的 id 就是第二套定義，
    // 一旦與設定檔分歧，先被 agent 讀到的那一套會成為實際生效的規則。
    //
    // 刻意不提供 --allow-model-id：可覆寫的閘門等於沒有閘門（同 src/stop-rules
    // 「no override parameter by design」的立場）。真有例外，改這段程式並經 PR。
    throw new CliError(
      `提案含具體 model id（${pinned.join('、')}）：skill 是 SOP，模型選擇由 ` +
        `config/dsh/model-tiers.yaml 決定（ADR-011）。請改為指稱 tier` +
        `（low／medium／high／critical）——model id 會退役，被釘死的 skill 會在退役後靜默生效`,
    )
  }
  const toDir = join(args.skillsDir, name)
  mkdirSync(toDir, { recursive: true })
  const to = join(toDir, 'SKILL.md')
  copyFileSync(from, to)

  // 雜湊**複製後的目的地**，不是提案的 SKILL.md 文字。lock 記錄的是 bundle
  // 雜湊，而 promote 目前只搬 SKILL.md；若這裡寫入單檔文字的 hash，下一次
  // --verify 立刻把剛 promote 的技能報成 changed——一個 promote 就會製造一筆
  // 假的完整性告警，訓練人忽略這個訊號。
  const sha256 = hashBundle(toDir)
  const lock = ((): SkillsLock => {
    try {
      return loadLock(args.lockPath)
    } catch {
      return { version: 1, skills: [] }
    }
  })()
  const entry: SkillLockEntry = args.pr === undefined ? { name, sha256 } : { name, sha256, lastChangedPR: args.pr }
  const skills = [...lock.skills.filter((s) => s.name !== name), entry].sort((a, b) => a.name.localeCompare(b.name))
  writeFileSync(args.lockPath, `${JSON.stringify({ version: 1, skills }, null, 2)}\n`)

  return {
    mode: 'promote',
    name,
    from,
    to,
    sha256,
    nextStep: '請 commit 變更並經 CODEOWNERS 審查（.dsh/skills/ 受 H5 保護）',
  }
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  // --verify 永遠 exit 0（ADR-016 §5 第一階段），其餘模式沿用 runCli 的錯誤語意。
  const isVerify = process.argv.includes('--verify')
  const code = runCli(() => main(process.argv.slice(2)))
  process.exitCode = isVerify ? 0 : code
}
/* v8 ignore stop */
