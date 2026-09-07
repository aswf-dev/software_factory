import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compareSkills, hashContent, main, validateFrontmatter, type SkillsLock } from './factory-skills-lock.js'
import { CliError } from './run-cli.js'

let tmp: string

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'skills-lock-mutation-'))
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/**
 * Mutation-strength tests for `factory-skills-lock` (E5、ADR-016 §5)。
 *
 * 本 CLI 的價值全在「**偵測到卻不擋 run**」這條看似矛盾的契約上：
 * 它要抓住 `cp -r` 的靜默缺失（否則 agent 會在沒有停手規則的情況下跑），
 * 但自己絕不能成為新的失敗來源（否則一次校驗誤判就癱瘓整個工廠）。
 * 這兩個方向的變異都不會讓一般行為測試變紅，只有本檔的斷言抓得到。
 *
 *  | ID | Mutation                                                        | Before | After |
 *  |----|-----------------------------------------------------------------|--------|-------|
 *  | M1 | `missing` 偵測被移除（只比對實際存在的技能）                        | GREEN  | RED   |
 *  | M2 | `changed` 偵測被移除（只看名稱存在，不比 hash）                     | GREEN  | RED   |
 *  | M3 | promote 的 frontmatter 驗證被跳過（不合法也放行）                    | GREEN  | RED   |
 *  | M4 | `validateFrontmatter` 的 kebab-case 檢查被放寬                     | GREEN  | RED   |
 *
 * 驗證方式：手改 src/cli/factory-skills-lock.ts 套用變異 → 重跑本檔變紅 → 還原 → 變綠。
 */

const SKILL = '---\nname: alpha-skill\ndescription: A\n---\nbody'
const lockOf = (skills: { name: string; sha256: string }[]): SkillsLock => ({ version: 1, skills })

describe('M1 變異：missing 偵測被移除', () => {
  /**
   * 這是本機制存在的**唯一理由**（ADR-016 §5）：`cp -r` 不完整時，
   * `factory-stop-rules` 消失卻無任何紅燈。若 compareSkills 只走「實際有的」
   * 而不反向檢查 lock 宣告的每一項，缺失就會再次變成靜默。
   */
  it('lock 宣告但實際不存在 → 必須回報 missing', () => {
    const out = compareSkills(new Map(), lockOf([{ name: 'factory-stop-rules', sha256: hashContent(SKILL) }]))
    expect(out.map((m) => m.kind)).toContain('missing')
  })

  it('實際為空且 lock 有多項 → 每一項都回報', () => {
    const out = compareSkills(
      new Map(),
      lockOf([
        { name: 'a', sha256: hashContent(SKILL) },
        { name: 'b', sha256: hashContent(SKILL) },
      ]),
    )
    expect(out).toHaveLength(2)
  })
})

describe('M2 變異：changed 偵測被移除（只看名稱不比 hash）', () => {
  /**
   * 技能被改動但未經 --update／未經審查時，名稱仍在、內容已變。
   * 若只比對名稱集合，這種「內容被抽換」完全看不見——而 SKILL.md 的內容
   * 正是 agent 的行為準則。
   */
  it('名稱相同但內容不同 → 必須回報 changed', () => {
    const actual = new Map([['alpha', hashContent('DIFFERENT CONTENT')]])
    const out = compareSkills(actual, lockOf([{ name: 'alpha', sha256: hashContent(SKILL) }]))
    expect(out.map((m) => m.kind)).toContain('changed')
  })

  it('內容一致 → 不得誤報（錨定，避免過度收緊）', () => {
    const actual = new Map([['alpha', hashContent(SKILL)]])
    expect(compareSkills(actual, lockOf([{ name: 'alpha', sha256: hashContent(SKILL) }]))).toEqual([])
  })
})

describe('M3 變異：promote 跳過 frontmatter 驗證', () => {
  /**
   * frontmatter 不合法的 skill 會被 DSH **靜默丟棄**（docs/04 §3.2 fail closed）。
   * 若 promote 放行，結果是「promote 成功、CODEOWNERS 也審了、但技能從未生效」
   * ——最難察覺的失敗模式，因為每一步看起來都成功了。
   */
  it('frontmatter 缺失的提案 → 必須拒絕 promote', () => {
    const proposals = join(tmp, 'm3-proposals')
    mkdirSync(join(proposals, 'bad-skill'), { recursive: true })
    writeFileSync(join(proposals, 'bad-skill', 'SKILL.md'), 'no frontmatter at all')
    const skillsDir = join(tmp, 'm3-skills')
    mkdirSync(skillsDir, { recursive: true })
    const lock = join(tmp, 'm3.json')
    writeFileSync(lock, JSON.stringify({ version: 1, skills: [] }))

    expect(() =>
      main(['--promote', 'bad-skill', '--lock', lock, '--skills-dir', skillsDir, '--proposals-dir', proposals]),
    ).toThrow(CliError)
  })
})

describe('M4 變異：validateFrontmatter 的 kebab-case 檢查被放寬', () => {
  /**
   * DSH 對 skill name 的格式要求是 fail closed：不合法即靜默丟棄。
   * 放寬這條檢查會讓 promote「成功」但技能不生效（同 M3 的失敗模式）。
   */
  it('大駝峰 name → 必須回報錯誤', () => {
    expect(validateFrontmatter('---\nname: BadName\ndescription: d\n---\n').join()).toMatch(/kebab-case/)
  })

  it('底線 name → 必須回報錯誤', () => {
    expect(validateFrontmatter('---\nname: bad_name\ndescription: d\n---\n').join()).toMatch(/kebab-case/)
  })

  it('合法 kebab-case → 無錯誤（錨定）', () => {
    expect(validateFrontmatter('---\nname: good-name\ndescription: d\n---\n')).toEqual([])
  })
})
