import { describe, expect, it } from 'vitest'
import { compareReportToActual, parseArgs, type CrosscheckActual } from './factory-crosscheck.js'
import { CliError } from './run-cli.js'

/**
 * Mutation-strength tests for the `--propose-skill-only` scope gate
 * (E6、ADR-016 §3 閘門 1)。
 *
 * **這是 ADR-016 全部安全性的所在**。提案型別之所以安全，只因為兩件事同時成立：
 *   1. 產出寫入 `proposals/skills/`，該路徑不在任何 DSH 探索 rank 上
 *      （2026-09-06 以真實 dsh headless 實測確認：`.dsh/skills/` 下的對照探針
 *      被發現，`proposals/` 下的探針未被發現）→ **誤合併也不生效**
 *   2. crosscheck 以**白名單**強制 agent 只能寫那裡
 *
 * 若第 2 點被放寬成黑名單、或允許清單混入 `.dsh/`，agent 就能自訂自己的行為
 * 準則並自我放行——`docs/05` §1.1（agent 不得鬆綁自身約束）與 `docs/06` §4.3
 * （不得驗證自己的產出並據以放行）同時失效，`factory-stop-rules` 可被覆寫。
 *
 *  | ID | Mutation                                                         | Before | After |
 *  |----|------------------------------------------------------------------|--------|-------|
 *  | M1 | 允許清單混入 `.dsh/`（白名單被撐開）                                 | GREEN  | RED   |
 *  | M2 | 白名單改為黑名單（只擋 src/，其餘放行）                              | GREEN  | RED   |
 *  | M3 | `proposals/skills/` 前綴比對改為寬鬆 includes（可被 `x/proposals/skills` 繞過）| GREEN | RED |
 *  | M4 | 兩個「僅產出」模式可同時指定（允許清單語意含糊）                        | GREEN  | RED   |
 *
 * 驗證方式：手改 src/cli/factory-crosscheck.ts 套用變異 → 重跑本檔變紅 → 還原 → 變綠。
 */

const actualOf = (paths: string[]): CrosscheckActual => ({
  branches: ['factory/12-01-propose'],
  paths,
  added: 20,
  deleted: 0,
  uncommitted: [],
})

/** 以 propose-skill 模式比對，回傳是否觸發範圍違規。 */
function scopeViolated(paths: string[]): boolean {
  const m = compareReportToActual({ changedPaths: paths, changedLines: 20 }, actualOf(paths), false, true)
  return m.some((x) => x.kind === 'propose-skill-scope')
}

describe('M1/M2 變異：允許清單被撐開或改為黑名單', () => {
  /**
   * `.dsh/skills/` 是 rank 100（最高優先）的探索路徑——寫進去等於立即生效。
   * 這條若失守，提案與生效的分離就不存在了。
   */
  it('.dsh/skills/ 變更必須被擋（rank 100，寫入即生效）', () => {
    expect(scopeViolated(['.dsh/skills/evil/SKILL.md'])).toBe(true)
  })

  it('.dsh/ 下任何路徑都必須被擋（不只 skills 子目錄）', () => {
    expect(scopeViolated(['.dsh/settings.yaml'])).toBe(true)
  })

  it('.agents/skills/ 變更必須被擋（rank 200，同樣是探索路徑）', () => {
    expect(scopeViolated(['.agents/skills/evil/SKILL.md'])).toBe(true)
  })

  it('.github/ 與 catalog-info.yaml 必須被擋（guardrail 本體）', () => {
    expect(scopeViolated(['.github/workflows/factory-run.yml'])).toBe(true)
    expect(scopeViolated(['catalog-info.yaml'])).toBe(true)
  })

  it('src/ 必須被擋（提案型別不產生程式碼）', () => {
    expect(scopeViolated(['src/cli/factory-judge.ts'])).toBe(true)
  })

  it('config/factory/skills-lock.json 必須被擋（否則可自行登錄技能）', () => {
    expect(scopeViolated(['config/factory/skills-lock.json'])).toBe(true)
  })

  it('proposals/skills/ 與 docs/ 仍可寫（錨定，避免過度收緊）', () => {
    expect(scopeViolated(['proposals/skills/a-b/SKILL.md'])).toBe(false)
    expect(scopeViolated(['docs/25-skill-authoring-loop.md'])).toBe(false)
    expect(scopeViolated(['proposals/skills/a-b/SKILL.md', 'docs/x.md'])).toBe(false)
  })
})

describe('M3 變異：前綴比對被放寬成 includes', () => {
  /**
   * 若把 `startsWith('proposals/skills/')` 改成 `includes('proposals/skills')`，
   * 攻擊者可用 `.dsh/skills/proposals/skills/evil/SKILL.md` 這種路徑穿過白名單
   * ——路徑看起來含有允許片段，實際卻落在 rank 100 的探索目錄下。
   */
  it('含有 proposals/skills 片段但不在開頭 → 仍必須被擋', () => {
    expect(scopeViolated(['.dsh/skills/proposals/skills/evil/SKILL.md'])).toBe(true)
  })

  it('相對路徑跳脫（../）不得繞過', () => {
    expect(scopeViolated(['../proposals/skills/evil/SKILL.md'])).toBe(true)
  })

  it('僅 docs 片段不在開頭 → 仍必須被擋', () => {
    expect(scopeViolated(['src/docs/x.ts'])).toBe(true)
  })
})

describe('M4 變異：兩個僅產出模式可同時指定', () => {
  /**
   * analyze 允許 `docs/**`；propose-skill 允許 `proposals/skills/**` 與 `docs/**`。
   * 同時開啟會讓「實際生效的允許清單」變得含糊，而含糊時最寬鬆的那一套會成為
   * 實際規則——正是 factory-judge.ts 檔首警告的失敗模式。
   */
  it('同時指定 --analyze-only 與 --propose-skill-only → CliError', () => {
    expect(() => parseArgs(['12', 'r.json', '--analyze-only', '--propose-skill-only'])).toThrow(CliError)
  })

  it('各自單獨指定仍可用（錨定）', () => {
    expect(parseArgs(['12', 'r.json', '--analyze-only']).analyzeOnly).toBe(true)
    expect(parseArgs(['12', 'r.json', '--propose-skill-only']).proposeSkillOnly).toBe(true)
  })
})
