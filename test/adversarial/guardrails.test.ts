/**
 * Adversarial guardrail tests (docs/11-test-strategy.md §5).
 *
 * Ordinary tests ask "does it work?". These ask "does it actually block?".
 *
 * Several guardrails are configuration rather than code, and a broken one shows
 * NO functional symptom — the factory keeps running while the protection is
 * silently gone. Only a test catches that.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { score } from '../../src/scoring/score.js'
import type { HardRuleId } from '../../src/scoring/types.js'

const ROOT = join(import.meta.dirname, '../..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

interface RiskPathsFile {
  hard_rules: Partial<Record<HardRuleId, readonly string[]>>
}

const riskPaths = load(read('.github/factory/risk-paths.yml')) as RiskPathsFile
const patterns = riskPaths.hard_rules
const codeowners = read('CODEOWNERS')
const catalog = read('catalog-info.yaml')

/** Paths the agent must never be able to change unreviewed (docs/05 §1.1). */
const GUARDRAIL_PATHS = [
  '.github/workflows/factory-run.yml',
  '.github/workflows/test.yml',
  '.github/factory/risk-paths.yml',
  '.github/factory/task-template.txt',
  '.github/factory/quint-paths.yml',
  'CODEOWNERS',
  'catalog-info.yaml',
  '.dsh/skills/factory-workflow/SKILL.md',
  '.dsh/skills/factory-pr-stacking/SKILL.md',
  '.dsh/skills/factory-self-review/SKILL.md',
  '.dsh/skills/factory-stop-rules/SKILL.md',
]

describe('核心不變量：agent 不得修改 guardrail 自身（docs/05 §1.1）', () => {
  it.each(GUARDRAIL_PATHS)('%s 觸發 H5 硬性規則 → risk=2', (path) => {
    const result = score({
      annotations: {
        businessCriticality: 'tactical',
        riskProfile: 'low',
        complexity: 'low',
      },
      changedPaths: [path],
      hardRulePatterns: patterns,
    })

    expect(result.triggeredHardRules).toContain('H5')
    expect(result.riskProfile.value).toBe(2)
    expect(result.automergeAllowed).toBe(false)
  })

  it.each(GUARDRAIL_PATHS)('%s 也受 CODEOWNERS 保護（第二層）', (path) => {
    // Dual-layer defence: scoring is the DSH-side policy, CODEOWNERS is the
    // GitHub-side mechanism. Neither may be relied on alone (docs/02 D4).
    const top = path.split('/')[0] as string
    const covered =
      codeowners.includes(`/${top}/`) || codeowners.includes(`/${path}`) ||
      codeowners.includes(`/${top}`)
    expect(covered, `${path} 未被 CODEOWNERS 覆蓋`).toBe(true)
  })
})

describe('dogfooding 防護：工廠不得自動合併自己的變更（docs/11 §1.2）', () => {
  it('catalog 明確關閉 agent-automerge', () => {
    expect(catalog).toMatch(/factory\.io\/agent-automerge:\s*"false"/)
  })

  it('即使變更微小且分數最低，仍不得自動合併', () => {
    const result = score({
      annotations: {
        businessCriticality: 'tactical',
        riskProfile: 'low',
        complexity: 'low',
        agentAutomerge: 'false',
      },
      changedPaths: ['README.md'],
      changedLines: 1,
      hardRulePatterns: patterns,
    })
    expect(result.automergeAllowed).toBe(false)
  })
})

describe('風險路徑設定的完整性（docs/06 §3.2）', () => {
  it('H1–H7 全部有定義，無遺漏', () => {
    for (const rule of ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7']) {
      expect(patterns[rule as HardRuleId], `${rule} 未定義`).toBeDefined()
      expect(patterns[rule as HardRuleId]?.length).toBeGreaterThan(0)
    }
  })

  it('H5 必須涵蓋全部 guardrail 檔案', () => {
    const h5 = patterns.H5 ?? []
    for (const needle of ['.github/**', 'CODEOWNERS', 'catalog-info.yaml', '.dsh/skills/**']) {
      expect(h5, `H5 缺少 ${needle}`).toContain(needle)
    }
  })
})

describe('CI 設定的安全性（docs/02 §7、docs/05 §2.1）', () => {
  const workflows = ['.github/workflows/test.yml']

  it.each(workflows)('%s 不使用 danger-full-access 沙箱', (wf) => {
    expect(read(wf)).not.toContain('danger-full-access')
  })

  it.each(workflows)('%s 宣告最小權限', (wf) => {
    expect(read(wf)).toMatch(/permissions:/)
  })

  it.each(workflows)('%s 設有逾時上限', (wf) => {
    // Without a timeout a hung agent burns cost until the platform cap
    // (docs/02 §6, docs/05 §5).
    expect(read(wf)).toMatch(/timeout-minutes:/)
  })

  it('test workflow 不授予寫入權限', () => {
    expect(read('.github/workflows/test.yml')).toMatch(/permissions:\s*\n\s*contents:\s*read/)
  })
})

describe('GitHub App 權限最小化（docs/02 D6）', () => {
  // D6 excludes Administration and Workflows precisely so the agent cannot
  // rewrite branch protection or CI. If a future change adds them back there is
  // no functional symptom — both guardrail layers would just quietly fail.
  it('文件中明確記載不授予 Administration 與 Workflows', () => {
    const arch = read('docs/02-architecture.md')
    expect(arch).toMatch(/\*\*Administration\*\*\s*\|\s*\*\*不授予\*\*/)
    expect(arch).toMatch(/\*\*Workflows\*\*\s*\|\s*\*\*不授予\*\*/)
  })
})
