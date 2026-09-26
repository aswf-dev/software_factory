/**
 * Adversarial tests for Phase-1 factory assets (docs/11 §5).
 *
 * These files are configuration, not code: a broken one shows NO functional
 * symptom — the factory keeps running while a protection silently disappears.
 * Only a test catches that.
 *
 * 本檔定義「契約」：Task 5–8 與 Task 16–20 依此建立檔案後轉綠。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DOD_LABELS, FIELD_TITLES } from '../../src/cli/factory-issue-check.js'
import { buildIssueBody } from '../../src/factory-draft/issue-body.js'
import { SPEC_NAME_MAX, SPEC_NAME_PATTERN } from '../../src/write-spec/intake.js'
// Issue #287：三軸合法值的單一真相來源。測試若重打字串，測試自己就是下一個漂移點。
import { BUSINESS_CRITICALITY, COMPLEXITY, RISK_PROFILE } from '../../src/scoring/types.js'

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

  /**
   * 停手時必須顯式表態（2026-09-17）。
   *
   * 「沒遇到缺口」與「遇到了但沒想到回報」在資料上都是欄位缺席，人類無從分辨。
   * 盤點 09-09 以來 13 次 run：5 筆缺口全部只來自 deepseek-v4-pro 與
   * qwen3.8-flash，claude 家族在 4 次「該考慮回報」的情境中 0 次填寫。
   * 把可見性寄託在模型自覺上，訊號會隨路由政策悄悄斷掉——故要求停手時以
   * `"skillGap": null` 顯式否認，讓兩種缺席可區分。
   */
  it('要求停手時顯式表態（有缺口就填，沒有則明寫 null）', () => {
    expect(content).toContain('"skillGap": null')
    expect(content).toMatch(/停手|無法完成/)
    // advisory 是提醒不是閘門——措辭若變成「會擋下」，agent 就有動機為過關而虛構
    expect(content).toMatch(/不擋|不影響終態/)
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
  //
  // Issue #287（缺陷 2）：這裡曾硬編碼 6 個模板名——`.github/factory/` 實際有 8 個，
  // `task-template-onboard.txt` 與 `task-template-propose-skill.txt` 從未被納入檢查。
  // 這種「新增資產沒接上檢查」的清單漂移與缺陷 1 同源，故改為 glob 列舉：
  // 新增模板自動納入下面兩項檢查，不需要有人記得更新清單。
  const TEMPLATES = readdirSync(join(ROOT, '.github/factory'))
    .filter((f) => /^task-template.*\.txt$/.test(f))
    .sort()

  it('glob 實際列舉出 task-template（數量 > 0，防 glob 寫錯導致空跑恆綠）', () => {
    // 若 glob 失效，TEMPLATES 為空 → 下面兩條迴圈測試全部空跑、恆綠無聲。
    expect(TEMPLATES.length, 'glob 未列舉到任何 task-template').toBeGreaterThan(0)
    // #287 實證基數：至少 8 個（7 個專屬模板 + 1 個通用）；新增只增不減。
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(8)
    // 釘住兩個曾经的盲區模板，確保列舉真的涵蓋它們（不重新硬編碼整個清單）。
    expect(TEMPLATES).toContain('task-template-onboard.txt')
    expect(TEMPLATES).toContain('task-template-propose-skill.txt')
  })

  it('所有 task-template（glob 列舉）含「完成後立即停止」指示（防 CI 空轉）', () => {
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

/**
 * Issue #287：三軸合法值抗漂移。
 *
 * 根因（缺陷 1）：`task-template-onboard.txt` 教 agent 填 `supporting`，但機制合法值
 * 在 `src/scoring/types.ts` 是 `['tactical','operational','strategic']`——`supporting`
 * 非法。`factory-score` 對非法值 fail-safe 計 2，後果不是紅燈而是**靜默升級**
 * （實證：docs/27 §7.2 camunda_hazelcast 預期 total 1 → on-loop，實得 3 → review）。
 *
 * 契約：
 * 1) 值集合一律以 `src/scoring/types.ts` 的常數為單一真相來源（見檔頭 import）——
 *    測試內重打字串會讓測試自己變成下一個漂移點。
 * 2) factory 資產（`.github/factory/**`、`.dsh/skills/**`）中出現三軸 annotation
 *    名稱之處，若列出值（`a | b | c` 形式或 `key: value`），每個值都必須在合法集合內。
 * 3) 回歸鎖：`supporting` 不得作為三軸值出現在 factory 資產中。
 *
 * **交付歷史（Issue #287）**：以下兩條測試以 test-only 層（PR #288）用 `it.skip`
 * 交付，揭露既有缺陷 1（模板教 agent 填非法幽靈值）。修復工作項把
 * `.github/factory/task-template-onboard.txt` 的三軸註解改成對齊
 * `src/scoring/types.ts` 的合法集合并 un-skip 轉綠——斷言完整保留，紅燈已在
 * 沙箱實測（修復前該兩條為全檔唯二失敗點）。本鎖永久防止回潮。
 */
describe('三軸合法值抗漂移（#287：單一真相來源 = src/scoring/types.ts）', () => {
  const AXIS_LEGAL: Record<string, readonly string[]> = {
    'business-criticality': BUSINESS_CRITICALITY,
    'risk-profile': RISK_PROFILE,
    complexity: COMPLEXITY,
  }
  const FACTORY_ASSET_DIRS = ['.github/factory', '.dsh/skills']

  // 遞迴列舉 factory 資產檔（這些目錄下全為文字檔：.txt/.md/.yml/.qnt）
  const listAssetFiles = (relDir: string): string[] => {
    const out: string[] = []
    for (const e of readdirSync(join(ROOT, relDir), { withFileTypes: true })) {
      const rel = join(relDir, e.name)
      if (e.isDirectory()) out.push(...listAssetFiles(rel))
      else if (e.isFile()) out.push(rel)
    }
    return out
  }
  const ASSET_FILES = FACTORY_ASSET_DIRS.flatMap(listAssetFiles).sort()

  it('factory 資產以遞迴列舉非空（防路徑寫錯導致空跑恆綠）', () => {
    expect(ASSET_FILES.length, '未列舉到任何 factory 資產').toBeGreaterThan(0)
    expect(ASSET_FILES).toContain('.github/factory/task-template-onboard.txt')
    // 兩個目錄都要真的掃到（防其中一個路徑打錯而靜默漏掃）
    expect(ASSET_FILES.some((f) => f.startsWith('.dsh/skills/'))).toBe(true)
  })

  it('三軸 annotation 名稱處列出的值全在合法集合內（#287 抗漂移鎖）', () => {
    const violations: string[] = []
    for (const rel of ASSET_FILES) {
      read(rel)
        .split('\n')
        .forEach((line, idx) => {
          for (const [axis, legal] of Object.entries(AXIS_LEGAL)) {
            if (!line.includes(axis)) continue
            // 值來源：優先取行內註解（模板以 `# a | b | c` 教合法值），否則取 `:` 之後
            const hash = line.indexOf('#')
            const valuePart = hash >= 0 ? line.slice(hash + 1) : line.slice(line.indexOf(':') + 1)
            for (const seg of valuePart.split('|')) {
              const tok = seg.trim()
              // 只審查「單獨成詞的小寫 token」；說明性文字跳過（誤報比漏報更傷防線信任）
              if (!/^[a-z][a-z-]*$/.test(tok)) continue
              if (!legal.includes(tok)) {
                violations.push(`${rel}:${idx + 1} [${axis}] 非法值 "${tok}"（合法：${legal.join(' | ')}）`)
              }
            }
          }
        })
    }
    expect(violations, 'factory 資產列出了不屬於機制合法集合的三軸值').toEqual([])
  })

  it('回歸鎖：supporting 不得作為三軸值出現在 factory 資產（#287 幽靈值防回潮）', () => {
    const offenders: string[] = []
    for (const rel of ASSET_FILES) {
      read(rel)
        .split('\n')
        .forEach((line, idx) => {
          if (!/\bsupporting\b/.test(line)) return
          // `.dsh/skills/**` 含官方 vendored 內容，其中的普通英文 "supporting"
          // （如 quint-modeling 指南的 "a supporting path"）不是軸值漂移、亦不在
          // 本 Issue 修改範圍，故該目錄只鎖「與三軸 annotation 名稱同行」的出現。
          // `.github/factory/**` 全是工廠機制資產——零容忍。
          const axisContext = Object.keys(AXIS_LEGAL).some((a) => line.includes(a))
          if (rel.startsWith('.github/factory') || axisContext) {
            offenders.push(`${rel}:${idx + 1}: ${line.trim()}`)
          }
        })
    }
    // `supporting` 是三軸共同的幽靈值：factory-score fail-safe 計 2 → 靜默升級監督分數，
    // 無任何錯誤訊息（docs/27 §7.2 實證）。修復後此鎖防止回潮。
    expect(offenders, 'supporting 非法（不是任何一軸的合法值）').toEqual([])
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
    // 2026-09 起鎖 0.1.7 系列（本機 Web GUI 與 CI 共用）：DSH 0.1.2 起
    // web 有 launch-token 瀏覽器認證（start.sh 依賴）；credentials/session 格式隨
    // 版本演進（0.1.0-rc.8 的解析器只認舊 flat layout，讀新格式會 boot 失敗），
    // 故必須精確鎖版並與執行中的 harness 同步。Regex 鎖 0.1.7 alpha/rc 系列、允許
    // patch 號浮動，避免升級時誤紅。
    //
    // 0.1.2 → 0.1.5 升級的連帶影響（實測，勿再踩）：session log 檔名由
    // `session.jsonl(.zstd)` 改為 `session.v3.jsonl(.zstd)`（會話格式升 V3）。
    // src/usage/session-log.ts 的檔名比對已同步放寬為 `session(.v<N>)?.jsonl(.zstd)?`；
    // 若未一併更新，factory-usage 會一個 session 都找不到，量測靜默歸零而
    // **不會讓任何 run 變紅**（usage 是附註不是 gate）——典型無聲失效。
    expect(read('package.json')).toMatch(/"@deepseek-ai\/dsh": "\^?0\.1\.7-(alpha|rc)\.\d+"/)
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
      'task-template-write-spec.txt',
    ]) {
      const c = read(`.github/factory/${t}`)
      expect(c).toContain('<REPO>')
      expect(c).toContain('<BASE_BRANCH>')
      expect(c).toContain('export GH_REPO=$(cat .factory/run/repo')
      expect(c).toContain('export BASE_BRANCH=$(cat .factory/run/base-branch')
    }
  })
  it('7 種 task_type 各有一個專屬 task-template 檔（下拉選單直接對應，ADR 決定）', () => {
    const w = read('.github/workflows/factory-run.yml')
    const m = w.match(/^ {8}options: \[(.+)\]$/m)
    expect(m).not.toBeNull()
    const options = m![1]!.split(',').map((s) => s.trim())
    // `auto` 是**解析指示**而非任務類型：它要求從 Issue 讀出真正的類型
    // （docs/02 §3.2 契約在 Issue），因此不對應任何 task-template 檔。
    expect(options).toEqual([
      'auto',
      'agent-add-tests',
      'agent-fix-bug',
      'agent-update-deps',
      'agent-write-docs',
      'agent-write-spec',
      'agent-analyze',
      'agent-propose-skill',
    ])
    // 檔名慣例：task-template-<type>.txt（type 無 agent- 前綴）——
    // 路由必須剝除前綴，否則專屬模板永遠拼不出檔名（2026-08-21 實測抓到的
    // 既有 bug：PR #101 後 4 型全部靜默 fallback 到通用模板）。
    expect(w).toContain('task-template-${TASK_TYPE#agent-}.txt')
    for (const t of options.filter((o) => o !== 'auto')) {
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
  it('ISSUE_TEMPLATE 的 task_type 7 種選項齊全', () => {
    const yml = read('.github/ISSUE_TEMPLATE/factory-work-item.yml')
    for (const t of [
      'agent-add-tests',
      'agent-fix-bug',
      'agent-update-deps',
      'agent-write-docs',
      'agent-write-spec',
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
  it('Backstage template enum 與 workflow options 一致（扣除 auto，防 #238 漂移）', () => {
    const w = read('.github/workflows/factory-run.yml')
    const options = w.match(/^ {8}options: \[(.+)\]$/m)![1]!.split(',').map((s) => s.trim())
    const bs = read('backstage/templates/factory-work-item/template.yaml')
    const enumBlock = bs.match(/enum:\n((?: {12}- agent-[\w-]+\n)+)/)
    expect(enumBlock, 'Backstage template 找不到 taskType enum 區塊').not.toBeNull()
    const enumTypes = [...enumBlock![1]!.matchAll(/- (agent-[\w-]+)/g)].map((m) => m[1])
    // Backstage 表單是**建立 Issue 的入口**，必須寫入一個具體類型；
    // `auto`（從既有 Issue 讀回類型）在那裡沒有意義，故只存在於 workflow 端。
    // 其餘型別仍須逐字一致——#238 的漂移正是從這裡開始。
    expect(options.filter((o) => o !== 'auto')).toEqual(enumTypes)
    expect(options, 'workflow 必須提供 auto').toContain('auto')
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
  it('Backstage 表單預設 agent-add-tests；workflow 預設 auto（兩者刻意不同）', () => {
    const t = read('backstage/templates/factory-work-item/template.yaml')
    // Backstage 是建立 Issue 的入口，預設值讓 Review 按鈕不需手選即可按
    // （2026-08-21 UX 修正），且該值會被寫進 Issue body，dispatch 與 Issue 一致。
    expect(t).toMatch(/default: agent-add-tests/)
    // factory-run 則相反：它面對的是**已存在的 Issue**，任何固定預設都會在
    // 漏帶 -f task_type 時靜默覆蓋 Issue 的宣告（實測 #287：Issue 寫
    // agent-fix-bug，實跑 add-tests，run 全綠無提示）。故預設必須是 auto。
    expect(read('.github/workflows/factory-run.yml')).toContain('default: auto')
    expect(
      read('.github/workflows/factory-run.yml'),
      'factory-run 不得再有固定類型的 input 預設',
    ).not.toContain('default: agent-add-tests')
  })
  it('Backstage taskType enum 與 ISSUE_TEMPLATE 下拉一致（7 型，2026-09-01 C1 漂移修復）', () => {
    const t = read('backstage/templates/factory-work-item/template.yaml')
    const yml = read('.github/ISSUE_TEMPLATE/factory-work-item.yml')
    const expected = [
      'agent-add-tests',
      'agent-fix-bug',
      'agent-update-deps',
      'agent-write-docs',
      'agent-write-spec',
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

  it('分頁標籤用英文，與同排的內建分頁一致', () => {
    const idx = read('backstage/plugins/factory-draft/src/index.tsx')
    // 內建分頁是 Templates / Tasks / Actions / Template Editor，全是英文；
    // 導覽標籤若只有這個分頁是中文，同排看起來會像壞掉。
    expect(idx).toContain("title: 'Task History'")
    // 反向釘住：標籤不得再是中文。`title:` 在本檔只出現在 SubPageBlueprint 的
    // params（其餘是註解），故這條能守住不退回中文標籤。
    expect(idx).not.toMatch(/^\s*title: '[^']*[\u4e00-\u9fff]/m)
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
    // A1 後 agent step 的 timeout 改為計算式（綁 agent-timeout 輸出），不再有字面
    // 數字；此處只驗證「若非計算式則必須 ≥ 40」。計算式的下限由下面
    // 「agent 逾時預算動態化」describe 逐條釘住（含 ≥50 分的回歸鎖）。
    // 只切出 agent 步驟本身（到下一個步驟為止）——否則會誤抓到後續步驟的逾時
    //（例如 ADR-018 的集中驗證步驟 35 分）。
    const start = c.indexOf('name: Run factory agent')
    const next = c.indexOf('\n      - name:', start)
    const agentStep = c.slice(start, next === -1 ? undefined : next)
    const literal = agentStep.match(/timeout-minutes: (\d+)/)
    if (literal) {
      expect(Number(literal[1])).toBeGreaterThanOrEqual(40)
    } else {
      expect(agentStep).toContain('fromJSON(steps.agent-timeout.outputs.step_timeout_minutes)')
    }
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

/**
 * A1（34735315950 事故修正）：agent 逾時預算必須是**計算出來的**，不是硬編碼。
 *
 * 事故：`timeout-minutes: 50` 寫死，而 heavy-verify（模型檢查/求解器迭代）任務
 * 本質上無法在 50 分內收斂——agent 重寫模型 4 版、起停 10+ 個 Apalache job 後
 * 仍卡在 state 8/12 被砍，且 step 逾時會直接殺掉 process，agent 來不及寫 report。
 *
 * 契約：
 *  1. 存在「Compute agent timeout budget」步驟，依 model.json 的 tier/escalation 決策；
 *  2. step 級 timeout 綁該步驟輸出（非字面數字）——字面值會讓計算步驟形同虛設；
 *  3. heavy-verify 預設 ≥ 100 分、其餘 tier ≥ 50 分（不得低於舊硬編碼值）；
 *  4. 內層 timeout(1) 具名逾時（A4），止原因可歸因。
 */
describe('agent 逾時預算動態化（A1/A4，34735315950）', () => {
  const c = read('.github/workflows/factory-run.yml')

  it('存在 Compute agent timeout budget 步驟且讀 model.json', () => {
    expect(c).toContain('name: Compute agent timeout budget')
    expect(c).toContain('id: agent-timeout')
    expect(c).toContain('.factory/model.json')
  })

  it('step 級 timeout 綁 agent-timeout 輸出（不得寫死字面值）', () => {
    expect(c).toMatch(/timeout-minutes: \$\{\{ fromJSON\(steps\.agent-timeout\.outputs\.step_timeout_minutes\) \}\}/)
    // 反向釘住：agent step 不得再出現硬編碼的 50（舊事故值）
    const agentStep = c.slice(c.indexOf('id: agent'))
    expect(agentStep).not.toMatch(/timeout-minutes: 50\b/)
  })

  it('heavy-verify 預算 ≥ 100 分；其餘 tier ≥ 50 分（不得低於舊值）', () => {
    const budgets = [...c.matchAll(/EFFECTIVE=(\d+)/g)].map((m) => Number(m[1]))
    expect(budgets.length, '找不到 EFFECTIVE= 預算指派').toBeGreaterThanOrEqual(3)
    expect(Math.max(...budgets), 'heavy-verify 預算過低').toBeGreaterThanOrEqual(100)
    expect(Math.min(...budgets), '常態預算低於舊硬編碼 50 分（回歸）').toBeGreaterThanOrEqual(50)
  })

  it('agent_timeout_minutes input 存在且預設 0（0 = 自動）', () => {
    expect(c).toContain('agent_timeout_minutes:')
    expect(c).toMatch(/agent_timeout_minutes:[\s\S]{0,300}?default: 0/)
  })

  it('內層以 timeout(1) 包住 dsh，逾時可歸因（A4）', () => {
    expect(c).toContain('timeout --signal=TERM --kill-after=30s')
    // 124/137 都是逾時訊號，必須都被辨識
    expect(c).toMatch(/code.*-eq 124/)
    expect(c).toMatch(/code.*-eq 137/)
    expect(c).toContain('agent-inner-timeout')
  })
})

/**
 * A2（34735315950）：逾時必須具名寫進 report.json，否則 judge/scoreboard 收到的
 * `stop_reason` 是 null，50 分鐘的失敗在資料層完全沒有名字。
 */
describe('止原因具名化接線（A2）', () => {
  const c = read('.github/workflows/factory-run.yml')
  it('write-report 呼叫帶 --stop-reason / --provider / --attempts', () => {
    expect(c).toContain('--stop-reason')
    expect(c).toContain('--provider')
    expect(c).toContain('--attempts')
  })
  it('dry_run 不套用真實止原因語意（避免偽造歸因）', () => {
    expect(c).toMatch(/dry_run[^\n]*!= "true"[\s\S]{0,80}REPORT_ARGS/)
  })
})

/**
 * B6（34735315950）：「這個模型檢查任務可不可行」應該在**花成本前**被揭露，
 * 而不是讓 agent 燒 50 分鐘牆鐘才發現。preflight 是零成本 advisory 檢查。
 */
describe('heavy-verify 前置檢查（B6）', () => {
  const c = read('.github/workflows/factory-run.yml')
  it('存在 Preflight heavy-verify 步驟，且在 agent 步驟之前', () => {
    const pre = c.indexOf('name: Preflight heavy-verify feasibility')
    const agent = c.indexOf('name: Run factory agent')
    expect(pre, '找不到 preflight 步驟').toBeGreaterThan(-1)
    expect(agent, '找不到 agent 步驟').toBeGreaterThan(-1)
    expect(pre, 'preflight 必須排在 agent 之前（否則無法預警）').toBeLessThan(agent)
  })
  it('只對 heavy-verify 觸發（依 model.json 的 escalation）', () => {
    expect(c).toMatch(/ESCALATION.*heavy-verify/)
    expect(c).toContain('heavy_verify=false')
  })
  it('缺工具鏈時 fail-loud warning（不靜默）', () => {
    expect(c).toMatch(/::warning::heavy-verify 前置缺口/)
    expect(c).toContain('quint-dep')
  })
})

/**
 * A1 的 job 級上限：step 預算 115 分必須小於 job 逾時，否則 step 永遠跑不到
 * 自己的預算就被 job 砍掉，而 job 逾時不會觸發 step 的失敗處理（終態留言缺失）。
 */
describe('job 逾時上限涵蓋 heavy-verify step 預算（A1）', () => {
  it('job timeout-minutes > 最大 step 預算 + 收尾餘裕', () => {
    const { load } = require('js-yaml') as typeof import('js-yaml')
    const wf = load(read('.github/workflows/factory-run.yml')) as {
      jobs: { run: { 'timeout-minutes': number; steps: { name?: string; 'timeout-minutes'?: unknown }[] } }
    }
    const jobTimeout = wf.jobs.run['timeout-minutes']
    const budgets = [...read('.github/workflows/factory-run.yml').matchAll(/EFFECTIVE=(\d+)/g)].map((m) => Number(m[1]))
    const maxStep = Math.max(...budgets) + 5 // step = EFFECTIVE + 5
    expect(jobTimeout, `job 逾時 ${jobTimeout} 必須大於最大 step 逾時 ${maxStep}`).toBeGreaterThan(maxStep)
  })
  it('write-spec 模型階段：agent 與集中驗證都用滿時，job 上限仍放得下（ADR-018 §7）', () => {
    const { load } = require('js-yaml') as typeof import('js-yaml')
    const wf = load(read('.github/workflows/factory-run.yml')) as {
      jobs: { run: { 'timeout-minutes': number; steps: { id?: string; 'timeout-minutes'?: unknown }[] } }
    }
    const budgets = [...read('.github/workflows/factory-run.yml').matchAll(/EFFECTIVE=(\d+)/g)].map((m) => Number(m[1]))
    const agentStep = Math.max(...budgets) + 5
    const verifyStep = wf.jobs.run.steps.find((st) => st.id === 'specverify')?.['timeout-minutes']
    expect(typeof verifyStep, '集中驗證步驟必須有自己的 timeout-minutes').toBe('number')
    // 其餘步驟（setup/usage/judge/上傳）沿用 A1 的 35 分餘裕
    expect(wf.jobs.run['timeout-minutes']).toBeGreaterThanOrEqual(agentStep + (verifyStep as number) + 35)
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
    primary: { provider: string; model: string; reasoningEffort?: string }
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

  it('用戶模型優先序：low/medium=qwen3.8-flash（2026-08-27 起為預設）、high=deepseek-flash、critical=opus-5', () => {
    expect(tiers.low.primary.provider).toBe('qwen')
    expect(tiers.low.primary.model).toBe('qwen3.8-flash')
    expect(tiers.medium.primary.provider).toBe('qwen')
    expect(tiers.medium.primary.model).toBe('qwen3.8-flash')
    // 原預設 deepseek-v4-flash 退居 low/medium fallback（跨 provider failover，Q04-8）；
    // 2026-09-11 起該 deepseek fallback 為 v4.1-flash。
    expect(tiers.low.fallback.map((e) => e.model)).toContain('deepseek-flash')
    expect(tiers.medium.fallback.map((e) => e.model)).toContain('deepseek-flash')
    expect(tiers.high.primary.model).toBe('deepseek-flash')
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
    // → deepseek-v4-flash 與 deepseek-v4-pro 一律改為 deepseek-flash。
    for (const [id, t] of Object.entries(tiers)) {
      const models = [t.primary, ...t.fallback].map((e) => e.model)
      expect(models, `tier ${id} 不得含已汰換的 deepseek-v4-flash`).not.toContain('deepseek-v4-flash')
      expect(models, `tier ${id} 不得含已汰換的 deepseek-v4-pro`).not.toContain('deepseek-v4-pro')
      // deepseek-v4.1-flash 是不存在的 id（API 回 HTTP 400：supported names are
      // deepseek-flash, deepseek-v4-pro）——曾誤用，釘住避免回潮。
      expect(models, `tier ${id} 含不存在的 id deepseek-v4.1-flash`).not.toContain('deepseek-v4.1-flash')
    }
  })

  it('critical tier：primary = claude-opus-5、fallback 由 deepseek-flash 起（fable 已移除）', () => {
    // 2026-08-28 用戶裁決：fable-5 需額外 credit（實測 run #33175623064 無法使用）
    // → 移除 fable-5，critical 預設改為同代旗艦 claude-opus-5。
    const critical = tiers.critical
    expect(critical).toBeDefined()
    expect(critical?.primary.model).toBe('claude-opus-5')
    expect(critical?.primary.provider).toBe('anthropic')
    expect(critical?.fallback[0]?.model).toBe('deepseek-flash')
  })

  it('critical 必須明設 reasoningEffort: max（否則付旗艦價只換到平手品質）', () => {
    // 2026-09-11 第三方基準（Artificial Analysis Intelligence Index v4.3）：
    //   Opus 5 (max effort) = 51 分；Opus 5 (low effort) = 40 分；deepseek-flash = 40 分。
    // 未設 effort → 走 provider 預設（值未知），critical tier 可能在付約 21 倍成本
    // 換取與 high tier 打平的品質——那會讓「最高 tier」失去存在意義。
    // 注意 opus-5 只接受 off/xhigh/max（pi-ai catalog thinkingLevelMap），
    // 填 low/medium/high 會在執行期 UNSUPPORTED_REASONING_EFFORT。
    const effort = tiers.critical?.primary.reasoningEffort
    expect(effort, 'critical primary 必須宣告 reasoningEffort').toBeDefined()
    expect(['xhigh', 'max'], `opus-5 不接受 effort "${effort}"`).toContain(effort)
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

  it('手動宣告 models 的 route：chain 引用的每個 model 都必須在該清單內（UNKNOWN_MODEL 防線）', () => {
    // 2026-09-11 實測教訓：`deepseek-flash` 不在 pi-ai 0.85.1 內建 catalog，
    // 若 route 未明列該 model，DSH 會以 UNKNOWN_MODEL 失敗（整條 chain 當場作廢）。
    // pi-ai 語意：route 一旦有 models 清單，該清單即「取代」內建 catalog——
    // 因此清單漏列 = 執行期紅燈。本測試把這個對應關係釘在 CI，不靠人工記得。
    const providerDefs = (
      load(read('config/dsh/settings.providers.yaml')) as {
        'llm-pi-ai': { providers: Record<string, { models?: { id: string }[] }> }
      }
    )['llm-pi-ai'].providers
    for (const [id, t] of Object.entries(tiers)) {
      for (const e of [t.primary, ...t.fallback]) {
        const declared = providerDefs[e.provider]?.models
        if (declared === undefined) continue // 無 models 清單 ⇒ 沿用 pi-ai 內建 catalog
        expect(
          declared.map((m) => m.id),
          `tier ${id} 的 ${e.provider}/${e.model} 未列於 settings.providers.yaml 的 models ` +
            `清單；該 route 已手動宣告 models（會取代內建 catalog），漏列會在執行期 UNKNOWN_MODEL`,
        ).toContain(e.model)
      }
    }
  })

  it('deepseek route 明列 deepseek-flash（pi-ai catalog 尚未收錄，2026-09-11）', () => {
    const s = read('config/dsh/settings.providers.yaml')
    expect(s).toContain('id: deepseek-flash')
    expect(s).toContain('baseURL: https://api.deepseek.com')
    // 官方唯一有效的 V4.1 Flash id 是 deepseek-flash；deepseek-v4.1-flash 不存在
    // （API 回 HTTP 400），曾誤用，故在此釘死避免回潮。
    expect(s).not.toContain('deepseek-v4.1-flash')
  })

  /**
   * 「模型真的叫得動」的驗證管道（2026-09-11）。
   *
   * 本檔其餘測試都只能驗證「設定與文件互相一致」——模型 id 不存在、或 pi-ai
   * 不認得該 id，靜態測試一律測不出來（PR #274 全綠卻讓整條 deepseek 路徑失效）。
   * 唯一能發現的方法是真打一次 API，那需要 credential 與費用，因此做成
   * 「本機腳本 + 手動觸發的 CI job」。這裡釘住的是**那條管道本身存在且接對線**，
   * 避免它日後被刪掉或改壞而無人察覺。
   */
  it('verify-models 腳本存在且驗證 L1(API)+L2(DSH) 兩層', () => {
    const s = read('scripts/verify-models.sh')
    expect(s).toContain('api.deepseek.com/models') // L1：模型 id 在供應商端存在
    expect(s).toContain('dsh --profile headless') // L2：pi-ai 認得且能推論
    expect(s).toContain('factory-model.js') // 驗的是 tier chain 的模型，非寫死清單
    // 缺 credential 必須是 SKIP 而非 FAIL——否則紅燈會混淆「沒鑰匙」與「模型壞了」
    expect(s).toContain('SKIP')
  })

  it('verify-models.yml 手動可觸發、帶三家 credential，且複用同一支腳本', () => {
    const c = read('.github/workflows/verify-models.yml')
    expect(c).toContain('workflow_dispatch')
    expect(c).toContain('scripts/verify-models.sh') // 不得另寫第二套驗證邏輯
    for (const secret of ['DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'QWEN_API_KEY']) {
      expect(c, `verify-models.yml 缺 ${secret}`).toContain(secret)
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

  // 實測（Issue #287，2026-09-13）：workflow 監聽 labeled，但 labeled 事件中只有
  // factory/approved 需要做事。條件原本只寫在 step 層，於是每貼一個無關 label
  // （meta/observation、oversight/*、ready、needs-human…）都會啟動 runner、checkout、
  // pnpm install、pnpm run build，然後所有 step 都 skipped：
  //   run 34731348555  labeled(meta/observation)  → 全 skip，空跑 33s
  //   run 34731515739  labeled(oversight/review)  → 全 skip，空跑 27s
  // 而 factory-run 每次執行都會貼 oversight/*、ready 或 needs-human，
  // 故每個工作項生命週期都會重複發生。
  //
  // 契約：labeled 的過濾必須存在於 **job 層**——寫在 step 層擋不住 runner 啟動。
  it('factory-issue-check.yml 在 job 層過濾非 factory/approved 的 labeled 事件（防空跑）', () => {
    const wf = load(read('.github/workflows/factory-issue-check.yml')) as {
      jobs: Record<string, { if?: string } | undefined>
    }
    const jobIf = wf.jobs['check']?.if
    expect(
      jobIf,
      'jobs.check 缺 job 層 if——labeled 事件會等 runner 起來、install、build 後才 skip',
    ).toBeTypeOf('string')
    expect(jobIf).toContain("github.event.action != 'labeled'")
    expect(jobIf).toContain("github.event.label.name == 'factory/approved'")
  })

  it('factory-issue-check.yml 的 job 層條件不擋掉 opened/edited（防過度收斂）', () => {
    // YAML 1.1 陷阱：未加引號的 `on:` 會被 js-yaml 解析成 boolean true 當 key。
    const raw = load(read('.github/workflows/factory-issue-check.yml')) as Record<string, unknown>
    const triggers = (raw['on'] ?? raw['true']) as { issues?: { types?: string[] } } | undefined
    expect(triggers?.issues?.types, 'on.issues.types 應含 opened/edited/labeled').toEqual(
      expect.arrayContaining(['opened', 'edited', 'labeled']),
    )
    // opened/edited 時 action != 'labeled' 成立 → job 必須執行。以左式開頭確保這條
    // 分支存在且未被改寫成只認 factory/approved（那會讓格式檢查整個消失）。
    const jobIf = (raw['jobs'] as Record<string, { if?: string }>)['check']?.if ?? ''
    expect(jobIf.trim().startsWith("github.event.action != 'labeled'")).toBe(true)
  })

  it('factory-issue-check 留言含複雜度分析與建議模型行（ADR-011）', () => {
    const src = read('src/cli/factory-issue-check.ts')
    expect(src).toContain('📊 **複雜度分析**')
    expect(src).toContain('🤖 **建議模型**')
    expect(src).toContain('analyzeComplexity')
    expect(src).toContain('resolveModelTier')
  })

  // 每個用得到 gh 的 step 都必須自帶 GH_TOKEN——gh 在 Actions **不會**自動撿
  // GITHUB_TOKEN（2026-08-19 實測，該檔第 42-43 行已記載）。
  // 實測缺口：「Dispatch factory-run on approval label」步驟漏設，因為
  // factory/approved 這個 label 從未在 repo 建立，該路徑一次都沒走到，
  // 缺 token 也就一直沒有暴露——沒有症狀不等於沒有缺陷。
  it('factory-issue-check.yml 每個呼叫 gh 的 step 都設了 GH_TOKEN', () => {
    const wf = load(read('.github/workflows/factory-issue-check.yml')) as {
      jobs: Record<string, { steps?: { name?: string; run?: string; env?: Record<string, string> }[] }>
    }
    const steps = wf.jobs['check']?.steps ?? []
    expect(steps.length, '解析不到 steps——結構可能已變動').toBeGreaterThan(0)
    for (const step of steps) {
      if (step.run === undefined || !/(^|\s)gh\s/m.test(step.run)) continue
      expect(
        step.env?.['GH_TOKEN'],
        `step「${step.name ?? '(未命名)'}」用了 gh 但未設 GH_TOKEN`,
      ).toBeDefined()
    }
  })
})

describe('label bootstrap 覆蓋發射端（run 34731487680：skill-gap 未建立導致收尾 exit 1）', () => {
  const { load } = require('js-yaml') as typeof import('js-yaml')

  // `gh issue edit --add-label` 不會自動建立 label，缺一個就整條指令失敗。
  // 發射端（apply-*-labels）與 bootstrap（factory-run.yml）是兩份清單，
  // docs/20 E4 加了 skill-gap 發射端卻沒加 bootstrap，於是任何回報 skillGap
  // 的 run 都會在最後一步炸掉——agent 工作已成功卻被標成 failure。
  it('FACTORY_LABELS 的每個成員都出現在 factory-run.yml 的 gh label create', async () => {
    const { FACTORY_LABELS } = (await import('../../src/labels.js')) as {
      FACTORY_LABELS: readonly string[]
    }
    const wf = read('.github/workflows/factory-run.yml')
    const created = new Set(
      [...wf.matchAll(/gh label create\s+"([^"]+)"/g)].map((m) => m[1] as string),
    )
    expect(created.size, 'factory-run.yml 找不到任何 gh label create').toBeGreaterThan(0)
    expect(FACTORY_LABELS.length).toBeGreaterThan(0)
    for (const label of FACTORY_LABELS) {
      expect(
        created.has(label),
        `factory-run.yml 的 bootstrap 未建立 "${label}"——貼標籤時會 exit 1`,
      ).toBe(true)
    }
  })

  // 反向鎖之一：src/labels.ts 匯出的每個單一 label 常數都必須在 FACTORY_LABELS 內。
  //
  // 少了這條，上一條會有一個無聲的破口：把 SKILL_GAP_LABEL 從 FACTORY_LABELS
  // 拿掉、但發射端仍 `labels.push(SKILL_GAP_LABEL)`，兩條測試都不會紅
  // ——bootstrap 不建立、執行期照貼，run 34731487680 的失敗原封不動回來。
  // （實測：撰寫時先漏了這條，探針拔掉 SKILL_GAP_LABEL 後 122 條全綠。）
  it('src/labels.ts 匯出的每個 *_LABEL 常數都在 FACTORY_LABELS 內', async () => {
    const mod = (await import('../../src/labels.js')) as Record<string, unknown>
    const factoryLabels = mod['FACTORY_LABELS'] as readonly string[]
    const singles = Object.entries(mod).filter(
      ([name, value]) => name.endsWith('_LABEL') && typeof value === 'string',
    )
    expect(singles.length, 'labels.ts 未匯出任何單一 label 常數——本測試會空跑').toBeGreaterThan(0)
    for (const [name, value] of singles) {
      expect(
        factoryLabels.includes(value as string),
        `${name} = '${value as string}' 未列入 FACTORY_LABELS，bootstrap 不會建立它`,
      ).toBe(true)
    }
  })

  // 反向鎖之二：發射端若新增**字面值**卻沒進 FACTORY_LABELS，第一條就形同虛設。
  // 掃 apply-judge-labels.ts 的 labels.push(...) 引數，逐一要求在清單內。
  it('apply-judge-labels 推入的 label 字面值都在 FACTORY_LABELS 內', async () => {
    const { FACTORY_LABELS } = (await import('../../src/labels.js')) as {
      FACTORY_LABELS: readonly string[]
    }
    const src = read('src/cli/apply-judge-labels.ts')
    const pushedLiterals = [...src.matchAll(/labels\.push\(\s*'([^']+)'\s*\)/g)].map(
      (m) => m[1] as string,
    )
    for (const label of pushedLiterals) {
      expect(
        FACTORY_LABELS.includes(label),
        `apply-judge-labels 直接 push 了字面值 '${label}'，但它不在 src/labels.ts 的 FACTORY_LABELS——bootstrap 不會建立它`,
      ).toBe(true)
    }
  })

  it('FACTORY_LABELS 涵蓋全部 oversight tier 與 needs-human（新增 tier 不得漏建）', async () => {
    const { FACTORY_LABELS } = (await import('../../src/labels.js')) as {
      FACTORY_LABELS: readonly string[]
    }
    const { TIER_LABEL } = await import('../../src/scoring/types.js')
    const { NEEDS_HUMAN_LABEL } = await import('../../src/stop-rules/types.js')
    for (const label of Object.values(TIER_LABEL)) {
      expect(FACTORY_LABELS).toContain(label)
    }
    expect(FACTORY_LABELS).toContain(NEEDS_HUMAN_LABEL)
  })

  // Issue 是工作項契約（docs/02 §3.2）。實測 #287：dispatch 漏帶 task_type，
  // input 預設 agent-add-tests 靜默覆蓋 Issue 宣告的 agent-fix-bug，
  // agent 因此只交付 test-only 一層，而 run 全綠、無任何提示。
  it('factory-run.yml 的 task_type 預設為 auto（不得以固定類型靜默覆蓋 Issue）', () => {
    const raw = load(read('.github/workflows/factory-run.yml')) as Record<string, unknown>
    const on = (raw['on'] ?? raw['true']) as {
      workflow_dispatch?: { inputs?: Record<string, { default?: string; options?: string[] }> }
    }
    const input = on.workflow_dispatch?.inputs?.['task_type']
    expect(input?.default, 'task_type 預設必須是 auto').toBe('auto')
    expect(input?.options, 'options 必須含 auto').toContain('auto')
  })

  it('task_type 的解析共用 checkIssue，不得各自重打正則（雙份規則＝漂移）', () => {
    const run = read('.github/workflows/factory-run.yml')
    expect(run).toContain('checkIssue')
    // 兩支 workflow 都不得再出現自寫的「### 任務類型」正則
    for (const wf of ['.github/workflows/factory-run.yml', '.github/workflows/factory-issue-check.yml']) {
      expect(read(wf), `${wf} 仍有自寫的任務類型正則`).not.toMatch(/### 任務類型\\s\*/)
    }
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
    // deepseek-flash：官方定價頁直接以 USD 公布（無匯率假設），取高峰時段價
    // （空閒為半價）：input $0.30 / output $1.20 / cacheRead $0.006。
    expect(pricing['deepseek-flash']?.inputUsdPerMTok).toBe(0.3)
    expect(pricing['deepseek-flash']?.outputUsdPerMTok).toBe(1.2)
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

/**
 * G1 終態守衛必須帶上技能缺口（2026-09-14 實測缺口）。
 *
 * 缺口進入 Issue 目前只有一條路徑：`apply-judge-labels` 讀 judge.json。該步驟
 * 失敗時，G1 守衛補貼的留言只帶 usage，skillGap 整段消失；而 factory-push-event
 * 直接讀 report.json，照樣把事件推進 Scoreboard。於是「D1 有、Issue 沒有」。
 *
 * 盤點 Scoreboard 全部 5 筆缺口，3 筆命中此路徑（run 34731487680 →
 * software_factory#287；34371349788／34372193923 → camunda_hazelcast#25），
 * 其唯一人類可讀副本是 ~90 天後就過期的 artifacts。docs/25 §2.2 卻把
 * 「Issue 留言＝永久」當成聚類主源——該前提在守衛路徑上並不成立。
 *
 * 本組測試釘住修補後的接線，避免日後重構把守衛改回只帶 usage。
 */
describe('G1 終態守衛保存 skillGap（judge/labels 失敗時的唯一入 Issue 路徑）', () => {
  const { load } = require('js-yaml') as typeof import('js-yaml')

  /** 取 factory-run.yml 中 G1 守衛那一步的 run 指令。 */
  function guardRun(): string {
    const wf = load(read('.github/workflows/factory-run.yml')) as {
      jobs: Record<string, { steps: { name?: string; run?: string }[] }>
    }
    const steps = Object.values(wf.jobs).flatMap((j) => j.steps ?? [])
    const guard = steps.find((s) => (s.name ?? '').includes('Ensure terminal state'))
    expect(guard, 'factory-run.yml 找不到 G1 終態守衛步驟——本測試會空跑').toBeDefined()
    return guard?.run ?? ''
  }

  it('守衛呼叫 factory-skill-gap 取出缺口（否則 judge 失敗時缺口只剩 D1）', () => {
    expect(guardRun()).toContain('dist/cli/factory-skill-gap.js')
  })

  it('守衛把缺口檔附加進留言本體（僅呼叫不附加＝白跑）', () => {
    const run = guardRun()
    const outMatch = /--out\s+(\S+)/.exec(run)
    expect(outMatch, '守衛未以 --out 指定缺口檔路徑').not.toBeNull()
    const outPath = outMatch?.[1] as string
    // 同一個路徑必須同時出現在「非空判斷」與「cat 進留言」兩處，否則寫到 A、
    // 讀 B 的漂移不會有任何症狀：留言照貼，只是永遠不含缺口。
    expect(run).toContain(`[ -s ${outPath} ]`)
    expect(run).toContain(`cat ${outPath}`)
    expect(run).toContain('--body-file .factory/guard-comment.txt')
  })

  it('取出失敗不得中止守衛（守衛是最後一道網，不能變成新的失敗來源）', () => {
    expect(guardRun()).toMatch(/factory-skill-gap\.js[\s\S]*?\|\|\s*echo/)
  })

  it('factory-skill-gap 重用 src/skill-gap/render.ts，不自寫第二套格式', () => {
    const src = read('src/cli/factory-skill-gap.ts')
    expect(src).toContain('renderSkillGapMarkdown')
    // 格式契約只能有一份（見 render.ts 檔首）：第二套一旦分歧，聚類器會把
    // 新舊留言分到不同解析分支，docs/25 §3 的「≥3 次」門檻永遠達不到。
    expect(src).not.toContain('### 🧩')
  })
})

/**
 * ADR-018 §11：write-spec 的兩個開單欄位要在四處逐字一致，否則重演 #238——
 * 新增 task_type 時漏改 Backstage，表單永遠開不出該類型。這裡的漂移同樣無聲：
 * 標題差一個字，issue-check 就永遠讀不到欄位、永遠判「缺規格名稱」。
 */
describe('write-spec 開單欄位四處同步（ADR-018 §11）', () => {
  const SPEC_FIELDS = ['spec_name', 'spec_source'] as const
  const { load } = require('js-yaml') as typeof import('js-yaml')
  type BsParams = {
    properties: { taskType: { enum: string[] } }
    dependencies: {
      taskType: {
        oneOf: {
          properties: Record<string, { title?: string; enum?: string[]; pattern?: string; maxLength?: number }>
          required?: string[]
        }[]
      }
    }
  }
  const bsParams = (): BsParams =>
    (load(read('backstage/templates/factory-work-item/template.yaml')) as {
      spec: { parameters: BsParams[] }
    }).spec.parameters[0]!

  it('FIELD_TITLES 有兩個欄位', () => {
    for (const f of SPEC_FIELDS) expect(FIELD_TITLES[f], f).toBeTruthy()
  })
  it('ISSUE_TEMPLATE：以欄位標題作為 label（GitHub 以 label 當 ### 標題）', () => {
    const yml = load(read('.github/ISSUE_TEMPLATE/factory-work-item.yml')) as {
      body: { id?: string; attributes: { label: string } }[]
    }
    for (const f of SPEC_FIELDS) {
      const item = yml.body.find((b) => b.id === f)
      expect(item, `ISSUE_TEMPLATE 缺 ${f}`).toBeDefined()
      expect(item!.attributes.label).toBe(FIELD_TITLES[f])
    }
  })
  it('Backstage：body 含兩個 ### 標題，且未填時輸出 _No response_', () => {
    const t = read('backstage/templates/factory-work-item/template.yaml')
    expect(t).toContain(`### ${FIELD_TITLES.spec_name}\n\n          \${{ parameters.specName or '_No response_' }}`)
    expect(t).toContain(`### ${FIELD_TITLES.spec_source}\n\n          \${{ parameters.specSource or '_No response_' }}`)
  })
  it('buildIssueBody：輸出兩個 ### 標題', () => {
    const body = buildIssueBody({ taskType: 'agent-add-tests', requirement: 'x', targetRepo: 'o/r' })
    for (const f of SPEC_FIELDS) expect(body).toContain(`### ${FIELD_TITLES[f]}`)
  })
  it('Backstage 條件分支：write-spec 分支必填兩欄位、標題一致；另一分支恰為其餘類型', () => {
    const p = bsParams()
    const [writeSpec, others] = p.dependencies.taskType.oneOf
    expect(writeSpec!.properties.taskType!.enum).toEqual(['agent-write-spec'])
    expect(writeSpec!.required).toEqual(['specName', 'specSource'])
    expect(writeSpec!.properties.specName!.title).toBe(FIELD_TITLES.spec_name)
    expect(writeSpec!.properties.specSource!.title).toBe(FIELD_TITLES.spec_source)
    // 其餘分支必須與主 enum 同步：新增類型時漏改這裡，選那個類型就沒有分支可匹配
    expect(others!.properties.taskType!.enum).toEqual(
      p.properties.taskType.enum.filter((t) => t !== 'agent-write-spec'),
    )
  })
  it('Backstage 規格名稱的 pattern／maxLength 與 issue-check 同一份規則', () => {
    const spec = bsParams().dependencies.taskType.oneOf[0]!.properties.specName!
    expect(spec.pattern).toBe(SPEC_NAME_PATTERN)
    expect(spec.maxLength).toBe(SPEC_NAME_MAX)
  })
  it('factory-run 呼叫 issue-check 時傳入目標 repo 的 catalog 與 checkout 根目錄', () => {
    const w = read('.github/workflows/factory-run.yml')
    expect(w).toContain('--catalog target/catalog-info.yaml')
    expect(w).toContain('--target-root target')
  })
})

/**
 * ADR-018 §12：write-spec 的階段判定接線。這些性質一旦被無聲破壞，順序保證就會
 * 失效，而且 run 照樣是綠的——所以用解析後的 workflow 結構釘住，而不是字串比對。
 */
describe('write-spec 階段判定接線（ADR-018 §12）', () => {
  const { load } = require('js-yaml') as typeof import('js-yaml')
  type Step = { name?: string; id?: string; if?: string; run?: string }
  const wf = () =>
    load(read('.github/workflows/factory-run.yml')) as {
      on: { workflow_dispatch: { inputs: Record<string, unknown> } }
      jobs: { run: { steps: Step[] } }
    }
  const steps = () => wf().jobs.run.steps
  const indexOf = (pred: (s: Step) => boolean): number => {
    const i = steps().findIndex(pred)
    expect(i, '找不到預期的步驟').toBeGreaterThanOrEqual(0)
    return i
  }
  const phaseIdx = () => indexOf((s) => s.id === 'specphase')

  it('階段判定只在 write-spec 執行，並呼叫 factory-spec-phase', () => {
    const s = steps()[phaseIdx()]!
    expect(s.if).toBe("steps.tasktype.outputs.value == 'agent-write-spec'")
    expect(s.run).toContain('dist/cli/factory-spec-phase.js')
    expect(s.run).toContain('--snapshot-out .factory/spec-source-snapshot.md')
  })
  it('順序：所有 checkout 之後、計分與 agent 之前（快照不被蓋掉、拒絕時零 LLM 成本）', () => {
    const p = phaseIdx()
    expect(indexOf((s) => s.name === 'Ensure base branch checked out in target')).toBeLessThan(p)
    expect(indexOf((s) => s.name === 'Verify app token write access (target repo)')).toBeLessThan(p)
    expect(p).toBeLessThan(indexOf((s) => s.id === 'score'))
    expect(p).toBeLessThan(indexOf((s) => s.id === 'model'))
    expect(p).toBeLessThan(indexOf((s) => s.name === 'Run factory agent'))
  })
  it('拒絕時留言並以非零結束（agent 不會啟動）', () => {
    const run = steps()[phaseIdx()]!.run!
    expect(run).toMatch(/if \[ "\$DECISION" = "refuse" \]; then[\s\S]*?gh issue comment[\s\S]*?exit 1/)
  })
  it('沒有「指定階段」的 dispatch input（不留跳過第一階段的後門）', () => {
    const inputs = Object.keys(wf().on.workflow_dispatch.inputs)
    expect(inputs.filter((k) => /spec|phase/i.test(k))).toEqual([])
  })
  it('階段往下傳：選模型、任務模板、crosscheck、judge', () => {
    const byId = (id: string) => steps().find((s) => s.id === id)!.run!
    expect(byId('model')).toContain('--spec-phase ${{ steps.specphase.outputs.phase }}')
    const agent = steps().find((s) => s.name === 'Run factory agent')!.run!
    expect(agent).toContain('s|<SPEC_PHASE>|${{ steps.specphase.outputs.phase }}|g')
    expect(agent).toContain('s|<SPEC_NAME>|${{ steps.specphase.outputs.spec_name }}|g')
    const cc = byId('crosscheck')
    expect(cc).toContain('--write-spec-phase ${{ steps.specphase.outputs.phase }}')
    expect(cc).toContain('--pr-bodies .factory/pr-bodies.json')
    expect(cc).toContain('--source-snapshot .factory/spec-source-snapshot.md')
    expect(byId('judge')).toContain('--task-type "${{ steps.tasktype.outputs.value }}"')
  })
  it('人貼的兩個 spec 標籤也預先建立（不存在就貼不上）', () => {
    const w = read('.github/workflows/factory-run.yml')
    expect(w).toContain('gh label create "spec/approved"')
    expect(w).toContain('gh label create "spec/model-declined"')
  })
})

/** ADR-018 §7：集中驗證的接線。 */
describe('write-spec 集中驗證接線（ADR-018 §7）', () => {
  const { load } = require('js-yaml') as typeof import('js-yaml')
  type Step = { name?: string; id?: string; if?: string; run?: string; uses?: string }
  const steps = () => (load(read('.github/workflows/factory-run.yml')) as { jobs: { run: { steps: Step[] } } }).jobs.run.steps
  const idx = (pred: (s: Step) => boolean): number => steps().findIndex(pred)

  it('只在 write-spec 且 crosscheck 通過後執行，位於 crosscheck 與 judge 之間', () => {
    const v = idx((s) => s.id === 'specverify')
    expect(v).toBeGreaterThan(idx((s) => s.id === 'crosscheck'))
    expect(v).toBeLessThan(idx((s) => s.id === 'judge'))
    const step = steps()[v]!
    expect(step.if).toBe("steps.specphase.outputs.phase != '' && steps.crosscheck.outcome == 'success'")
    expect(step.run).toContain('dist/cli/factory-spec-verify.js --phase "$PHASE" --spec-name "$SPEC"')
  })
  it('驗證失敗時 judge 與終態標籤都不執行（不會對不完整的證據給出終態）', () => {
    for (const id of ['judge']) {
      expect(steps().find((s) => s.id === id)!.if).toContain("steps.specverify.outcome == 'success' || steps.specverify.outcome == 'skipped'")
    }
    expect(steps().find((s) => s.name === 'Apply judge labels and comment')!.if).toContain('steps.specverify.outcome')
  })
  it('反例 ITF 只寫 traces/ 並推回分支；失敗時貼 needs-human', () => {
    const run = steps().find((s) => s.id === 'specverify')!.run!
    expect(run).toContain('git -C target add -A "specs/${SPEC}/traces"')
    expect(run).toMatch(/if \[ "\$code" -ne 0 \]; then[\s\S]*?--add-label needs-human[\s\S]*?exit 1/)
  })
  it('Quint 工具鏈快取在安裝之前（避免並行下載撞 rate limit）', () => {
    const cache = idx((s) => s.uses === 'actions/cache@v6' && s.name === 'Cache Quint toolchain')
    expect(cache).toBeGreaterThanOrEqual(0)
    expect(cache).toBeLessThan(idx((s) => s.name === 'Install and build'))
  })
})

/**
 * 任務模板的佔位字由 workflow 以 sed 替換。sed 沒有 `g` 旗標時每行只換第一個——
 * 同一行寫兩個 `<ISSUE>`，第二個就原樣送進 agent（2.5 撰寫時實際踩到）。
 * 這條直接解析 workflow 的替換式（含旗標），套到**所有**模板上檢查。
 */
describe('任務模板佔位字替換完整（依 workflow 實際的 sed 旗標）', () => {
  const workflow = read('.github/workflows/factory-run.yml')
  const agentStep = workflow.slice(workflow.indexOf('name: Run factory agent'))
  const rules = [...agentStep.matchAll(/-e "s(.)(<[A-Z_]+>)\1[^"]*?\1(g?)"/g)].map((m) => ({
    token: m[2] as string,
    global: m[3] === 'g',
  }))
  const render = (text: string): string =>
    text
      .split('\n')
      .map((line) =>
        rules.reduce(
          (l, r) => (r.global ? l.split(r.token).join('X') : l.replace(r.token, 'X')),
          line,
        ),
      )
      .join('\n')

  it('解析得到 workflow 的五個佔位字替換式', () => {
    expect(rules.map((r) => r.token).sort()).toEqual(['<BASE_BRANCH>', '<ISSUE>', '<REPO>', '<SPEC_NAME>', '<SPEC_PHASE>'])
  })
  it('每個任務模板替換後都沒有殘留佔位字', () => {
    const dir = join(ROOT, '.github/factory')
    for (const f of readdirSync(dir).filter((n) => n.startsWith('task-template') && n.endsWith('.txt'))) {
      const leftover = render(read(`.github/factory/${f}`)).match(/<(ISSUE|REPO|BASE_BRANCH|SPEC_PHASE|SPEC_NAME)>/g)
      expect(leftover, `${f} 替換後仍殘留 ${leftover?.join(', ')}`).toBeNull()
    }
  })
})

/** ADR-018 步驟 2.5：agent 看得到的作業規則必須涵蓋 2.1–2.4 已生效的每一道機制。 */
describe('write-spec 作業規則（ADR-018 步驟 2.5）', () => {
  const t = read('.github/factory/task-template-write-spec.txt')
  const wf = read('.dsh/skills/factory-workflow/SKILL.md')
  it('模板帶入 CI 判定的階段與規格名稱', () => {
    expect(t).toContain('<SPEC_PHASE>')
    expect(t).toContain('<SPEC_NAME>')
    expect(t).toContain('.factory/run/spec.json')
  })
  it('模板涵蓋各項機制：白名單、快照、source 引用、export、domain_justification、反例、關閉關鍵字、未決事項', () => {
    for (const rule of [
      'specs/<SPEC_NAME>/invariants.qnt',
      '原封不動',
      '// source:',
      'export invariants.*',
      'domain_justification',
      '不得宣告預期結果',
      '候選發現',
      '`Refs #<ISSUE>`',
      '`Closes #<ISSUE>`',
      '## 未決事項',
      'openQuestions',
    ]) {
      expect(t, `模板缺少：${rule}`).toContain(rule)
    }
  })
  it('factory-workflow skill 同步說明兩個階段、export 與 openQuestions', () => {
    for (const rule of ['ADR-018', 'export invariants.*', 'openQuestions', '`Refs #<issue>`', 'domain_justification']) {
      expect(wf, `factory-workflow 缺少：${rule}`).toContain(rule)
    }
  })
  it('factory-pr-stacking 的 Closes 規則有 write-spec 不變量階段的例外', () => {
    expect(read('.dsh/skills/factory-pr-stacking/SKILL.md')).toMatch(/agent-write-spec 的不變量階段改寫 `Refs #<編號>`/)
  })
})
