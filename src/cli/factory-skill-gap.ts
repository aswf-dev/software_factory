/**
 * factory-skill-gap — 從 `report.json` 取出技能缺口並渲染為留言 markdown
 * （docs/25 §2.1、docs/20 E4）。
 *
 * **存在理由（實測缺口）**：技能缺口目前只有一條進 Issue 的路徑——
 * `apply-judge-labels` 讀 `judge.json`。該步驟一旦失敗，G1 終態守衛
 * （`factory-run.yml`「Ensure terminal state」）會補貼一則只帶 usage 的留言，
 * **skillGap 整段消失**；而 `factory-push-event` 直接讀 `report.json`，照樣把
 * 事件推進 Scoreboard。於是同一次 run 的缺口「D1 有、Issue 沒有」。
 *
 * 2026-09-14 盤點 Scoreboard 上全部 5 筆缺口，**3 筆命中此路徑**：
 *
 * | 缺口 | run | Issue 留言 |
 * |---|---|---|
 * | `ci-sandbox-vitest-run` | 34731487680（software_factory#287） | 無 |
 * | `issue-type-scope-mismatch` | 34371349788（camunda_hazelcast#25） | 無 |
 * | `issue-task-type-mismatch` | 34372193923（camunda_hazelcast#25） | 無 |
 *
 * 後果不是「少一段留言」而是**訊號保存期從永久降為 ~90 天**：docs/25 §2.2 明訂
 * 聚類以「Issue 留言（永久）」為主源、artifacts 僅作近期補充，而這三筆的唯一
 * 人類可讀副本正是即將過期的 artifacts。更糟的是偏差方向——**跑得越崎嶇的 run
 * 越可能回報缺口，也越可能讓 judge/labels 失敗**，兩者正相關，於是 Issue 上留下
 * 的缺口系統性地偏向順利完成的 run。
 *
 * > 那三次的**直接**成因（`skill-gap` label 未 bootstrap）已由 `src/labels.ts`
 * > 與對抗性測試修掉，不會再犯。本 CLI 針對的是**類別**而非該次成因：judge 或
 * > labels 因任何理由失敗時，缺口都不該跟著消失。
 *
 * **恆 exit 0**（與 `factory-skills-lock --verify`、`factory-usage` 同立場）：
 * 本 CLI 只在 G1 守衛這條「最後一道網」上執行。在此以非 0 結束，會讓補貼留言
 * 的步驟中止——把守衛本身變成新的失敗來源，正好放大它要修補的那個問題。
 * 因此所有失敗都降級為 stdout 的 `present: false` ＋ stderr 的原因字串。
 *
 * **不重複渲染格式**：markdown 一律由 `src/skill-gap/render.ts` 產出。該格式是
 * 聚類器的解析錨點（見該檔檔首），第二套渲染一旦分歧，跨月計數會靜默斷裂。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { renderSkillGapMarkdown } from '../skill-gap/render.js'
import { SkillGapSchema } from './factory-judge.js'
import { isMainModule } from './is-main-module.js'
import { CliError, runCli } from './run-cli.js'

/**
 * 只取 `skillGap` 一欄，其餘不驗——與 `apply-judge-labels` 同立場：report 的
 * 完整驗證屬於 `factory-judge`，在此再收一次只會製造第二套可能分歧的規則。
 *
 * `null` 與缺席同義（run #34456925126 迴歸）：agent 常以 `"skillGap": null`
 * 表達「無缺口」。
 */
const ReportLikeSchema = z.object({
  skillGap: SkillGapSchema.nullish().transform((v) => v ?? undefined),
})

export interface SkillGapArgs {
  reportPath: string
  /** 寫入 markdown 的目標路徑（可省略；省略時只回傳不落檔）。 */
  outPath?: string | undefined
}

export interface SkillGapOutput {
  present: boolean
  /** `present: false` 時的原因（給 CI log 與人類判讀）；有缺口時為 null。 */
  reason: string | null
  /** 留言段落；無缺口時為空字串。 */
  markdown: string
}

export function parseArgs(argv: string[]): SkillGapArgs {
  let reportPath: string | undefined
  let outPath: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    const need = (flag: string): string => {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) throw new CliError(`${flag} requires a value`)
      return v
    }
    if (arg === '--report') reportPath = need('--report')
    else if (arg === '--out') outPath = need('--out')
    else throw new CliError(`unknown argument: ${arg}`)
  }

  if (reportPath === undefined) throw new CliError('需指定 --report <path>')
  return { reportPath, outPath }
}

/**
 * 讀 report 並取出缺口。
 *
 * 三類「無缺口」一律走同一條回傳路徑（檔案讀不到／JSON 壞掉／欄位缺席或不合法），
 * 差別只在 `reason` 字串：對呼叫端而言它們的處置完全相同（不附加段落），
 * 分成多種結果型別只會讓 workflow 端多寫分支。
 */
export function extractSkillGap(reportPath: string): SkillGapOutput {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(reportPath, 'utf8'))
  } catch (err) {
    return { present: false, reason: `report 無法讀取或非合法 JSON：${(err as Error).message}`, markdown: '' }
  }

  const parsed = ReportLikeSchema.safeParse(raw)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    return { present: false, reason: `skillGap 格式不合法：${detail}`, markdown: '' }
  }

  const gap = parsed.data.skillGap
  if (gap === undefined) {
    return { present: false, reason: '未回報技能缺口', markdown: '' }
  }
  return { present: true, reason: null, markdown: renderSkillGapMarkdown(gap) }
}

export function main(argv: string[]): SkillGapOutput {
  const args = parseArgs(argv)
  const result = extractSkillGap(args.reportPath)

  if (args.outPath !== undefined) {
    // 無缺口時仍寫出**空檔**：workflow 以 `[ -s <file> ]` 判斷是否附加段落，
    // 留下上一次 run 的殘檔會讓守衛貼出別人的缺口——空檔是唯一安全的預設。
    mkdirSync(dirname(args.outPath), { recursive: true })
    writeFileSync(args.outPath, result.markdown)
  }
  return result
}

/* v8 ignore start -- 副作用區塊：僅在子行程直接執行時進入 */
if (isMainModule(process.argv[1], import.meta.filename)) {
  // 恆 exit 0（見檔首）：runCli 的非 0 回傳在此刻意丟棄，失敗已由 stderr 表達。
  runCli(() => main(process.argv.slice(2)))
  process.exitCode = 0
}
/* v8 ignore stop */
