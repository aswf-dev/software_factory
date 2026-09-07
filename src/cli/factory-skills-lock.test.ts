import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  compareSkills,
  hashContent,
  loadLock,
  main,
  parseArgs,
  scanSkills,
  validateFrontmatter,
  type SkillsLock,
} from './factory-skills-lock.js'
import { CliError } from './run-cli.js'

let tmp: string

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'skills-lock-'))
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** 建一個 skills 根目錄，內含指定的 name → SKILL.md 內容。 */
function makeSkills(dir: string, skills: Record<string, string>): string {
  const root = join(tmp, dir)
  for (const [name, content] of Object.entries(skills)) {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, 'SKILL.md'), content)
  }
  mkdirSync(root, { recursive: true })
  return root
}

function writeLock(name: string, lock: unknown): string {
  const p = join(tmp, name)
  writeFileSync(p, JSON.stringify(lock))
  return p
}

const SKILL_A = '---\nname: alpha-skill\ndescription: A\n---\nbody A'
const SKILL_B = '---\nname: beta-skill\ndescription: B\n---\nbody B'

describe('parseArgs', () => {
  it('--verify / --update / --promote 三模式', () => {
    expect(parseArgs(['--verify']).mode).toBe('verify')
    expect(parseArgs(['--update']).mode).toBe('update')
    const p = parseArgs(['--promote', 'my-skill'])
    expect(p.mode).toBe('promote')
    expect(p.name).toBe('my-skill')
  })

  it('未指定模式 → CliError', () => {
    expect(() => parseArgs([])).toThrow(CliError)
  })

  it('指定兩個模式 → CliError（避免語意含糊）', () => {
    expect(() => parseArgs(['--verify', '--update'])).toThrow(/只能指定一個模式/)
  })

  it('未知參數 → CliError（打錯字寧可紅燈）', () => {
    expect(() => parseArgs(['--verify', '--nope'])).toThrow(/unknown argument/)
  })

  it('--lock / --skills-dir / --proposals-dir 覆寫預設', () => {
    const a = parseArgs(['--verify', '--lock', 'L', '--skills-dir', 'S', '--proposals-dir', 'P'])
    expect([a.lockPath, a.skillsDir, a.proposalsDir]).toEqual(['L', 'S', 'P'])
  })

  it('--promote 缺值 → CliError', () => {
    expect(() => parseArgs(['--promote'])).toThrow(/requires a value/)
  })

  it('--lock 後接另一個 flag → CliError（不吞掉旗標當值）', () => {
    expect(() => parseArgs(['--verify', '--lock', '--update'])).toThrow(/requires a value/)
  })

  it('--pr 非正整數 → CliError', () => {
    expect(() => parseArgs(['--update', '--pr', 'abc'])).toThrow(/positive integer/)
    expect(() => parseArgs(['--update', '--pr', '0'])).toThrow(/positive integer/)
  })

  it('--pr 正整數 → 解析', () => {
    expect(parseArgs(['--update', '--pr', '42']).pr).toBe(42)
  })
})

describe('scanSkills', () => {
  it('讀出 <root>/<name>/SKILL.md 的 hash', () => {
    const root = makeSkills('scan1', { alpha: SKILL_A, beta: SKILL_B })
    const got = scanSkills(root)
    expect([...got.keys()].sort()).toEqual(['alpha', 'beta'])
    expect(got.get('alpha')).toBe(hashContent(SKILL_A))
  })

  it('目錄不存在 → 空 Map（不拋錯：整個目錄不見正是 verify 要報告的情況）', () => {
    expect(scanSkills(join(tmp, 'does-not-exist')).size).toBe(0)
  })

  it('忽略沒有 SKILL.md 的子目錄', () => {
    const root = join(tmp, 'scan2')
    mkdirSync(join(root, 'empty-dir'), { recursive: true })
    mkdirSync(join(root, 'good'), { recursive: true })
    writeFileSync(join(root, 'good', 'SKILL.md'), SKILL_A)
    expect([...scanSkills(root).keys()]).toEqual(['good'])
  })

  it('SKILL.md 是目錄而非檔案 → 忽略（!isFile 分支）', () => {
    const root = join(tmp, 'scan3')
    // 惡意/損毀的形狀：名為 SKILL.md 的目錄。readFileSync 會拋 EISDIR，
    // 因此必須在 isFile 就擋掉，否則一顆壞目錄會讓整次校驗崩潰。
    mkdirSync(join(root, 'weird', 'SKILL.md'), { recursive: true })
    mkdirSync(join(root, 'good'), { recursive: true })
    writeFileSync(join(root, 'good', 'SKILL.md'), SKILL_A)
    expect([...scanSkills(root).keys()]).toEqual(['good'])
  })
})

