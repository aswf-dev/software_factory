/**
 * Adversarial tests for Phase-1 factory assets (docs/11 §5).
 *
 * These files are configuration, not code: a broken one shows NO functional
 * symptom — the factory keeps running while a protection silently disappears.
 * Only a test catches that.
 *
 * 本檔定義「契約」：Task 5–8 與 Task 16–20 依此建立檔案後轉綠。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DOD_LABELS } from '../../src/cli/factory-issue-check.js'

const ROOT = join(import.meta.dirname, '../..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

const SKILLS: Record<string, string> = {
  'factory-workflow': '主流程',
  'factory-pr-stacking': 'stacked PR',
  'factory-self-review': '自審',
  'factory-stop-rules': '停手',
}

describe('factory skills 存在且 frontmatter 有效（dsh-skill-filesystem 契約）', () => {
  for (const [name, hint] of Object.entries(SKILLS)) {
    it(`${name}/SKILL.md 存在、name 為 kebab-case、含 description 與 ${hint} 內容`, () => {
      const p = `.dsh/skills/${name}/SKILL.md`
      const content = read(p)
      expect(content).toMatch(/^---\nname: /)
      expect(content).toMatch(new RegExp(`^name: ${name}$`, 'm'))
      expect(content).toMatch(/^description: /m)
    })
  }
})

describe('factory-stop-rules 含關鍵禁令', () => {
  const content = read('.dsh/skills/factory-stop-rules/SKILL.md')
  it('明寫 sync 優先於 rebase', () => {
    expect(content).toContain('gh stack sync')
    expect(content).not.toContain('gh stack rebase --continue') // 不鼓勵互動式 rebase
  })
  it('包含 needs-human 交還語意', () => {
    expect(content).toContain('needs-human')
  })
})

// Issue #192（P0-2，SWEBOK Ch1 §6.2–6.3 需求變更控制）：發現需求與 Issue
// 描述不符時，處置權屬於人類——skill 必須明寫停手條款且禁止 agent 自行擴大範圍。
// 這些檔案是「配置而非程式碼」：條款被靜默移除時不會有任何功能徵兆，只有測試抓得到。
describe('factory-stop-rules 需求變更控制條款（Issue #192）', () => {
  const content = read('.dsh/skills/factory-stop-rules/SKILL.md')
  it('SKILL.md 含需求與 Issue 不符的停手條款（缺漏／矛盾／範圍歧義）', () => {
    expect(content).toContain('需求變更控制')
    expect(content).toMatch(/需求與 Issue 描述不符/)
    expect(content).toMatch(/缺漏／矛盾／範圍歧義/)
  })
  it('條款明寫「不自行擴大範圍」與人類的後續處置（更新 Issue 重跑或開新 Issue）', () => {
    expect(content).toContain('不自行擴大範圍')
    expect(content).toMatch(/更新 Issue/)
    expect(content).toMatch(/開新 Issue/)
  })
  it('docs/07 交叉引用該條款（處置路徑在流程文件可見）', () => {
    const docs07 = read('docs/07-stacked-pr-workflow.md')
    expect(docs07).toContain('需求變更控制')
    expect(docs07).toMatch(/stop-rules.*第 8 條|第 8 條.*stop-rules/)
  })
})

describe('factory-pr-stacking 含 CI 執行細節', () => {
  const content = read('.dsh/skills/factory-pr-stacking/SKILL.md')
  it('-m 必填、submit --auto、sync 優先於 rebase', () => {
    expect(content).toContain('-m')
    expect(content).toContain('--auto')
    expect(content).toContain('gh stack sync')
  })
})

describe('factory-workflow 含 report.json 契約', () => {
  const content = read('.dsh/skills/factory-workflow/SKILL.md')
  it('要求 agent 寫 .factory/run/report.json 並列出欄位', () => {
    expect(content).toContain('.factory/run/report.json')
    for (const field of [
      'changedPaths',
      'changedLines',
      'assertionDelta',
      'addedDependencies',
      'syncFailures',
      'hasAcceptanceCriteria',
    ]) {
      expect(content).toContain(field)
    }
  })
})

describe('task-template 自足且指向 skills', () => {
  const content = read('.github/factory/task-template.txt')
  it('含 <ISSUE> 佔位與 skills 指示，不含 skill 內文（避免漂移）', () => {
    expect(content).toContain('<ISSUE>')
    expect(content).toContain('.dsh/skills')
    expect(content).not.toContain('gh stack sync') // 任務描述不重複 skill 內容（docs/04 §3.4）
  })
})

describe('task-template 完成後立即停止（防 agent 開完 PR 後空轉不退出）', () => {
  // 實測（issue #35，run 32821356056）：agent 開完 3 個 stacked PR（07:32）後沒有結束
  // turn——DSH headless 的 whenIdle 等 agent 靜止，agent-loop 因 inbox 持續有 pending
  // 一直開新 turn，run 卡到被取消（07:41）都未退出。根因：模板只有「完成後留言 + 寫
  // report」，沒有「完成後立即停止」——LLM 傾向繼續自我對話/驗證。
  //
  // 契約：每個 task-template 都必須明確指示「所有步驟完成後立即停止」，不繼續任何
  // 額外工作/驗證/輸出。缺此指示的模板會讓 agent 在 CI 空轉直到 50min timeout。
  const TEMPLATES = [
    'task-template.txt',
    'task-template-add-tests.txt',
    'task-template-fix-bug.txt',
    'task-template-update-deps.txt',
    'task-template-write-docs.txt',
  ]

  it('全部 5 個 task-template 含「完成後立即停止」指示（防 CI 空轉）', () => {
    for (const t of TEMPLATES) {
      const c = read(`.github/factory/${t}`)
      expect(c, `${t} 缺「完成後立即停止」指示`).toMatch(/立即停止|立即結束|停止任何額外/)
    }
  })

  it('停止指示與輸出紀律相鄰（同在收尾步驟，防止 LLM 略過）', () => {
    for (const t of TEMPLATES) {
      const c = read(`.github/factory/${t}`)
      const stopIdx = c.search(/立即停止|立即結束/)
      const reportIdx = c.indexOf('report.json')
      // 停止指示必須在 report.json 之後（收尾的最後一步）——若在前面，agent 可能
      // 在寫 report 前就停止
      expect(stopIdx, `${t} 停止指示位置錯誤`).toBeGreaterThan(reportIdx)
    }
  })
})

describe('add-tests 劃界一致（#198：test-only 單層＋揭露缺陷 it.skip 流程）', () => {
  // 2026-09-01 共識：add-tests 模板曾寫「01-test→02-impl→03-docs」三層、skill 寫
  // 「01-test 層是主體」單層——agent 收到衝突指令。契約（防止再次漂移）：
  // 1) add-tests = test-only 單層；2) 測試須在既有實作上直接綠燈；
  // 3) 揭露既有缺陷（紅且非測試自身錯誤）→ it.skip 交付＋Issue 留言＋建議開
  //    fix-bug 工作項（沿用 fix-bug 機制，不停手）。fix-bug 模板不在本次範圍。
  const tpl = read('.github/factory/task-template-add-tests.txt')
  const skill = read('.dsh/skills/factory-workflow/SKILL.md')

  it('add-tests 模板為單層指令（無三層殘留）', () => {
    expect(tpl).toContain('01-test')
    expect(tpl).toContain('單層')
    expect(tpl).not.toContain('02-impl')
    expect(tpl).not.toContain('03-docs')
  })
  it('add-tests 模板明寫綠燈要求與 it.skip 缺陷流程（不猜測、不停手）', () => {
    expect(tpl).toMatch(/既有實作上直接綠燈/)
    expect(tpl).toContain('it.skip')
    expect(tpl).toContain('斷言完整保留')
    expect(tpl).toContain('fix-bug')
    expect(tpl).toContain('不停手')
  })
  it('factory-workflow skill 的 agent-add-tests 條目與模板一致', () => {
    const m = skill.match(/\*\*agent-add-tests\*\*：(.+)/)
    expect(m, 'skill 缺 agent-add-tests 條目').not.toBeNull()
    expect(m![1]).toContain('單層')
    expect(m![1]).toContain('直接綠燈')
    expect(m![1]).toContain('it.skip')
    expect(m![1]).toContain('斷言完整保留')
    expect(m![1]).toContain('fix-bug')
    expect(m![1]).toContain('不停手')
    expect(m![1]).toContain('誠實停手') // 保留「充分覆蓋→停手」條款
  })
  it('fix-bug 模板維持三層（本 Issue 範圍：不動 fix-bug）', () => {
    const fix = read('.github/factory/task-template-fix-bug.txt')
    expect(fix).toContain('02-impl')
    expect(fix).toContain('03-docs')
  })
})

describe('factory-run.yml 具備必要結構', () => {
  const content = read('.github/workflows/factory-run.yml')
  it('workflow_dispatch 輸入 issue_number 與 dry_run', () => {
    expect(content).toContain('issue_number')
    expect(content).toContain('dry_run')
  })
  it('含 concurrency 群組與 needs-human 處理', () => {
    expect(content).toContain('concurrency')
    expect(content).toContain('group: factory-')
    expect(content).toContain('needs-human')
  })
  it('呼叫 dist CLI 而非重寫判定邏輯', () => {
    expect(content).toContain('dist/cli/factory-score.js')
    expect(content).toContain('dist/cli/factory-judge.js')
  })
  it('guardrail patch 與鎖版 DSH', () => {
    expect(content).toContain('config/dsh/factory-guardrail.patch.yml')
    // DSH 鎖版：devDependency（package.json 精確 pin）→ npm ci（lockfile）安裝
    // 0.1.1-rc.2：credentials 檔改為 version:1 + refs: 格式（與執行中 harness 同步；
    // 0.1.0-rc.8 的解析器只認舊 flat layout，讀新格式會 boot 失敗）。
    expect(read('package.json')).toMatch(/"@deepseek-ai\/dsh": "\^?0\.1\.1-rc\.\d+"/)
    expect(content).toContain('npm ci')
  })
})

describe('factory-run.yml 多 repo 支援（Q-P2-1 統一，Phase 2 T4）', () => {
  const content = read('.github/workflows/factory-run.yml')
  it('含 repo 與 base_branch 輸入（統一後 base_branch 預設 software-factory）', () => {
    expect(content).toContain('repo:')
    expect(content).toContain('default: philipz/software_factory')
    expect(content).toContain('base_branch:')
    expect(content).toContain('default: software-factory')
  })
  it('Guard step：所有 repo 的 base_branch 一律不得為 main（含機制 repo，ADR-013 統一）', () => {
    expect(content).toMatch(/Guard base_branch safety/)
    expect(content).toContain('inputs.base_branch')
    expect(content).toContain('== "main"')
    // 統一後無「機制 repo 特例」——不再有 != "philipz/software_factory" 的放行條件
    expect(content).not.toContain('!= "philipz/software_factory"')
  })
  it('Guard step：checkout 前驗證 trunk 分支存在（#171 實測教訓，零成本 fast-fail）', () => {
    expect(content).toContain('git/ref/heads/')
    expect(content).toContain('inputs.base_branch')
    expect(content).toContain('不存在分支')
  })
  it('App token 依目標 repo 換發（最小權限）', () => {
    expect(content).toContain('repositories: ${{ inputs.repo }}')
  })
  it('目標 repo 以 base_branch checkout 至 target/（main 絕不觸碰）', () => {
    expect(content).toContain('repository: ${{ inputs.repo }}')
    expect(content).toContain('ref: ${{ inputs.base_branch }}')
    expect(content).toContain('path: target')
  })
  it('agent 的 repo/base 以 run-env 檔傳遞（DSH 剝離 env）', () => {
    expect(content).toContain('.factory/run/base-branch')
    expect(content).toContain('.factory/run/repo')
    expect(content).toContain('.factory/run/gh-token')
  })
  it('gh 步驟以 GH_REPO 指向目標 repo', () => {
    expect(content).toContain('GH_REPO: ${{ inputs.repo }}')
  })
  it('token 安全：.git/info/exclude 排除 .factory/（目標 repo 未必有 gitignore 條目）', () => {
    expect(content).toContain('.git/info/exclude')
    expect(content).toContain('.factory/')
  })
  it('計分與判定讀目標 repo 的 catalog/risk-paths', () => {
    expect(content).toContain('--catalog target/catalog-info.yaml')
    expect(content).toContain('target/.github/factory/risk-paths.yml')
  })
})

describe('skill/模板使用 $BASE_BRANCH 而非寫死 main（Q-P2-1）', () => {
  it('factory-pr-stacking 以 $BASE_BRANCH 為 stack base', () => {
    const content = read('.dsh/skills/factory-pr-stacking/SKILL.md')
    expect(content).toContain('gh stack init --base "$BASE_BRANCH"')
    expect(content).not.toContain('--base main')
    expect(content).toContain('.factory/run/base-branch')
  })
  it('skill 指令與 gh-stack v0.1.0 相容（positional 分支名，無 --numbered/--prefix）', () => {
    // 試點 #2 根因（Q07-2 更正）：v0.1.0 不接受 --numbered/--prefix；舊 skill 指令在
    // CI 上無效 → agent 被迫自創分支名 → 命名紀律失守。此斷言防止舊指令回潮。
    // 只檢查 ```bash 指令碼區塊（skill 的「禁止事項」說明文字允許提及旗標名）。
    for (const s of ['factory-pr-stacking', 'factory-workflow']) {
      const content = read(`.dsh/skills/${s}/SKILL.md`)
      const bashBlock = content.match(/```bash\n([\s\S]*?)```/)?.[1] ?? ''
      expect(bashBlock).not.toContain('--numbered')
      expect(bashBlock).not.toContain('--prefix')
      expect(content).toContain('factory/<issue編號>-<nn>-<layer>')
    }
  })
  it('factory-workflow 指示讀取 GH_REPO/BASE_BRANCH 且不 push main', () => {
    const content = read('.dsh/skills/factory-workflow/SKILL.md')
    expect(content).toContain('.factory/run/repo')
    expect(content).toContain('.factory/run/base-branch')
    expect(content).toContain('絕不 push 到 main')
  })
  it('所有 task-template 帶 <REPO>/<BASE_BRANCH> 佔位與 run-env 匯出', () => {
    for (const t of [
      'task-template.txt',
      'task-template-add-tests.txt',
      'task-template-fix-bug.txt',
      'task-template-update-deps.txt',
      'task-template-write-docs.txt',
    ]) {
      const c = read(`.github/factory/${t}`)
      expect(c).toContain('<REPO>')
      expect(c).toContain('<BASE_BRANCH>')
      expect(c).toContain('export GH_REPO=$(cat .factory/run/repo')
      expect(c).toContain('export BASE_BRANCH=$(cat .factory/run/base-branch')
    }
  })
  it('4 種 task_type 各有一個專屬 task-template 檔（下拉選單直接對應，ADR 決定）', () => {
    const w = read('.github/workflows/factory-run.yml')
    const m = w.match(/^ {8}options: \[(.+)\]$/m)
    expect(m).not.toBeNull()
    const options = m![1]!.split(',').map((s) => s.trim())
    expect(options).toEqual([
      'agent-add-tests',
      'agent-fix-bug',
      'agent-update-deps',
      'agent-write-docs',
    ])
    // 檔名慣例：task-template-<type>.txt（type 無 agent- 前綴）——
    // 路由必須剝除前綴，否則專屬模板永遠拼不出檔名（2026-08-21 實測抓到的
    // 既有 bug：PR #101 後 4 型全部靜默 fallback 到通用模板）。
    expect(w).toContain('task-template-${TASK_TYPE#agent-}.txt')
    for (const t of options) {
      const file = `task-template-${t.replace(/^agent-/, '')}.txt`
      expect(read(`.github/factory/${file}`)).toContain('<ISSUE>')
    }
  })
  it('通用模板 fallback 有 ::warning:: log（漂移不靜默，fail-loud 精神）', () => {
    const w = read('.github/workflows/factory-run.yml')
    expect(w).toMatch(/::warning::[^\n]*task-template/)
  })
})

describe('token 門檻接線（Q02-5 SR7，Phase 2 T6）', () => {
  it('factory-run.yml 含 token_budget input（0 = 不設限）', () => {
    const content = read('.github/workflows/factory-run.yml')
    expect(content).toContain('token_budget:')
    expect(content).toContain('default: 0')
  })
  it('judge 步驟以 TOKEN_BUDGET env 傳入（judge 讀 env）', () => {
    const content = read('.github/workflows/factory-run.yml')
    expect(content).toContain('TOKEN_BUDGET: ${{ inputs.token_budget }}')
  })
  it('SR7 已在 pipeline 接線（runWorkItem Gate 4 傳 tokensUsed/tokenBudget）', () => {
    const content = read('src/pipeline/run-work-item.ts')
    expect(content).toContain('tokensUsed')
    expect(content).toContain('tokenBudget')
  })
  it('factory-judge 的 ReportSchema 接受 tokensUsed', () => {
    const content = read('src/cli/factory-judge.ts')
    expect(content).toContain('tokensUsed: z.number().optional()')
  })
  it('stop-rules skill 明寫 token 上限規則', () => {
    const content = read('.dsh/skills/factory-stop-rules/SKILL.md')
    expect(content).toContain('token_budget')
  })
})

describe('factory-metrics 資產（docs/08 §2/§7，Phase 2 T5）', () => {
  it('factory-metrics CLI 存在且以 gh JSON 為資料源（不硬編碼）', () => {
    const content = read('src/cli/factory-metrics.ts')
    expect(content).toContain('gh')
    expect(content).toContain('pr')
    expect(content).toContain('computeMetrics')
  })
  it('factory-metrics 測試存在（純函式 + gh 注入）', () => {
    const content = read('src/cli/factory-metrics.test.ts')
    expect(content).toContain('computeMetrics')
    expect(content).toContain('renderMarkdown')
  })
  it('weekly-metrics.sh 存在、可執行、查缺陷標籤與指標', () => {
    const content = read('scripts/weekly-metrics.sh')
    expect(content).toContain('defect/escape')
    expect(content).toContain('factory-metrics')
  })
})

describe('Quint Phase A 資產（Task 16–20）', () => {
  it('vendor 的 quint skills 存在（官方僅提供 quint-lang/quint-modeling，見 ADR-008）', () => {
    for (const name of ['quint-lang', 'quint-modeling']) {
      const content = read(`.dsh/skills/${name}/SKILL.md`)
      expect(content).toMatch(new RegExp(`^name: ${name}$`, 'm'))
      expect(content).toMatch(/^description: /m)
    }
  })
  it('ADR-008 記錄 quint skills 來源 commit SHA 與官方 skill 清單差異', () => {
    const adr = read('docs/ADR/008-quint-formal-verification.md')
    expect(adr).toMatch(/quint-co\/quint/)
    expect(adr).toMatch(/[0-9a-f]{7,40}/)
    expect(adr).toContain('quint-execute-spec') // 記錄「官方未提供」的差異
  })
  it('Quint 模型存在且為人類撰寫（含 fail-safe 不變量）', () => {
    const q = read('specs/scoring/score.qnt')
    expect(q).toContain('module scoring')
    expect(q).toContain('fail-safe') // 註解標示來源設計
    expect(q).toContain('val failSafe')
  })
  it('quint-paths.yml 宣告 src/scoring 與 src/stop-rules', () => {
    const p = read('.github/factory/quint-paths.yml')
    expect(p).toContain('src/scoring/**')
    expect(p).toContain('src/stop-rules/**')
  })
  it('catalog-info.yaml 帶技術棧 annotation 且 quint-spec 指向規格根', () => {
    const c = read('catalog-info.yaml')
    expect(c).toContain('factory.io/stack:')
    expect(c).toContain('factory.io/test-framework:')
    expect(c).toContain('factory.io/quint-spec: specs/scoring')
  })
  it('神諭 harness 測試存在（ITF vs TS）', () => {
    expect(read('test/quint/scoring-oracle.test.ts')).toContain('--out-itf')
  })
})

describe('Phase 2 資產釘選（Phase 2 T7）', () => {
  it('factory-run.yml 含 task_type 路由與 repo input', () => {
    const c = read('.github/workflows/factory-run.yml')
    expect(c).toContain('task_type')
    expect(c).toContain('task-template-${TASK_TYPE#agent-}')
    expect(c).toContain('inputs.repo')
  })
  it('factory-workflow skill 含任務型別分支與 --draft 禁令', () => {
    const s = read('.dsh/skills/factory-workflow/SKILL.md')
    expect(s).toContain('任務型別')
    expect(s).toContain('--draft')
  })
  it('factory-rescore.yml 存在且僅 factory/* 分支觸發', () => {
    const w = read('.github/workflows/factory-rescore.yml')
    expect(w).toContain("startsWith(github.event.pull_request.head.ref, 'factory/')")
  })
  it('factory-rescore.yml 支援多 repo（workflow_dispatch + target checkout + GH_REPO）', () => {
    const w = read('.github/workflows/factory-rescore.yml')
    expect(w).toContain('workflow_dispatch')
    expect(w).toContain('inputs.repo')
    expect(w).toContain('pr_number')
    expect(w).toContain('path: target')
    expect(w).toContain('GH_REPO:')
  })
})

describe('T8 試點草稿（trial/fubon-tradingbot/，Q-P2-1）', () => {
  it('README 存在且明寫 main 絕不觸碰', () => {
    const content = read('trial/fubon-tradingbot/README.md')
    expect(content).toContain('software-factory')
    expect(content).toContain('main 絕不觸碰')
  })
  it('草稿 risk-paths 涵蓋 H1–H7（依 fubon-tradingbot 結構）', () => {
    const content = read('trial/fubon-tradingbot/.github/factory/risk-paths.yml')
    for (const h of ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7']) {
      expect(content).toContain(`${h}:`)
    }
    expect(content).toContain('src/AuthManager.ts')
    expect(content).toContain('src/OrderRouter.ts')
  })
  it('草稿 catalog 採最高風險輪廓（試點目的：驗證高風險計分）', () => {
    const content = read('trial/fubon-tradingbot/catalog-info.yaml')
    expect(content).toContain('factory.io/risk-profile: high')
    expect(content).toContain('factory.io/business-criticality: strategic')
  })
})

describe('Java 試點草稿（trial/spring-modulith-orders/，語言無關性驗證）', () => {
  it('README 存在且明寫 main 絕不觸碰 + Java 特定注意', () => {
    const content = read('trial/spring-modulith-orders/README.md')
    expect(content).toContain('software-factory')
    expect(content).toContain('main 絕不觸碰')
    expect(content).toContain('JDK 21')
    expect(content).toContain('mvnw')
  })
  it('risk-paths 涵蓋 H1–H7（依 Java/Spring Boot 結構）', () => {
    const content = read('trial/spring-modulith-orders/.github/factory/risk-paths.yml')
    for (const h of ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7']) {
      expect(content).toContain(`${h}:`)
    }
    expect(content).toContain('orders/domain/**')   // H2 訂單核心
    expect(content).toContain('db/migration/**')    // H6 Flyway
    expect(content).toContain('**/api/**')          // H7 REST API
  })
  it('CI workflow 草稿存在且觸發涵蓋 software-factory/factory/**', () => {
    const content = read('trial/spring-modulith-orders/.github/workflows/test.yml')
    expect(content).toContain('software-factory')
    expect(content).toContain("'factory/**'")
    expect(content).toContain('setup-java')
    expect(content).toContain('java-version')
  })
  it('catalog 採高風險輪廓（先驗證閘門、裁決調降後實跑——fubon 模式）', () => {
    const content = read('trial/spring-modulith-orders/catalog-info.yaml')
    expect(content).toContain('factory.io/risk-profile: high')
    expect(content).toContain('factory.io/complexity: high')
  })
})

describe('Backstage factory-work-item 模板與 DoD 契約（docs/ADR/009）', () => {
  it('ISSUE_TEMPLATE 的 DoD checkbox label 與 CLI DOD_LABELS 常數逐字一致', () => {
    const yml = read('.github/ISSUE_TEMPLATE/factory-work-item.yml')
    // 表單 checkboxes 的選項 label 縮排為 8 空格 `- label: ...`
    const labels = [...yml.matchAll(/^ {8}- label: (.+)$/gm)].map((m) => m[1])
    expect(labels).toEqual([...DOD_LABELS])
  })
  it('ISSUE_TEMPLATE 的 task_type 4 種選項齊全', () => {
    const yml = read('.github/ISSUE_TEMPLATE/factory-work-item.yml')
    for (const t of [
      'agent-add-tests',
      'agent-fix-bug',
      'agent-update-deps',
      'agent-write-docs',
    ]) {
      expect(yml).toContain(t)
    }
  })
  it('Backstage factory-work-item 模板存在且含建 Issue + dispatch 結構', () => {
    const t = read('backstage/templates/factory-work-item/template.yaml')
    expect(t).toContain('apiVersion: scaffolder.backstage.io/v1beta3')
    expect(t).toContain('github:issues:create')
    expect(t).toContain('github:actions:dispatch')
  })
  it('Backstage 兩模板 baseBranch 統一語意（ADR-013：所有 repo 用 software-factory，main 絕不觸碰）', () => {
    for (const f of [
      'backstage/templates/factory-work-item/template.yaml',
      'backstage/templates/agent-add-tests/template.yaml',
    ]) {
      const t = read(f)
      expect(t).toContain('default: software-factory')
      expect(t).toContain('所有 repo 的 factory trunk 皆為 software-factory 分支')
      // 不得再出現誤導的「試點 repo 用」舊說明（機制 repo 也統一）
      expect(t).not.toContain('試點 repo 用 software-factory')
    }
  })
  it('test.yml push 觸發涵蓋 software-factory（factory trunk 每層獨立綠燈，ADR-013）', () => {
    const t = read('.github/workflows/test.yml')
    expect(t).toMatch(/branches: \[main, software-factory\]/)
  })
  it('taskType 表單預設 = agent-add-tests（與 workflow input / issue-check fallback 一致）', () => {
    const t = read('backstage/templates/factory-work-item/template.yaml')
    // 表單預設值讓 Review 按鈕不需手選即可按（2026-08-21 UX 修正），
    // 且與 factory-run.yml 的 input default 及 issue-check 的 fallback 同源。
    expect(t).toMatch(/default: agent-add-tests/)
    expect(read('.github/workflows/factory-run.yml')).toContain('default: agent-add-tests')
    expect(read('.github/workflows/factory-issue-check.yml')).toContain('"agent-add-tests"')
  })
  it('Backstage 模板的 DoD 選項與 CLI 常數逐字一致（兩路徑規則不發散）', () => {
    const t = read('backstage/templates/factory-work-item/template.yaml')
    for (const label of DOD_LABELS) {
      expect(t).toContain(label)
    }
  })
  it('Backstage 模板的 body 欄位標題與 CLI 解析器一致（### 標題逐字）', () => {
    const t = read('backstage/templates/factory-work-item/template.yaml')
    for (const title of ['任務類型', '需求描述（PRD）', '驗收標準（DoD）', '目標 repo（預設本 repo）']) {
      expect(t).toContain(title)
    }
  })
  it('Backstage 模板使用 factory-draft 客製欄位（LLM 草稿助手）', () => {
    const t = read('backstage/templates/factory-work-item/template.yaml')
    expect(t).toContain('ui:field: FactoryWorkItemDraftField')
  })
  it('factory-draft 客製 plugin 存在（backend 路由 + frontend 欄位）', () => {
    const router = read('backstage/plugins/factory-draft-backend/src/router.ts')
    expect(router).toContain('factory-draft')
    const field = read('backstage/plugins/factory-draft/src/index.tsx')
    expect(field).toContain('FactoryWorkItemDraftField')
  })
  it('LLM 草稿核心邏輯在 src/factory-draft 且有測試（純函式契約）', () => {
    expect(read('src/factory-draft/prompts.ts')).toContain('CLARIFY_MAX_ROUNDS')
    expect(read('src/factory-draft/parse.ts')).toContain('parseDraftJson')
    expect(read('src/factory-draft/issue-body.ts')).toContain('buildIssueBody')
    expect(read('src/factory-draft/issue-body.test.ts')).toContain('checkIssue')
  })
})

describe('Security 第一層資產（免費、不依賴 GHAS，2026-08-20）', () => {
  it('dependabot.yml 存在且涵蓋 npm + github-actions', () => {
    const c = read('.github/dependabot.yml')
    expect(c).toContain('package-ecosystem: npm')
    expect(c).toContain('package-ecosystem: github-actions')
  })
  it('test.yml 含 npm audit gate（high 以上紅燈）', () => {
    const c = read('.github/workflows/test.yml')
    expect(c).toContain('npm audit --audit-level=high')
  })
  it('security-scan.yml 存在且含 gitleaks + Semgrep（免費替代 GHAS）', () => {
    const c = read('.github/workflows/security-scan.yml')
    expect(c).toContain('gitleaks/gitleaks-action')
    expect(c).toContain('returntocorp/semgrep-action')
  })
})

describe('factory-run 逾時捕獲與診斷（2026-08-21 run #32491052696 實測教訓）', () => {
  const c = read('.github/workflows/factory-run.yml')
  it('agent step 逾時 ≥ 40min（Java/mvn 建置需要時間）', () => {
    const m = c.match(/timeout-minutes: (\d+)/g)
    expect(Number(m?.[1]?.match(/\d+/)?.[0] ?? 25)).toBeGreaterThanOrEqual(40)
  })
  it('逾時/失敗捕獲：寫 --timed-out report + needs-human 標籤', () => {
    expect(c).toContain('--timed-out')
    expect(c).toContain('Handle agent timeout/failure')
    expect(c).toContain('--add-label needs-human')
    expect(c).toContain("steps.agent.outcome == 'failure'")
  })
  it('上傳 run artifacts（失敗也要，診斷用）', () => {
    // 只驗證用 upload-artifact 上傳、不綁版本：@v4（node20）已因 Node 20 棄用
    // 升級為 @v7（node24），版本號是實作細節，寫死會擋掉 runtime 升級。
    expect(c).toContain('actions/upload-artifact@')
    expect(c).toContain('target/.factory/run/')
    expect(c).toContain('if-no-files-found: ignore')
  })
})

describe('run-name 與 cleanup 解析契約（docs/18 §2.2，G2）', () => {
  // 2026-08 實測教訓：plain scalar 中的 ` #` 會被 YAML 當成註解——run-name 解析值
  // 只剩 `Factory Run (${{ inputs.repo }}`，`#<issue>)` 整段消失，factory-run-cleanup
  // 的解析正則失配（G2 靜默失效）。run-name 必須以雙引號包裹，`#` 才是字面值。
  const { load } = require('js-yaml') as typeof import('js-yaml')

  it('run-name（YAML 解析後）代入 inputs 必須是 cleanup 可解析的完整格式', () => {
    const wf = load(read('.github/workflows/factory-run.yml')) as { 'run-name'?: string }
    const runName = wf['run-name']
    expect(runName, 'run-name 必須存在').toBeDefined()
    const resolved = runName!
      .replace('${{ inputs.repo }}', 'owner/repo')
      .replace('${{ inputs.issue_number }}', '123')
    expect(resolved).toBe('Factory Run (owner/repo #123)')
  })

  it('cleanup workflow 含對應的解析正則（#<issue>) 結尾）', () => {
    const cleanup = read('.github/workflows/factory-run-cleanup.yml')
    expect(cleanup).toContain('#([0-9]+)\\)$')
    expect(cleanup).toContain('display_title')
  })
})

describe('factory-draft 防呆契約（2026-08-22：無限轉圈教訓）', () => {
  const router = read('backstage/plugins/factory-draft-backend/src/router.ts')
  const llm = read('backstage/plugins/factory-draft-backend/src/llm.ts')
  const field = read('backstage/plugins/factory-draft/src/index.tsx')
  it('router 的 async handler 有 try/catch 防護（Express 4 不捕 async 錯誤 → 無回應轉圈）', () => {
    expect(router).toContain('.catch(')
    expect(router).toContain('res.status(500)')
  })
  it('llm.ts 有 AbortController 逾時（90 秒）與空回應診斷記錄', () => {
    expect(llm).toContain('AbortController')
    expect(llm).toContain('LLM_TIMEOUT_MS = 90_000')
    expect(llm).toContain('LLM_MAX_TOKENS = 8000') // reasoning 模型：預算須容納思考+內容（2026-08-22 finish_reason=length）
    expect(llm).toContain('finish_reason')
  })
  it('前端 post() 有 120 秒逾時（轉圈必定結束）', () => {
    expect(field).toContain('POST_TIMEOUT_MS = 120_000')
    expect(field).toContain('AbortController')
    expect(field).toContain('LLM 回應逾時，請重試')
  })
})

describe('模型分級路由契約（docs/ADR/011）', () => {
  const { load } = require('js-yaml') as typeof import('js-yaml')
  interface TierShape {
    primary: { provider: string; model: string }
    fallback: { provider: string; model: string }[]
  }
  const tiers = (
    load(read('config/dsh/model-tiers.yaml')) as {
      tiers: { low: TierShape; medium: TierShape; high: TierShape; critical?: TierShape }
    }
  ).tiers
  const providers = Object.keys(
    (load(read('config/dsh/settings.providers.yaml')) as {
      'llm-pi-ai': { providers: Record<string, unknown> }
    })['llm-pi-ai'].providers,
  )

  it('用戶模型優先序：low/medium=qwen3.8-flash（2026-08-27 起為預設）、high=pro、critical=opus-5', () => {
    expect(tiers.low.primary.provider).toBe('qwen')
    expect(tiers.low.primary.model).toBe('qwen3.8-flash')
    expect(tiers.medium.primary.provider).toBe('qwen')
    expect(tiers.medium.primary.model).toBe('qwen3.8-flash')
    // 原預設 deepseek-v4-flash 退居 low/medium fallback（跨 provider failover，Q04-8）
    expect(tiers.low.fallback.map((e) => e.model)).toContain('deepseek-v4-flash')
    expect(tiers.medium.fallback.map((e) => e.model)).toContain('deepseek-v4-flash')
    expect(tiers.high.primary.model).toBe('deepseek-v4-pro')
    expect(tiers.critical).toBeDefined() // critical tier 必備（最高 tier 的出口）
    expect(tiers.critical?.primary.model).toBe('claude-opus-5')
    expect(tiers.critical?.primary.provider).toBe('anthropic')
  })

  it('claude-fable-5 已移除（需額外 credit，2026-08-28 用戶裁決）——任何 tier 不得引用', () => {
    for (const [id, t] of Object.entries(tiers)) {
      const models = [t.primary, ...t.fallback].map((e) => e.model)
      expect(models, `tier ${id} 不得含 fable-5`).not.toContain('claude-fable-5')
      if (id !== 'critical') {
        expect(models, `tier ${id} 不得提前動用 opus-5`).not.toContain('claude-opus-5')
      }
    }
  })

  it('critical tier：primary = claude-opus-5、fallback 由 deepseek-v4-pro 起（fable 已移除）', () => {
    // 2026-08-28 用戶裁決：fable-5 需額外 credit（實測 run #33175623064 無法使用）
    // → 移除 fable-5，critical 預設改為同代旗艦 claude-opus-5。
    const critical = tiers.critical
    expect(critical).toBeDefined()
    expect(critical?.primary.model).toBe('claude-opus-5')
    expect(critical?.primary.provider).toBe('anthropic')
    expect(critical?.fallback[0]?.model).toBe('deepseek-v4-pro')
  })

  it('每個 tier 有 primary 與非空 fallback（provider 層失敗必須可 fallback）', () => {
    for (const [id, t] of Object.entries(tiers)) {
      expect(t.primary.model, `tier ${id}`).toBeTruthy()
      expect(t.fallback.length, `tier ${id} fallback`).toBeGreaterThan(0)
    }
  })

  it('chain 引用的 provider 全部已宣告於 settings.providers.yaml', () => {
    for (const [id, t] of Object.entries(tiers)) {
      for (const e of [t.primary, ...t.fallback]) {
        expect(providers, `tier ${id} provider ${e.provider}`).toContain(e.provider)
      }
    }
  })

  it('qwen route 指向 QwenCloud 國際端點（dashscope-intl，2026-08-28 修正 401）', () => {
    // 實測：QwenCloud Pay-As-You-Go key 對中國端點 dashscope.aliyuncs.com 回 401
    // invalid_api_key；國際端點 dashscope-intl.aliyuncs.com 正常（文件
    // docs.qwencloud.com/developer-guides/getting-started/first-api-call）。
    const s = read('config/dsh/settings.providers.yaml')
    expect(s).toContain('baseURL: https://dashscope-intl.aliyuncs.com/compatible-mode/v1')
    expect(s).not.toContain('baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1')
  })

  it('factory-run.yml：Select model tier 步驟與 chain 迴圈接線', () => {
    const c = read('.github/workflows/factory-run.yml')
    expect(c).toContain('model_tier')
    expect(c).toContain('default: auto')
    expect(c).toContain('dist/cli/factory-model.js')
    expect(c).toContain('.factory/model.json')
    expect(c).toContain('agent-default-model')
    expect(c).toContain('jq -c \'.chain[]\'')
    expect(c).toContain('Select model tier')
  })

  it('chain fallback 涵蓋 credential 錯誤（AUTH/401/invalid_api_key，#171 實測壞 key 未 fallback）', () => {
    const c = read('.github/workflows/factory-run.yml')
    for (const token of ['RATE_LIMIT', '429', 'MISSING_CREDENTIAL', 'UNKNOWN_MODEL', 'AUTH', '401', 'INVALID_CREDENTIAL', 'invalid_api_key']) {
      expect(c, `fallback 條件缺 ${token}`).toContain(token)
    }
  })

  it('factory-issue-check.yml 傳 --tiers/--providers（留言含建議模型）', () => {
    const c = read('.github/workflows/factory-issue-check.yml')
    expect(c).toContain('dist/cli/factory-issue-check.js')
    expect(c).toContain('--tiers config/dsh/model-tiers.yaml')
    expect(c).toContain('--providers config/dsh/settings.providers.yaml')
  })

  it('factory-issue-check 留言含複雜度分析與建議模型行（ADR-011）', () => {
    const src = read('src/cli/factory-issue-check.ts')
    expect(src).toContain('📊 **複雜度分析**')
    expect(src).toContain('🤖 **建議模型**')
    expect(src).toContain('analyzeComplexity')
    expect(src).toContain('resolveModelTier')
  })
})
