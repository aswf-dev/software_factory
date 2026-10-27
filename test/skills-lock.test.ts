/**
 * Verify V2 Task 4：vendored `lean-formal-verification` 與驗證類 task 的 skill 派送。
 *
 * 派送政策（controller 裁決）：
 *  - `lean-formal-verification` 只派送給 `agent-verify-lean`（onlyFor）。它的 description
 *    會在「verify/prove this code」觸發，若不限定，會外溢到 quint／grill／tests 等驗證工單。
 *  - `quint-lang`／`quint-modeling` 維持全域（agent-verify-quint 已經拿得到），不改。
 *  - `hegel`／`hegel-review` 維持只給 `agent-pbt-audit`。
 *  - `agent-verify-grill`／`agent-verify-tests` 不新增任何專屬 skill。
 *
 * 測試直接跑 CLI 的 `main`（與 factory-run.yml 呼叫的是同一條路徑），對象是 repo 內的
 * 真實 lock 與 `.dsh/skills`，不是 fixture——要防的正是真實設定的漂移。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LOCK_PATH,
  DEFAULT_SKILLS_DIR,
  hashBundle,
  loadLock,
  main,
} from '../src/cli/factory-skills-lock.js'

const ROOT = join(import.meta.dirname, '..')
const LOCK = join(ROOT, DEFAULT_LOCK_PATH)
const SKILLS = join(ROOT, DEFAULT_SKILLS_DIR)
const LEAN = 'lean-formal-verification'
const LEAN_DIR = join(SKILLS, LEAN)
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

const excludedFor = (taskType: string): string[] => {
  const out = main(['--excluded-for', taskType, '--lock', LOCK])
  if (out.mode !== 'excluded-for') throw new Error(`unexpected mode ${out.mode}`)
  return out.excluded
}

describe('skills-lock：驗證類 task 的 skill 派送（Verify V2 Task 4）', () => {
  it('lock 通過 schema 驗證並登錄 lean-formal-verification', () => {
    const lock = loadLock(LOCK)
    expect(lock.skills.map((s) => s.name)).toContain(LEAN)
  })

  it('lean-formal-verification 只派送給 agent-verify-lean', () => {
    const entry = loadLock(LOCK).skills.find((s) => s.name === LEAN)
    expect(entry?.onlyFor).toEqual(['agent-verify-lean'])
  })

  it('非 lean 類型的 run 排除 lean-formal-verification', () => {
    for (const t of ['agent-verify-quint', 'agent-verify-grill', 'agent-verify-tests', 'agent-add-tests', 'agent-pbt-audit']) {
      expect(excludedFor(t), t).toContain(LEAN)
    }
  })

  it('agent-verify-lean 的 run 載入 lean-formal-verification', () => {
    expect(excludedFor('agent-verify-lean')).not.toContain(LEAN)
  })

  it('agent-verify-quint 載入 quint-lang／quint-modeling（全域派送不變）', () => {
    const lock = loadLock(LOCK)
    for (const name of ['quint-lang', 'quint-modeling']) {
      expect(lock.skills.find((s) => s.name === name)?.onlyFor, name).toBeUndefined()
      expect(excludedFor('agent-verify-quint'), name).not.toContain(name)
    }
  })

  it('hegel／hegel-review 仍只給 agent-pbt-audit；grill／tests 無新增專屬 skill', () => {
    const lock = loadLock(LOCK)
    for (const name of ['hegel', 'hegel-review']) {
      expect(lock.skills.find((s) => s.name === name)?.onlyFor, name).toEqual(['agent-pbt-audit'])
    }
    const onlyForTypes = lock.skills.flatMap((s) => s.onlyFor ?? [])
    expect(onlyForTypes).not.toContain('agent-verify-grill')
    expect(onlyForTypes).not.toContain('agent-verify-tests')
    expect(onlyForTypes).not.toContain('agent-verify-quint')
  })
})

describe('vendored lean-formal-verification bundle', () => {
  it('SKILL.md 與 scripts/verify-lean.sh 存在，frontmatter name 與目錄同名', () => {
    expect(existsSync(join(LEAN_DIR, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(LEAN_DIR, 'scripts/verify-lean.sh'))).toBe(true)
    expect(read(`${DEFAULT_SKILLS_DIR}/${LEAN}/SKILL.md`)).toMatch(new RegExp(`^name: ${LEAN}$`, 'm'))
  })

  it('templates/lean-toolchain 釘在 leanprover/lean4:v4.35.0（Global Constraints）', () => {
    expect(read(`${DEFAULT_SKILLS_DIR}/${LEAN}/templates/lean-toolchain`)).toContain('leanprover/lean4:v4.35.0')
  })

  it('不含 build 產物（.lake/）', () => {
    expect(existsSync(join(LEAN_DIR, 'examples/java-order-status/.lake'))).toBe(false)
    expect(existsSync(join(LEAN_DIR, 'templates/.lake'))).toBe(false)
  })

  it('完整性檢查通過：lock 的 sha256 等於實際 bundle 雜湊，--verify 為 ok 且無 model id', () => {
    const entry = loadLock(LOCK).skills.find((s) => s.name === LEAN)
    expect(entry?.sha256).toBe(hashBundle(LEAN_DIR))
    // 不帶 --task-type：repo 內的 .dsh/skills 是全集（含 hegel），每個 lock 條目都必須在場且雜湊相符
    const out = main(['--verify', '--lock', LOCK, '--skills-dir', SKILLS])
    expect(out).toMatchObject({ mode: 'verify', ok: true, mismatches: [] })
    if (out.mode === 'verify') {
      expect(out.modelPins.find((p) => p.name === LEAN)).toBeUndefined()
    }
  })

  it('NOTICE 記錄上游出處與內容雜湊（原樣 vendor，比照 quint／hegel）', () => {
    const notice = read('NOTICE')
    expect(notice).toContain(`.dsh/skills/${LEAN}/`)
    expect(notice).toContain('https://github.com/philipz/skills')
    // 上游 commit 與該目錄的 git tree（＝ ~/.agents/.skill-lock.json 的 skillFolderHash）
    expect(notice).toContain('924bdcd424da4827ba6777a7432916f05c2ca944')
    expect(notice).toContain('dd800943d74c2ae4d8e28d54a5658935dc6f7a87')
    expect(notice).toContain(hashBundle(LEAN_DIR))
  })
})