describe('compareSkills', () => {
  const lock = (skills: { name: string; sha256: string }[]): SkillsLock => ({ version: 1, skills })

  it('完全一致 → 無 mismatch', () => {
    const actual = new Map([['a', hashContent(SKILL_A)]])
    expect(compareSkills(actual, lock([{ name: 'a', sha256: hashContent(SKILL_A) }]))).toEqual([])
  })

  it('missing：lock 有、實際無 → 這是要防的靜默缺失', () => {
    const out = compareSkills(new Map(), lock([{ name: 'factory-stop-rules', sha256: hashContent(SKILL_A) }]))
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe('missing')
    expect(out[0]?.name).toBe('factory-stop-rules')
  })

  it('changed：hash 不符', () => {
    const actual = new Map([['a', hashContent(SKILL_B)]])
    const out = compareSkills(actual, lock([{ name: 'a', sha256: hashContent(SKILL_A) }]))
    expect(out[0]?.kind).toBe('changed')
  })

  it('extra：實際有、lock 無', () => {
    const actual = new Map([['a', hashContent(SKILL_A)]])
    const out = compareSkills(actual, lock([]))
    expect(out[0]?.kind).toBe('extra')
  })

  it('三類同時出現 → 全數回報', () => {
    const actual = new Map([
      ['changed-one', hashContent(SKILL_B)],
      ['extra-one', hashContent(SKILL_A)],
    ])
    const out = compareSkills(
      actual,
      lock([
        { name: 'changed-one', sha256: hashContent(SKILL_A) },
        { name: 'missing-one', sha256: hashContent(SKILL_A) },
      ]),
    )
    expect(out.map((m) => m.kind).sort()).toEqual(['changed', 'extra', 'missing'])
  })
})

describe('loadLock', () => {
  it('合法 lock → 讀出', () => {
    const p = writeLock('ok.json', { version: 1, skills: [{ name: 'a', sha256: 'f'.repeat(64) }] })
    expect(loadLock(p).skills[0]?.name).toBe('a')
  })

  it('檔案不存在 → CliError', () => {
    expect(() => loadLock(join(tmp, 'nope.json'))).toThrow(CliError)
  })

  it('壞 JSON → CliError', () => {
    const p = join(tmp, 'bad.json')
    writeFileSync(p, '{not json')
    expect(() => loadLock(p)).toThrow(/非合法 JSON/)
  })

  it('sha256 非 64 位 hex → CliError（防止假 hash 混入）', () => {
    const p = writeLock('badsha.json', { version: 1, skills: [{ name: 'a', sha256: 'xyz' }] })
    expect(() => loadLock(p)).toThrow(/sha256/)
  })

  it('version 非 1 → CliError', () => {
    const p = writeLock('badver.json', { version: 2, skills: [] })
    expect(() => loadLock(p)).toThrow(CliError)
  })

  it('JSON 頂層非物件 → CliError 且訊息含 (root)', () => {
    const p = writeLock('rootlvl.json', 'not-an-object')
    expect(() => loadLock(p)).toThrow(/\(root\)/)
  })
})

describe('validateFrontmatter', () => {
  it('合法 → 無錯誤', () => {
    expect(validateFrontmatter(SKILL_A)).toEqual([])
  })

  it('缺 frontmatter → 報錯', () => {
    expect(validateFrontmatter('no frontmatter here')).toContain('缺少 YAML frontmatter（--- 區塊）')
  })

  it('name 非 kebab-case → 報錯（DSH 會靜默丟棄）', () => {
    expect(validateFrontmatter('---\nname: BadName\ndescription: d\n---\n').join()).toMatch(/kebab-case/)
  })

  it('缺 description → 報錯', () => {
    expect(validateFrontmatter('---\nname: ok-name\n---\n')).toContain('frontmatter 缺 description')
  })

  it('缺 name → 報錯', () => {
    expect(validateFrontmatter('---\ndescription: d\n---\n')).toContain('frontmatter 缺 name')
  })
})

