/**
 * Adversarial tests for Phase-1 factory assets (docs/11 §5).
 *
 * These files are configuration, not code: a broken one shows NO functional
 * symptom — the factory keeps running while a protection silently disappears.
 * Only a test catches that.
 *
 * 本檔定義「契約」：Task 5–8 與 Task 16–20 依此建立檔案後轉綠。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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

  /**
   * E4（docs/25 §2.1）：skillGap 的 SKILL 指示與 ReportSchema 必須一致。
   *
   * 防的是「schema 收了欄位但 agent 從不知道要填」——那會讓整條技能擴增迴圈
   * 靜默失效（機制存在、訊號恆為空，正是 docs/25 §7 列為最高風險的「紀律失效」）。
   */
  it('含 skillGap 欄位、kebab-case 要求與「不得虛構」約束', () => {
    expect(content).toContain('skillGap')
    expect(content).toContain('category')
    expect(content).toContain('needed')
    // 聚類鍵格式是門檻能否成立的前提（docs/25 §3）
    expect(content).toMatch(/kebab-case/)
    // 誠實回報：沒遇到就省略，不得為填而填
    expect(content).toMatch(/不得為了填而虛構缺口|虛構/)
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
    'task-template-analyze.txt',
  ]

  it('全部 6 個 task-template 含「完成後立即停止」指示（防 CI 空轉）', () => {
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
    // DSH 鎖版：devDependency（package.json 精確 pin）→ pnpm install（lockfile）安裝
    // 2026-09 起鎖 0.1.5 系列（本機 Web GUI 與 CI 共用）：DSH 0.1.2 起
    // web 有 launch-token 瀏覽器認證（start.sh 依賴）；credentials/session 格式隨
    // 版本演進（0.1.0-rc.8 的解析器只認舊 flat layout，讀新格式會 boot 失敗），
    // 故必須精確鎖版並與執行中的 harness 同步。Regex 鎖 0.1.5 alpha/rc 系列、允許
    // patch 號浮動，避免升級時誤紅。
    //
    // 0.1.2 → 0.1.5 升級的連帶影響（實測，勿再踩）：session log 檔名由
    // `session.jsonl(.zstd)` 改為 `session.v3.jsonl(.zstd)`（會話格式升 V3）。
    // src/usage/session-log.ts 的檔名比對已同步放寬為 `session(.v<N>)?.jsonl(.zstd)?`；
    // 若未一併更新，factory-usage 會一個 session 都找不到，量測靜默歸零而
    // **不會讓任何 run 變紅**（usage 是附註不是 gate）——典型無聲失效。
    expect(read('package.json')).toMatch(/"@deepseek-ai\/dsh": "\^?0\.1\.5-(alpha|rc)\.\d+"/)
    expect(content).toContain('pnpm install')
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
    // owner 與 repo 名必須拆開傳：create-github-app-token 的 owner 預設為
    // 當前 repo owner（philipz），repositories 只收不含 owner 的名稱——
    // 跨 owner 直接傳 owner/name 會被擋（實測 run 33523314113）。
    expect(content).toContain('owner: ${{ steps.target.outputs.owner }}')
    expect(content).toContain('repositories: ${{ steps.target.outputs.name }}')
    // owner/name 由 inputs.repo 拆出，仍是「依目標 repo」換發
    expect(content).toContain('TARGET_REPO: ${{ inputs.repo }}')
    expect(content).toContain('${TARGET_REPO%%/*}')
    expect(content).toContain('${TARGET_REPO#*/}')
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
  it('6 種 task_type 各有一個專屬 task-template 檔（下拉選單直接對應，ADR 決定）', () => {
    const w = read('.github/workflows/factory-run.yml')
    const m = w.match(/^ {8}options: \[(.+)\]$/m)
    expect(m).not.toBeNull()
    const options = m![1]!.split(',').map((s) => s.trim())
    expect(options).toEqual([
      'agent-add-tests',
      'agent-fix-bug',
      'agent-update-deps',
      'agent-write-docs',
      'agent-analyze',
      'agent-propose-skill',
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
  it('ISSUE_TEMPLATE 的 task_type 6 種選項齊全', () => {
    const yml = read('.github/ISSUE_TEMPLATE/factory-work-item.yml')
    for (const t of [
      'agent-add-tests',
      'agent-fix-bug',
      'agent-update-deps',
      'agent-write-docs',
      'agent-analyze',
      'agent-propose-skill',
    ]) {
      expect(yml).toContain(t)
    }
  })

  /**
   * #238 漂移教訓（docs/21 §1 接線 6）：Backstage template 是凍結工件，
   * 但仍是宣告入口——新增 task_type 時漏改它，表單就永遠開不出該型別。
   * 三處 enum（workflow options／ISSUE_TEMPLATE／Backstage）必須一致。
   */
  it('Backstage template enum 與 workflow options 完全一致（防 #238 漂移）', () => {
    const w = read('.github/workflows/factory-run.yml')
    const options = w.match(/^ {8}options: \[(.+)\]$/m)![1]!.split(',').map((s) => s.trim())
    const bs = read('backstage/templates/factory-work-item/template.yaml')
    const enumBlock = bs.match(/enum:\n((?: {12}- agent-[\w-]+\n)+)/)
    expect(enumBlock, 'Backstage template 找不到 taskType enum 區塊').not.toBeNull()
    const enumTypes = [...enumBlock![1]!.matchAll(/- (agent-[\w-]+)/g)].map((m) => m[1])
    expect(enumTypes).toEqual(options)
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
  it('Backstage taskType enum 與 ISSUE_TEMPLATE 下拉一致（5 型，2026-09-01 C1 漂移修復）', () => {
    const t = read('backstage/templates/factory-work-item/template.yaml')
    const yml = read('.github/ISSUE_TEMPLATE/factory-work-item.yml')
    const expected = [
      'agent-add-tests',
      'agent-fix-bug',
      'agent-update-deps',
      'agent-write-docs',
      'agent-analyze',
      'agent-propose-skill',
    ]
    for (const ty of expected) {
      expect(t).toContain(ty)
      expect(yml).toContain(ty)
    }
    // Backstage enum 不該有 ISSUE_TEMPLATE 以外的類型（反向釘住）
    const bsEnums = [...t.matchAll(/^ {12}- (agent-[a-z-]+)$/gm)].map((m) => m[1])
    expect(bsEnums).toEqual(expected)
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

describe('Backstage 工作項歷史查閱分頁（docs/ADR/017）', () => {
  /**
   * 這條刻意解析 YAML 而不做字串比對。原本這裡還有一條
   * `expect(t).toContain('links:')` + `expect(t).toContain("steps['create-issue'].output.issueUrl")`，
   * 實測證明它毫無價值：把真正的 links 區塊整段刪掉、只留一行註解
   * `# TODO: 未來也許加 links:，屆時用 steps['create-issue'].output.issueUrl`，
   * 該測試照樣綠，而 js-yaml 解析出的 spec.output 只剩 text、一條連結都沒有。
   * 字串比對只問「這些字有沒有出現在檔案某處」，註解裡的字同樣算數；Backstage
   * 讀的卻是解析後的樹。這正是本檔要防的無聲失效：template 照樣載入、表單照樣
   * 送出，只有歷史查閱頁默默退回 log 字串解析，沒有任何功能徵兆。
   *
   * 一條「註解就能滿足」的測試比沒有測試更糟——後人會信它。故已刪除該條，
   * 只留這條以解析後結構為準的斷言（它本來就涵蓋了那兩個字串的實質內容）。
   *
   * 連結刻意不加 `if` 守衛：output 只在所有 step 成功後才渲染（firstError 先 throw，
   * create-issue 無 continueOnFailure），issueUrl 必然存在；且前端 LinkOutputs 與
   * src/work-item-history/issue-url.ts 都會濾掉無 url 的連結，守衛不可能生效。
   */
  it('spec.output.links 為解析後的真欄位：與 text 並存、url 取自 create-issue 的 issueUrl', () => {
    const { load } = require('js-yaml') as typeof import('js-yaml')
    const spec = (
      load(read('backstage/templates/factory-work-item/template.yaml')) as {
        spec: {
          output: { links?: { title?: string; url?: string }[]; text?: unknown[] }
        }
      }
    ).spec
    expect(spec.output.links, 'spec.output 缺 links 欄位').toBeDefined()
    expect(spec.output.links).toHaveLength(1)
    expect(spec.output.links![0]!.url).toBe("${{ steps['create-issue'].output.issueUrl }}")
    expect(spec.output.links![0]!.title).toBeTruthy()
    // 純新增：既有的 output.text 必須原封不動地並存（ADR-009 局部解凍的前提）
    expect(spec.output.text, 'output.text 不得被 links 取代').toHaveLength(1)
  })

  /**
   * 以下三條是**字串比對**（外加一次真實的 import 解析），強度有限，理由與界線寫在此。
   *
   * 為什麼強度有限：同一個 describe 上一條的 docblock 已實測證明，`toContain` 只問
   * 「這些字有沒有出現在檔案某處」——把真正的區塊整段刪掉、只留一行提及相同字串的
   * 註解，斷言照樣綠。本檔開頭也記了 Task 4 的同款教訓。
   *
   * 為什麼仍用字串比對：對象是 `.tsx` 原始碼，而本 repo 沒有現成的 TS 結構化解析
   * 工具；為此引入 TypeScript compiler API 屬於過度工程。故退而求其次。
   *
   * **限制（必須講明，不可當成行為保證）**：這些斷言只證明「該字串出現在檔案裡」，
   * **不證明 SubPage 擴充真的掛進了 app tree，也不證明元件真的會被渲染**。
   * `backstage/plugins/**` 不在 `tsconfig.json` 的 `include`、也不在
   * `vitest.config.ts` 的 `test.include` 內，本 repo 沒有任何自動化檢查能證明那件事
   * ——`pnpm typecheck` 綠燈對 `.tsx` 不構成證據。唯一的驗證是 Task 10 的瀏覽器實測
   * （Create 頁是否真的出現「工作項歷史」分頁），該項是必要驗收項而非選項。
   *
   * 第三條比其餘兩條稍強：它把每個相對 import（`./` 與 `../`）真的 resolve 到磁碟再
   * 斷言檔案存在，故能抓到層數寫錯（4 層與 5 層都含 `src/work-item-history/task-record.ts`
   * 這個子字串，`toContain` 抓不到）——但「解析得到」仍不等於「語意正確」。
   */
  it('SubPage 擴充明寫 attachTo page:scaffolder（不依賴 relative 解析）', () => {
    const idx = read('backstage/plugins/factory-draft/src/index.tsx')
    expect(idx).toContain('SubPageBlueprint.make')
    expect(idx).toContain("attachTo: { id: 'page:scaffolder', input: 'pages' }")
    expect(idx).toContain("path: 'work-items'")
  })

  it('分頁有清單與詳情兩條路由，且各自渲染對應元件', () => {
    const sub = read('backstage/plugins/factory-draft/src/work-item-history/SubPage.tsx')
    expect(sub).toContain('path=":taskId"')
    // 用 regex 而非 toContain('<Route index')：後者假設 JSX 寫成單行，但 Prettier
    // 標準是多行 `<Route\n  index`，那個字面根本不在檔案裡。測的是「有一條 index
    // 路由」這個意圖，不是某種排版。
    expect(sub).toMatch(/<Route\s+index/)
    // 更實質的契約：兩條路由各自渲染對應元件——否則兩條空路由也會過上面的斷言。
    expect(sub).toContain('<HistoryList />')
    expect(sub).toContain('<HistoryDetail />')
  })

  it('歷史頁元件從 src/ 取用純函式，且相對路徑真的解析得到', () => {
    // 純函式是這個功能唯一受 tsc 與 vitest 保護的程式碼；先釘住兩個消費端真的有取用。
    for (const f of [
      'backstage/plugins/factory-draft/src/work-item-history/HistoryList.tsx',
      'backstage/plugins/factory-draft/src/work-item-history/HistoryDetail.tsx',
    ]) {
      expect(read(f)).toContain('src/work-item-history/task-record.ts')
    }
    // 關鍵：`toContain` 抓不到層數寫錯（4 層與 5 層都含 `src/work-item-history/task-record.ts`
    // 這個子字串），但 backstage/plugins/** 不受 tsc 檢查，寫錯會一路安靜到瀏覽器才爆。
    // 故把每個相對 import 真的解析出來，斷言目標檔存在。
    //
    // 範圍涵蓋 `./`（同目錄／子目錄）與 `../`（跨 root 取用 src/）兩種相對形式，
    // 靜態 `from '...'` 與動態 `import('...')` 皆收：index.tsx → ./work-item-history/
    // SubPage.tsx 與 SubPage.tsx → ./HistoryList.tsx 這些單點路徑沒有任何工具檢查得到。
    // regex 要求 specifier 以 `.` 開頭，故 react / @backstage/* 這類裸套件 specifier
    // 不會被當成檔案解析。
    for (const f of [
      'backstage/plugins/factory-draft/src/index.tsx',
      'backstage/plugins/factory-draft/src/work-item-history/SubPage.tsx',
      'backstage/plugins/factory-draft/src/work-item-history/HistoryList.tsx',
      'backstage/plugins/factory-draft/src/work-item-history/HistoryDetail.tsx',
    ]) {
      const src = read(f)
      for (const m of src.matchAll(/(?:from\s+|import\()'(\.[^']+)'/g)) {
        const resolved = resolve(dirname(f), m[1]!)
        expect(existsSync(resolved), `${f} 的 import ${m[1]} 解析不到（實際指向 ${resolved}）`).toBe(true)
      }
    }
  })

  /**
   * 被前端 bundle 引入的模組必須自足——不得有任何相對 import。
   *
   * 根因（2026-09-11 實際踩到）：本 repo 的 `src/**` 慣例是用 `.js` 副檔名互相
   * import（`tsconfig.build.json` 會把 `src/` emit 成給 Node 消費的 ESM，那裡
   * 必須有副檔名），而 vitest 與 tsc 都會把 `./narrow.js` 自動對映到 `narrow.ts`，
   * 所以本 repo 的測試**全綠**。但 Backstage CLI 的 rspack 設定沒有
   * `extensionAlias`，解析不到 `./narrow.js`，於是整個前端 bundle 失敗，錯誤還
   * 被報成 "Can't resolve '@software-factory/factory-draft'"——完全指不到真因。
   * （已確認 CLI 未提供使用者覆寫 bundler 設定的途徑。）
   *
   * 這條測試把「前端引入的模組不得有相對 import」變成紅燈，否則這個約束只能靠
   * 實際啟動 app 才發現，而那是最慢也最容易漏掉的一道。
   */
  it('前端 bundle 引入的 src/ 模組自足（無相對 import，避免 rspack 解析 .js 失敗）', () => {
    for (const f of [
      'src/work-item-history/task-record.ts',
      'src/work-item-history/issue-url.ts',
    ]) {
      const src = read(f)
      const relative = [...src.matchAll(/(?:from\s+|import\()\s*'(\.[^']+)'/g)].map((m) => m[1])
      expect(
        relative,
        `${f} 有相對 import ${relative.join('、')}——前端 bundle 會解析失敗。` +
          '這兩個檔案被 backstage/plugins/factory-draft 直接引入，必須自足；' +
          '要共用邏輯請改為複製進各檔（見 task-record.ts 檔頭說明）。',
      ).toEqual([])
    }
  })
})

describe('Security 第一層資產（免費、不依賴 GHAS，2026-08-20）', () => {
  it('dependabot.yml 存在且涵蓋 npm + github-actions', () => {
    const c = read('.github/dependabot.yml')
    expect(c).toContain('package-ecosystem: npm')
    expect(c).toContain('package-ecosystem: github-actions')
  })
  it('test.yml 含 pnpm audit gate（high 以上紅燈）', () => {
    const c = read('.github/workflows/test.yml')
    expect(c).toContain('pnpm audit --audit-level=high')
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
  // 草稿欄位實作已於 Task 5 搬到 draft-field/DraftFieldComponent.tsx
  const field = read(
    'backstage/plugins/factory-draft/src/draft-field/DraftFieldComponent.tsx',
  )
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

  it('用戶模型優先序：low/medium=qwen3.8-flash（2026-08-27 起為預設）、high=v4.1-flash、critical=opus-5', () => {
    expect(tiers.low.primary.provider).toBe('qwen')
    expect(tiers.low.primary.model).toBe('qwen3.8-flash')
    expect(tiers.medium.primary.provider).toBe('qwen')
    expect(tiers.medium.primary.model).toBe('qwen3.8-flash')
    // 原預設 deepseek-v4-flash 退居 low/medium fallback（跨 provider failover，Q04-8）；
    // 2026-09-11 起該 deepseek fallback 為 v4.1-flash。
    expect(tiers.low.fallback.map((e) => e.model)).toContain('deepseek-v4.1-flash')
    expect(tiers.medium.fallback.map((e) => e.model)).toContain('deepseek-v4.1-flash')
    expect(tiers.high.primary.model).toBe('deepseek-v4.1-flash')
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

  it('deepseek V4 舊 id 已汰換（2026-09-11 用戶裁決）——任何 tier 不得引用 v4-flash/v4-pro', () => {
    // DeepSeek 官方公告：V4.1 Flash 於 2026-09-10 12:00（北京時間）發布，各項指標
    // 全面超越 V4 Pro；V4.1 Pro 上線前 V4 Pro 請求全部路由至 V4.1 Flash 並按其單價計費。
    // → deepseek-v4-flash 與 deepseek-v4-pro 一律改為 deepseek-v4.1-flash。
    for (const [id, t] of Object.entries(tiers)) {
      const models = [t.primary, ...t.fallback].map((e) => e.model)
      expect(models, `tier ${id} 不得含已汰換的 deepseek-v4-flash`).not.toContain('deepseek-v4-flash')
      expect(models, `tier ${id} 不得含已汰換的 deepseek-v4-pro`).not.toContain('deepseek-v4-pro')
    }
  })

  it('critical tier：primary = claude-opus-5、fallback 由 deepseek-v4.1-flash 起（fable 已移除）', () => {
    // 2026-08-28 用戶裁決：fable-5 需額外 credit（實測 run #33175623064 無法使用）
    // → 移除 fable-5，critical 預設改為同代旗艦 claude-opus-5。
    const critical = tiers.critical
    expect(critical).toBeDefined()
    expect(critical?.primary.model).toBe('claude-opus-5')
    expect(critical?.primary.provider).toBe('anthropic')
    expect(critical?.fallback[0]?.model).toBe('deepseek-v4.1-flash')
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

describe('用量與成本契約（docs/04 §5、docs/08 §2.3、docs/ADR/011）', () => {
  const { load } = require('js-yaml') as typeof import('js-yaml')
  interface TierShape {
    primary: { provider: string; model: string }
    fallback: { provider: string; model: string }[]
  }
  const tiers = (
    load(read('config/dsh/model-tiers.yaml')) as {
      tiers: Record<string, TierShape>
    }
  ).tiers
  const pricing = (
    load(read('config/dsh/pricing.yaml')) as {
      pricing: Record<string, { inputUsdPerMTok: number; outputUsdPerMTok: number }>
    }
  ).pricing

  it('pricing.yaml 存在且每個 model id 都有 input/output 價（新增 model 漏定價即紅燈）', () => {
    const modelIds = new Set<string>()
    for (const t of Object.values(tiers)) {
      modelIds.add(t.primary.model)
      for (const f of t.fallback) modelIds.add(f.model)
    }
    expect(modelIds.size).toBeGreaterThan(0)
    for (const id of modelIds) {
      const p = pricing[id]
      expect(p, `pricing.yaml 缺 model ${id}`).toBeDefined()
      expect(p?.inputUsdPerMTok, `${id} input`).toBeGreaterThan(0)
      expect(p?.outputUsdPerMTok, `${id} output`).toBeGreaterThan(0)
    }
  })

  it('定價數值與 ADR-011 表一致（qwen3.8-flash $0.15/0.47 等）', () => {
    expect(pricing['qwen3.8-flash']?.inputUsdPerMTok).toBe(0.15)
    expect(pricing['qwen3.8-flash']?.outputUsdPerMTok).toBe(0.47)
    // deepseek-v4.1-flash：2026-09-10 生效的官方公告價，取高峰時段（2 元 / 8 元）
    // 以 1 USD = 7.1 CNY 換算（保守估算，不低估成本）。
    expect(pricing['deepseek-v4.1-flash']?.inputUsdPerMTok).toBe(0.282)
    expect(pricing['deepseek-v4.1-flash']?.outputUsdPerMTok).toBe(1.127)
    expect(pricing['claude-opus-5']?.inputUsdPerMTok).toBe(5)
    expect(pricing['claude-opus-5']?.outputUsdPerMTok).toBe(25)
  })

  it('factory-run.yml 含 Measure usage 步驟（讀 DSH session log + 定價表）', () => {
    const c = read('.github/workflows/factory-run.yml')
    expect(c).toContain('Measure usage & cost')
    expect(c).toContain('dist/cli/factory-usage.js')
    expect(c).toContain('--sessions-root')
    expect(c).toContain('--pricing')
  })

  it('factory-run.yml 把 usage.md 傳給 apply-judge-labels（終態留言附用量段落）', () => {
    const c = read('.github/workflows/factory-run.yml')
    expect(c).toContain('apply-judge-labels.js')
    expect(c).toContain('usage.md')
  })

  it('apply-judge-labels 的 buildJudgeComment 支援 usage 參數（留言可附用量）', () => {
    const src = read('src/cli/apply-judge-labels.ts')
    expect(src).toContain('usageMarkdown')
  })

  it('factory-judge ReportSchema 接受 usage 欄位（執行報告留底）', () => {
    const src = read('src/cli/factory-judge.ts')
    expect(src).toContain('UsageReportSchema')
    expect(src).toContain('usage:')
  })
})
