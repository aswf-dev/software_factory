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
 */
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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

/** SKILL.md 內容的 sha256（ADR-016 §5 記錄的就是這個值）。 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * 掃描 skills 根目錄，回傳 name → sha256。
 *
 * 只認 `<root>/<name>/SKILL.md` 這一種形狀（DSH 的 directory-bundle 慣例）。
 * 目錄不存在時回傳空 Map 而非拋錯——「目錄整個不見」正是 verify 要報告的
 * 情況之一，在讀取階段就中止會讓它變成無法診斷的例外。
 */
export function scanSkills(root: string): Map<string, string> {
  const found = new Map<string, string>()
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return found
  }
  for (const name of entries.sort()) {
    const file = join(root, name, 'SKILL.md')
    try {
      if (!statSync(file).isFile()) continue
    } catch {
      continue
    }
    found.set(name, hashContent(readFileSync(file, 'utf8')))
  }
  return found
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

export interface VerifyOutput {
  mode: 'verify'
  ok: boolean
  mismatches: SkillMismatch[]
  checked: number
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
    return { mode: 'verify', ok: mismatches.length === 0, mismatches, checked: lock.skills.length }
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
  const toDir = join(args.skillsDir, name)
  mkdirSync(toDir, { recursive: true })
  const to = join(toDir, 'SKILL.md')
  copyFileSync(from, to)

  const sha256 = hashContent(content)
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
