import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  compareSkills,
  detectModelIds,
  hashBundle,
  hashContent,
  loadLock,
  main,
  scanSkills,
  validateFrontmatter,
  type SkillsLock,
} from './factory-skills-lock.js'
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
 *  | M5 | promote 跳過 model id 閘門（釘死模型的提案被放行）                   | GREEN  | RED   |
 *  | M6 | `MODEL_ID_PATTERN` 改為比對「現役清單」（退役 id 不再偵測）           | GREEN  | RED   |
 *  | M7 | `scanSkills` 回到只雜湊 `SKILL.md`（bundle 其餘檔案失去保護）         | GREEN  | RED   |
 *  | M8 | bundle manifest 只含內容不含路徑（改名測不到）                       | GREEN  | RED   |
 *  | M9 | promote 寫入單檔 hash 而非 bundle hash（promote 後立刻報 changed）    | GREEN  | RED   |
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

describe('M5 變異：promote 跳過 model id 閘門', () => {
  /**
   * 被釘死的模型會退役，而退役**不會讓任何東西變紅**：SKILL.md 仍在、hash 仍相符、
   * verify 仍 ok，agent 只是繼續收到一條指向不存在模型的指令。這是與 M3 同類的
   * 「每一步看起來都成功」失敗模式，差別在它要等到換模型那天才發作。
   */
  it('提案釘死 model id → 必須拒絕 promote', () => {
    const proposals = join(tmp, 'm5-proposals')
    mkdirSync(join(proposals, 'pin-skill'), { recursive: true })
    writeFileSync(
      join(proposals, 'pin-skill', 'SKILL.md'),
      '---\nname: pin-skill\ndescription: d\n---\n一律使用 claude-opus-5',
    )
    const skillsDir = join(tmp, 'm5-skills')
    mkdirSync(skillsDir, { recursive: true })
    const lock = join(tmp, 'm5.json')
    writeFileSync(lock, JSON.stringify({ version: 1, skills: [] }))

    expect(() =>
      main(['--promote', 'pin-skill', '--lock', lock, '--skills-dir', skillsDir, '--proposals-dir', proposals]),
    ).toThrow(CliError)
  })

  it('同一主題改為指稱 tier → 必須放行（錨定：擋的是 id，不是「談模型」）', () => {
    const proposals = join(tmp, 'm5b-proposals')
    mkdirSync(join(proposals, 'tier-skill'), { recursive: true })
    writeFileSync(
      join(proposals, 'tier-skill', 'SKILL.md'),
      '---\nname: tier-skill\ndescription: d\n---\n複雜任務請提高 tier（見 config/dsh/model-tiers.yaml）',
    )
    const skillsDir = join(tmp, 'm5b-skills')
    mkdirSync(skillsDir, { recursive: true })
    const lock = join(tmp, 'm5b.json')
    writeFileSync(lock, JSON.stringify({ version: 1, skills: [] }))

    expect(() =>
      main(['--promote', 'tier-skill', '--lock', lock, '--skills-dir', skillsDir, '--proposals-dir', proposals]),
    ).not.toThrow()
  })
})

describe('M6 變異：model id 字典改為「現役清單」', () => {
  /**
   * 這是整個檢查最容易被「改好」成壞掉的地方：從 `config/dsh/model-tiers.yaml`
   * 讀現役 id 看起來更嚴謹、更不會誤報、也符合單一事實來源的直覺。
   *
   * 但它在**唯一需要生效的時刻**失效——id 退役時會被自設定檔移除，字典隨即
   * 失去它，而正是從那一刻起，釘著它的 SKILL.md 才開始造成傷害。
   * 實證：2026-08-28 移除 claude-fable-5、2026-09-11 移除
   * deepseek-v4-pro／deepseek-v4-flash。以下三個 id 目前都**不在**設定檔裡。
   */
  it.each(['deepseek-v4-pro', 'deepseek-v4-flash', 'claude-fable-5'])(
    '已退役的 %s 仍必須被偵測',
    (id) => {
      expect(detectModelIds(`失敗時改用 ${id}`)).toEqual([id])
    },
  )

  it('現役 id 同樣被偵測（錨定：不是只認退役的）', () => {
    expect(detectModelIds('預設 qwen3.8-flash')).toEqual(['qwen3.8-flash'])
  })
})