describe('main --verify', () => {
  it('一致 → ok true', () => {
    const root = makeSkills('v-ok', { alpha: SKILL_A })
    const lock = writeLock('v-ok.json', { version: 1, skills: [{ name: 'alpha', sha256: hashContent(SKILL_A) }] })
    const out = main(['--verify', '--lock', lock, '--skills-dir', root])
    expect(out).toMatchObject({ mode: 'verify', ok: true, checked: 1 })
  })

  it('缺技能 → ok false 且列出 missing', () => {
    const root = makeSkills('v-missing', { alpha: SKILL_A })
    const lock = writeLock('v-missing.json', {
      version: 1,
      skills: [
        { name: 'alpha', sha256: hashContent(SKILL_A) },
        { name: 'factory-stop-rules', sha256: hashContent(SKILL_B) },
      ],
    })
    const out = main(['--verify', '--lock', lock, '--skills-dir', root])
    expect(out).toMatchObject({ ok: false })
    expect(out.mode === 'verify' && out.mismatches[0]?.name).toBe('factory-stop-rules')
  })
})

describe('main --update', () => {
  it('寫出 lock 並含所有技能', () => {
    const root = makeSkills('u1', { alpha: SKILL_A, beta: SKILL_B })
    const lock = join(tmp, 'u1.json')
    const out = main(['--update', '--lock', lock, '--skills-dir', root])
    expect(out.mode === 'update' && out.skills.map((s) => s.name)).toEqual(['alpha', 'beta'])
    expect(loadLock(lock).skills).toHaveLength(2)
  })

  it('冪等：連跑兩次結果相同', () => {
    const root = makeSkills('u2', { alpha: SKILL_A })
    const lock = join(tmp, 'u2.json')
    main(['--update', '--lock', lock, '--skills-dir', root])
    const first = readFileSync(lock, 'utf8')
    main(['--update', '--lock', lock, '--skills-dir', root])
    expect(readFileSync(lock, 'utf8')).toBe(first)
  })

  it('保留既有 lastChangedPR（--update 只同步 hash，不清來源紀錄）', () => {
    const root = makeSkills('u3', { alpha: SKILL_A })
    const lock = writeLock('u3.json', {
      version: 1,
      skills: [{ name: 'alpha', sha256: '0'.repeat(64), lastChangedPR: 77 }],
    })
    const out = main(['--update', '--lock', lock, '--skills-dir', root])
    expect(out.mode === 'update' && out.skills[0]).toEqual({
      name: 'alpha',
      sha256: hashContent(SKILL_A),
      lastChangedPR: 77,
    })
  })

  it('--pr 覆寫 lastChangedPR', () => {
    const root = makeSkills('u4', { alpha: SKILL_A })
    const lock = join(tmp, 'u4.json')
    const out = main(['--update', '--lock', lock, '--skills-dir', root, '--pr', '99'])
    expect(out.mode === 'update' && out.skills[0]?.lastChangedPR).toBe(99)
  })

  it('lock 原本不存在 → 仍可建立（首次導入）', () => {
    const root = makeSkills('u5', { alpha: SKILL_A })
    const lock = join(tmp, 'u5-new.json')
    expect(() => main(['--update', '--lock', lock, '--skills-dir', root])).not.toThrow()
    expect(loadLock(lock).skills).toHaveLength(1)
  })
})

