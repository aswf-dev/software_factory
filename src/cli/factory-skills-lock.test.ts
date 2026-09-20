import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  compareSkills,
  detectModelIds,
  hashContent,
  loadLock,
  main,
  parseArgs,
  readSkillFiles,
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

describe('readSkillFiles', () => {
  it('回傳內容本身（scanSkills 與 model id 掃描共用同一份走訪）', () => {
    const root = makeSkills('rsf1', { alpha: SKILL_A })
    expect(readSkillFiles(root).get('alpha')).toBe(SKILL_A)
  })

  it('目錄不存在 → 空 Map', () => {
    expect(readSkillFiles(join(tmp, 'rsf-none')).size).toBe(0)
  })
})

describe('detectModelIds（ADR-011：skill 不得釘死具體模型）', () => {
  it('認得現役 id', () => {
    expect(detectModelIds('critical 用 claude-opus-5')).toEqual(['claude-opus-5'])
    expect(detectModelIds('預設 qwen3.8-flash')).toEqual(['qwen3.8-flash'])
    expect(detectModelIds('fallback deepseek-flash')).toEqual(['deepseek-flash'])
  })

  it('認得**已退役**的 id —— 這是本檢查存在的理由', () => {
    // deepseek-v4-pro 於 2026-09-11 自 model-tiers.yaml 移除、claude-fable-5 於
    // 2026-08-28 移除。若字典取自設定檔，兩者此刻都已測不到——而正是此刻起，
    // 釘著它們的 SKILL.md 才開始造成傷害。
    expect(detectModelIds('always use deepseek-v4-pro')).toEqual(['deepseek-v4-pro'])
    expect(detectModelIds('改用 claude-fable-5')).toEqual(['claude-fable-5'])
    expect(detectModelIds('deepseek-v4-flash 較省')).toEqual(['deepseek-v4-flash'])
  })

  it('未使用的廠商家族也認得（換 provider 時不留漏洞）', () => {
    expect(detectModelIds('gpt-5 / gemini-3 / mistral-7b / grok-4')).toEqual([
      'gemini-3',
      'gpt-5',
      'grok-4',
      'mistral-7b',
    ])
  })

  it('大小寫不敏感，且正規化為小寫', () => {
    expect(detectModelIds('Claude-Opus-5 與 GPT-5')).toEqual(['claude-opus-5', 'gpt-5'])
  })

  it('去重並排序（錯誤訊息要穩定可讀）', () => {
    expect(detectModelIds('gpt-5 ... claude-opus-5 ... gpt-5')).toEqual(['claude-opus-5', 'gpt-5'])
  })

  it('剝除句末標點（避免把句點報成 id 的一部分）', () => {
    expect(detectModelIds('use claude-opus-5.')).toEqual(['claude-opus-5'])
  })

  it('緊接中文字也偵測得到（無空白不構成規避）', () => {
    expect(detectModelIds('一律使用deepseek-flash')).toEqual(['deepseek-flash'])
  })

  it('路徑中的家族字不誤判（docs/claude-key）', () => {
    expect(detectModelIds('見 docs/claude-key 的說明')).toEqual([])
  })

  it('家族字單獨出現不誤判（"Claude Code"、"llama.cpp"）', () => {
    expect(detectModelIds('本工廠由 Claude Code 操作，llama.cpp 為本機推論')).toEqual([])
  })

  it('指稱 tier 而非 id → 乾淨（這正是被要求改寫成的形態）', () => {
    expect(detectModelIds('模型由 tier 決定：low／medium／high／critical，見 config/dsh/model-tiers.yaml')).toEqual([])
  })

  it('全部既有技能措辭風格的長文不誤判（無 id 即空）', () => {
    expect(detectModelIds(SKILL_A + SKILL_B)).toEqual([])
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

  it('技能內無 model id → modelPins 為空', () => {
    const root = makeSkills('v-nopin', { alpha: SKILL_A })
    const lock = writeLock('v-nopin.json', {
      version: 1,
      skills: [{ name: 'alpha', sha256: hashContent(SKILL_A) }],
    })
    const out = main(['--verify', '--lock', lock, '--skills-dir', root])
    expect(out.mode === 'verify' && out.modelPins).toEqual([])
  })

  it('已生效技能釘死 model id → 列入 modelPins，但 ok 不變（傳輸完整性仍然一致）', () => {
    // ok 若被內容政策污染，workflow 既有的 ::warning:: 就無法分辨該重同步還是該改文字。
    const pinned = '---\nname: pinned-skill\ndescription: d\n---\n測試失敗時改用 deepseek-v4-pro'
    const root = makeSkills('v-pin', { alpha: SKILL_A, 'pinned-skill': pinned })
    const lock = writeLock('v-pin.json', {
      version: 1,
      skills: [
        { name: 'alpha', sha256: hashContent(SKILL_A) },
        { name: 'pinned-skill', sha256: hashContent(pinned) },
      ],
    })
    const out = main(['--verify', '--lock', lock, '--skills-dir', root])
    expect(out.mode === 'verify' && out.ok).toBe(true)
    expect(out.mode === 'verify' && out.modelPins).toEqual([
      { name: 'pinned-skill', ids: ['deepseek-v4-pro'] },
    ])
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

  it('提案含具體 model id → 拒絕 promote（fail closed，ADR-011）', () => {
    const proposals = makeProposal(
      'p8',
      'pin-skill',
      '---\nname: pin-skill\ndescription: d\n---\n遇到複雜任務時一律改用 claude-opus-5',
    )
    const skillsDir = join(tmp, 'p8-skills')
    mkdirSync(skillsDir, { recursive: true })
    const lock = writeLock('p8.json', { version: 1, skills: [] })
    const args = ['--promote', 'pin-skill', '--lock', lock, '--skills-dir', skillsDir, '--proposals-dir', proposals]
    expect(() => main(args)).toThrow(/claude-opus-5/)
    expect(() => main(args)).toThrow(/model-tiers\.yaml/)
    // 真的沒放行：既沒複製檔案，也沒寫進 lock
    expect(() => readFileSync(join(skillsDir, 'pin-skill', 'SKILL.md'), 'utf8')).toThrow()
    expect(loadLock(lock).skills).toEqual([])
  })

  it('改為指稱 tier 的同一份提案 → 放行（證明擋的是 id 不是主題）', () => {
    const proposals = makeProposal(
      'p9',
      'tier-skill',
      '---\nname: tier-skill\ndescription: d\n---\n遇到複雜任務時提高 tier（見 config/dsh/model-tiers.yaml）',
    )
    const skillsDir = join(tmp, 'p9-skills')
    mkdirSync(skillsDir, { recursive: true })
    const lock = writeLock('p9.json', { version: 1, skills: [] })
    expect(() =>
      main(['--promote', 'tier-skill', '--lock', lock, '--skills-dir', skillsDir, '--proposals-dir', proposals]),
    ).not.toThrow()
    expect(loadLock(lock).skills.map((s) => s.name)).toEqual(['tier-skill'])
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