describe('M7/M8 變異：bundle 保護範圍退回 SKILL.md', () => {
  /**
   * 技能是 **bundle**，不是單一檔案：`quint-modeling/SKILL.md` 明確指示 agent
   * 去讀 `guidelines/*.md`（progressive disclosure）。實測 `.dsh/skills` 有 24
   * 個檔案而 lock 只涵蓋 6 個——這盞燈要抓的「`cp -r` 不完整導致 SOP 靜默
   * 消失」，對其中 18 個完全不亮：`guidelines/review.md` 整個消失，
   * `--verify` 仍回報 `ok: true`。
   */
  function bundle(dir: string): string {
    const root = join(tmp, dir, 'alpha')
    mkdirSync(join(root, 'guidelines'), { recursive: true })
    writeFileSync(join(root, 'SKILL.md'), SKILL)
    writeFileSync(join(root, 'guidelines', 'review.md'), 'v1')
    return join(tmp, dir)
  }

  it('M7：SKILL.md 以外的檔案被刪 → scanSkills 的 hash 必須改變', () => {
    const root = bundle('m7')
    const before = scanSkills(root).get('alpha')
    rmSync(join(root, 'alpha', 'guidelines', 'review.md'))
    expect(scanSkills(root).get('alpha')).not.toBe(before)
  })

  it('M7：SKILL.md 以外的檔案被改 → hash 必須改變', () => {
    const root = bundle('m7b')
    const before = scanSkills(root).get('alpha')
    writeFileSync(join(root, 'alpha', 'guidelines', 'review.md'), 'v2')
    expect(scanSkills(root).get('alpha')).not.toBe(before)
  })

  it('M8：內容不變但檔名改變 → hash 必須改變（SKILL.md 的引用會失效）', () => {
    const root = bundle('m8')
    const before = hashBundle(join(root, 'alpha'))
    rmSync(join(root, 'alpha', 'guidelines', 'review.md'))
    writeFileSync(join(root, 'alpha', 'guidelines', 'renamed.md'), 'v1')
    expect(hashBundle(join(root, 'alpha'))).not.toBe(before)
  })
})

describe('M9 變異：promote 寫入單檔 hash', () => {
  /**
   * lock 記錄 bundle 雜湊，而 promote 只搬 `SKILL.md`。若 promote 寫入的是
   * 單檔文字的 hash，**下一次 `--verify` 立刻把剛 promote 的技能報成
   * `changed`**——一個正常的放行動作就製造一筆假的完整性告警，而假告警會
   * 訓練人忽略這個訊號（`docs/25` §7「紀律失效」）。
   */
  it('promote 之後立刻 verify → 必須 ok', () => {
    const proposals = join(tmp, 'm9-proposals')
    mkdirSync(join(proposals, 'new-skill'), { recursive: true })
    writeFileSync(join(proposals, 'new-skill', 'SKILL.md'), '---\nname: new-skill\ndescription: d\n---\nsteps')
    const skillsDir = join(tmp, 'm9-skills')
    mkdirSync(skillsDir, { recursive: true })
    const lock = join(tmp, 'm9.json')
    writeFileSync(lock, JSON.stringify({ version: 1, skills: [] }))

    main(['--promote', 'new-skill', '--lock', lock, '--skills-dir', skillsDir, '--proposals-dir', proposals])
    const out = main(['--verify', '--lock', lock, '--skills-dir', skillsDir])
    expect(out.mode === 'verify' && out.ok).toBe(true)
    expect(loadLock(lock).skills[0]?.sha256).toBe(hashBundle(join(skillsDir, 'new-skill')))
  })
})
