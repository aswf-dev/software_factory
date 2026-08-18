import { describe, expect, it } from 'vitest'
import { matchHardRules } from './score.js'
import type { HardRuleId } from './types.js'

/**
 * Mutation-strength tests for `matchHardRules` (docs/06 §3.2, §5.2).
 *
 * Like `rescore-mutation.test.ts`, these tests exist to prove the suite has
 * TEETH, not merely line coverage. `matchHardRules` is the security-critical
 * gate that turns "CI 設定、授權邏輯、金流、schema 遷移…" into risk=2 before
 * the agent ever runs. A FALSE NEGATIVE here (a guarded path that is NOT
 * flagged) silently lowers oversight — the exact hole docs/06 §3.2 exists to
 * close. So every mutation below targets the *miss* direction: weaken the
 * matcher in some plausible way and confirm the test goes RED.
 *
 * Mutation log (verified by hand-editing src/scoring/score.ts and re-running
 * `npx vitest run src/scoring`, then reverting — see header of
 * rescore-mutation.test.ts for the same protocol):
 *
 *  | ID | Mutation                                                    | score.test  | This file |
 *  |----|-------------------------------------------------------------|-------------|-----------|
 *  | M-A | `changedPaths.some(...)` → `every(...)`                     | already RED | RED       |
 *  | M-B | `{ dot: true }` option dropped → defaults to `dot: false`    | GREEN       | RED       |
 *  | M-C | trailing `.sort()` on the returned list removed              | GREEN       | RED       |
 *  | M-D | inner loop reduced to the FIRST glob per rule only           | already RED | RED       |
 *
 * Each row was verified GREEN before mutation and RED after, then GREEN again
 * after reverting. M-B and M-C SURVIVED the pre-existing `score.test.ts` suite
 * (they are invisible there: no existing case uses a hidden path, and every
 * patterns map happens to be inserted in already-sorted order) — they are the
 * value this file adds. M-A and M-D are already killed by `score.test.ts` and
 * are anchored here in more explicit form, so the protection cannot silently
 * regress if those earlier tests are refactored (same split as M2/M4 in
 * rescore-mutation.test.ts).
 */

/** Mirrors the shape of .github/factory/risk-paths.yml (docs/06 §5.2). */
const H1 = ['src/auth/**', '**/authorization*', '**/*permission*']
const H4 = ['src/shared/**', 'src/core/**']
const H6 = ['migrations/**']

describe('M-A 變異：任一命中即觸發（some 改為 every 時失效）', () => {
  /**
   * The rule is triggered when ANY changed path matches ANY of its globs.
   * Changing `.some` to `.every` means a single safe path poisons the whole
   * query — a guarded change folded in with cleanup would stop flagging.
   */
  it('safe 與 guarded 路徑混合 → guarded 仍必須被標記', () => {
    const changedPaths = ['README.md', 'src/ui/button.ts', 'src/shared/model.ts']
    expect(matchHardRules(changedPaths, { H4 })).toEqual(['H4'])
  })

  it('多路徑中僅一個高風險 → 仍命中，且只累積到該規則', () => {
    const changedPaths = ['package.json', 'migrations/001_init.sql', 'scripts/seed.ts']
    expect(matchHardRules(changedPaths, { H4, H6 })).toEqual(['H6'])
  })
})

describe('M-B 變異：dot:true 被移除（隱藏檔不再視為命中）', () => {
  /**
   * `dot: true` is a deliberate fail-safe widening: a hidden file living
   * under a guarded directory (e.g. `.github/.env`, `src/.cache/`) is still a
   * guarded change. Dropping the option makes minimatch skip dot-segments, so
   * a glob like `src/**` silently stops matching hidden files — a quiet miss.
   */
  it('guardrail 目錄下的隱藏檔仍要觸發 H5', () => {
    // .github/** glob carries its own leading dot, but the deliberate option
    // must hold for globs that do not start with a dot too.
    expect(matchHardRules(['.github/.env.tpl'], { H5: ['.github/**'] })).toEqual(['H5'])
  })

  it('受守護目錄內、檔名帶前導點的變更仍具風險', () => {
    // Glob src/** (no leading dot) against a hidden file under src/.
    expect(matchHardRules(['src/.internal/keys.json'], { H3: ['src/**', '**/*secret*'] })).toEqual(['H3'])
    // Shorter spelling: hidden file at the seam of **/*secret*.
    expect(matchHardRules(['.prod/.secret'], { H3: ['**/*secret*'] })).toEqual(['H3'])
  })
})

describe('M-C 變異：回傳順序未排序（審查軌跡不確定）', () => {
  /**
   * The returned list is sorted so the audit trail is deterministic regardless
   * of the pattern map's insertion order. Dropping `.sort()` makes the order
   * follow the patterns object's key order, so a map written as {H6, H1}
   * would surface as [H6, H1] — a spurious-looking result that breaks any
   * stable downstream expectation.
   */
  it('patterns 鍵序與排序不同 → 仍回傳字典序', () => {
    // Keys intentionally out of order: H6, H4, H1.
    const patterns = {
      H6,
      H4,
      H1,
    } as Partial<Record<HardRuleId, readonly string[]>>

    const changedPaths = ['migrations/001.sql', 'src/core/kernel.ts', 'src/auth/session.ts']
    expect(matchHardRules(changedPaths, patterns)).toEqual(['H1', 'H4', 'H6'])
  })

  it('套用同樣 patterns 於多個路徑 → 每次結果次序一致', () => {
    const patterns = { H6, H1 } as Partial<Record<HardRuleId, readonly string[]>>
    const a = matchHardRules(['src/auth/a.ts', 'migrations/x.sql'], patterns)
    const b = matchHardRules(['migrations/x.sql', 'src/auth/a.ts'], patterns)
    expect(a).toEqual(b)
    expect(a).toEqual(['H1', 'H6'])
  })
})

describe('M-D 變異：只取每條規則的第一個 glob', () => {
  /**
   * A rule may carry several globs (H1 同時有「src/auth/**」與
   * 「** /authorization*」兩條 pattern)。Reducing the inner loop to the FIRST
   * glob would silently drop any hit whose path matches only a later glob —
   * another quiet false negative.
   */
  it('命中非首個 glob → 仍必須觸發該規則', () => {
    // H1: first glob src/auth/** does NOT match; the non-glob-string does.
    const changedPaths = ['src/ops/authorization-check.ts']
    expect(matchHardRules(changedPaths, { H1 })).toEqual(['H1'])
  })

  it('同一規則多個 glob 皆命中 → 只回報一次（去重）', () => {
    // Both src/auth/** and **/permission* match; the rule must appear once.
    const changedPaths = ['src/auth/guard.ts', 'src/roles/permission-map.ts']
    expect(matchHardRules(changedPaths, { H1 })).toEqual(['H1'])
  })
})
