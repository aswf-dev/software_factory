/**
 * factory-nversion-pr：N-version 雙模型競賽的 PR 識別（標題正規化＋互指區塊）。
 *
 * 背景（fubon-tradingbot#721，run 38111896579）：兩個變體的 PR 標題完全由 agent
 * 自由發揮——同一份指引下，opus-5-5 寫了「（變體 a）」，qwen3.8-max 完全沒標變體；
 * 從 PR 列表看不出 #722／#723 是同一張工單的兩份平行交付，單開其中一個也看不到
 * 另一個的存在，審查者可能只看一份就合併。分支前綴是機制強制的
 * （`factory/<issue>-<variant>-<nn>-<layer>`），標題卻沒有任何規則。
 *
 * 修法：不靠 prompt（不同模型對同一指引的遵從度不同，#721 即反例），由 workflow
 * 以本 CLI 決定：
 *   - `title`：run job 在 agent 之後把本變體前綴的 open PR 標題改成
 *     `[factory][<issue>][<variant>][<nn>-<layer>] <工單標題>`；
 *   - `body`：compare job 在兩個變體都結束後，於每個 PR 內文頂端插入（或更新）
 *     指向另一變體 PR 的區塊，以 HTML 註解標記界定，重跑時原地取代、不重複疊加。
 *
 * 純函式＋薄 main；gh 呼叫留在 workflow（本 CLI 不碰網路，可完整單元測試）。
 */
import { readFileSync } from 'node:fs'
import { CliError, runCli } from './run-cli.js'
import { isMainModule } from './is-main-module.js'

export type Variant = 'a' | 'b'

export const SIBLING_BLOCK_START = '<!-- factory:nversion-sibling -->'
export const SIBLING_BLOCK_END = '<!-- /factory:nversion-sibling -->'

/** 去掉工單標題開頭的 `[factory]` 標記（可重複、大小寫不拘），只留主旨。 */
export function stripFactoryTag(issueTitle: string): string {
  return issueTitle.replace(/^(\s*\[factory\]\s*)+/i, '').trim()
}

/**
 * 從分支名取出層級標記：`factory/<n>-<v>-<nn>-<layer>` → `<nn>-<layer>`。
 * stacked PR 的各層因此標題可區分；分支不符格式時回 undefined（標題就不帶層級）。
 */
export function layerTag(branch: string, issueNumber: number, variant: Variant): string | undefined {
  const prefix = `factory/${issueNumber}-${variant}-`
  if (!branch.startsWith(prefix)) return undefined
  const rest = branch.slice(prefix.length)
  return /^\d{2}-[A-Za-z0-9._-]+$/.test(rest) ? rest : undefined
}

export function normalizedTitle(input: {
  issueNumber: number
  variant: Variant
  issueTitle: string
  branch: string
}): string {
  const { issueNumber, variant, issueTitle, branch } = input
  const layer = layerTag(branch, issueNumber, variant)
  const subject = stripFactoryTag(issueTitle)
  const tags = `[factory][${issueNumber}][${variant}]${layer === undefined ? '' : `[${layer}]`}`
  return `${tags} ${subject.length > 0 ? subject : `#${issueNumber}`}`
}

export function siblingBlock(input: {
  issueNumber: number
  variant: Variant
  siblingPrs: readonly number[]
}): string {
  const { issueNumber, variant, siblingPrs } = input
  const other: Variant = variant === 'a' ? 'b' : 'a'
  const head = `> ⚔️ **N-version 候選｜變體 ${variant}**：工單 #${issueNumber} 由兩個模型平行交付。`
  const tail =
    siblingPrs.length > 0
      ? `另一變體（${other}）的交付：${siblingPrs.map((n) => `#${n}`).join('、')}——請一併比對（比對卡片見 #${issueNumber} 留言）；勝者合併、敗者關閉。`
      : `另一變體（${other}）未產生 PR，無可比對的交付。`
  return `${SIBLING_BLOCK_START}\n${head}${tail}\n${SIBLING_BLOCK_END}`
}

/** 有既有區塊就原地取代（重跑不疊加），否則插在內文最上方（打開 PR 第一眼就看到）。 */
export function upsertSiblingBlock(body: string, block: string): string {
  const start = body.indexOf(SIBLING_BLOCK_START)
  const end = body.indexOf(SIBLING_BLOCK_END)
  if (start !== -1 && end > start) {
    return body.slice(0, start) + block + body.slice(end + SIBLING_BLOCK_END.length)
  }
  const rest = body.trim()
  return rest.length > 0 ? `${block}\n\n${rest}` : block
}

type Parsed =
  | { command: 'title'; issueNumber: number; variant: Variant; issueTitle: string; branch: string }
  | { command: 'body'; issueNumber: number; variant: Variant; siblingPrs: number[]; bodyFile: string }

const FLAGS: Record<'title' | 'body', readonly string[]> = {
  title: ['--issue-number', '--variant', '--issue-title', '--branch'],
  body: ['--issue-number', '--variant', '--sibling-prs', '--body-file'],
}

function positiveInt(raw: string, what: string): number {
  if (!/^[1-9]\d*$/.test(raw)) throw new CliError(`${what} 必須是正整數，實得：${raw}`)
  return Number(raw)
}

export function parseArgs(argv: string[]): Parsed {
  const [command, ...rest] = argv
  if (command !== 'title' && command !== 'body') {
    throw new CliError(`第一個參數必須是 title 或 body，實得：${command ?? '（空）'}`)
  }
  const allowed = FLAGS[command]
  const values = new Map<string, string>()
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i] as string
    const value = rest[i + 1]
    if (!allowed.includes(flag)) throw new CliError(`${command} 不認得參數：${flag}`)
    // --sibling-prs 允許空字串（另一變體沒有 PR），其餘必填非空
    if (value === undefined || value.startsWith('--')) throw new CliError(`${flag} 需要一個值`)
    values.set(flag, value)
  }
  for (const flag of allowed) {
    if (!values.has(flag)) throw new CliError(`缺少必填參數 ${flag}`)
  }
  const get = (flag: string): string => values.get(flag) as string
  const issueNumber = positiveInt(get('--issue-number'), '--issue-number')
  const variant = get('--variant')
  if (variant !== 'a' && variant !== 'b') throw new CliError(`--variant 必須是 a 或 b，實得：${variant}`)
  if (command === 'title') {
    return { command, issueNumber, variant, issueTitle: get('--issue-title'), branch: get('--branch') }
  }
  const siblingPrs = get('--sibling-prs')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => positiveInt(s, '--sibling-prs'))
  return { command, issueNumber, variant, siblingPrs, bodyFile: get('--body-file') }
}

export function main(argv: string[]): { title: string } | { body: string } {
  const args = parseArgs(argv)
  if (args.command === 'title') return { title: normalizedTitle(args) }
  const block = siblingBlock(args)
  return { body: upsertSiblingBlock(readFileSync(args.bodyFile, 'utf8'), block) }
}

/* v8 ignore start */
if (isMainModule(process.argv[1], import.meta.filename)) {
  process.exitCode = runCli(() => main(process.argv.slice(2)))
}
/* v8 ignore stop */