describe('main --promote（人類放行，docs/25 §4.3）', () => {
  function makeProposal(dir: string, name: string, content: string): string {
    const root = join(tmp, dir)
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, 'SKILL.md'), content)
    return root
  }

  it('合法提案 → 複製到 skills 目錄並更新 lock', () => {
    const proposals = makeProposal('p1', 'new-skill', '---\nname: new-skill\ndescription: d\n---\nsteps')
    const skillsDir = join(tmp, 'p1-skills')
    mkdirSync(skillsDir, { recursive: true })
    const lock = writeLock('p1.json', { version: 1, skills: [] })
    const out = main([
      '--promote', 'new-skill',
      '--lock', lock, '--skills-dir', skillsDir, '--proposals-dir', proposals,
    ])
    expect(out.mode).toBe('promote')
    expect(readFileSync(join(skillsDir, 'new-skill', 'SKILL.md'), 'utf8')).toContain('steps')
    expect(loadLock(lock).skills.map((s) => s.name)).toContain('new-skill')
  })

  it('提案不存在 → CliError', () => {
    const lock = writeLock('p2.json', { version: 1, skills: [] })
    expect(() =>
      main(['--promote', 'ghost', '--lock', lock, '--skills-dir', tmp, '--proposals-dir', join(tmp, 'none')]),
    ).toThrow(/提案不存在/)
  })

  it('frontmatter 不合法 → 拒絕 promote（fail closed：DSH 會靜默丟棄）', () => {
    const proposals = makeProposal('p3', 'bad-skill', 'no frontmatter')
    const skillsDir = join(tmp, 'p3-skills')
    mkdirSync(skillsDir, { recursive: true })
    const lock = writeLock('p3.json', { version: 1, skills: [] })
    expect(() =>
      main(['--promote', 'bad-skill', '--lock', lock, '--skills-dir', skillsDir, '--proposals-dir', proposals]),
    ).toThrow(/frontmatter 不合法/)
  })

  it('名稱非 kebab-case → CliError', () => {
    expect(() => main(['--promote', 'BadName'])).toThrow(/kebab-case/)
  })

  it('重複 promote → lock 內不產生重複條目（取代而非追加）', () => {
    const proposals = makeProposal('p4', 'dup-skill', '---\nname: dup-skill\ndescription: d\n---\nx')
    const skillsDir = join(tmp, 'p4-skills')
    mkdirSync(skillsDir, { recursive: true })
    const lock = writeLock('p4.json', { version: 1, skills: [] })
    const args = ['--promote', 'dup-skill', '--lock', lock, '--skills-dir', skillsDir, '--proposals-dir', proposals]
    main(args)
    main(args)
    expect(loadLock(lock).skills.filter((s) => s.name === 'dup-skill')).toHaveLength(1)
  })

  it('lock 不存在 → 仍可 promote（首次）', () => {
    const proposals = makeProposal('p5', 'first-skill', '---\nname: first-skill\ndescription: d\n---\nx')
    const skillsDir = join(tmp, 'p5-skills')
    mkdirSync(skillsDir, { recursive: true })
    const lock = join(tmp, 'p5-absent.json')
    expect(() =>
      main(['--promote', 'first-skill', '--lock', lock, '--skills-dir', skillsDir, '--proposals-dir', proposals]),
    ).not.toThrow()
  })

  it('lock 已有其他技能 → promote 後依名稱排序（穩定 diff，便於審查）', () => {
    const proposals = makeProposal('p7', 'aaa-skill', '---\nname: aaa-skill\ndescription: d\n---\nx')
    const skillsDir = join(tmp, 'p7-skills')
    mkdirSync(skillsDir, { recursive: true })
    // 既有兩筆且刻意非字母序，證明 promote 會重新排序而非直接追加
    const lock = writeLock('p7.json', {
      version: 1,
      skills: [
        { name: 'zzz-skill', sha256: 'a'.repeat(64) },
        { name: 'mmm-skill', sha256: 'b'.repeat(64) },
      ],
    })
    main(['--promote', 'aaa-skill', '--lock', lock, '--skills-dir', skillsDir, '--proposals-dir', proposals])
    expect(loadLock(lock).skills.map((s) => s.name)).toEqual(['aaa-skill', 'mmm-skill', 'zzz-skill'])
  })

  it('--pr 記入 lastChangedPR（稽核來源 PR）', () => {
    const proposals = makeProposal('p6', 'pr-skill', '---\nname: pr-skill\ndescription: d\n---\nx')
    const skillsDir = join(tmp, 'p6-skills')
    mkdirSync(skillsDir, { recursive: true })
    const lock = writeLock('p6.json', { version: 1, skills: [] })
    main([
      '--promote', 'pr-skill', '--pr', '123',
      '--lock', lock, '--skills-dir', skillsDir, '--proposals-dir', proposals,
    ])
    expect(loadLock(lock).skills.find((s) => s.name === 'pr-skill')?.lastChangedPR).toBe(123)
  })
})
