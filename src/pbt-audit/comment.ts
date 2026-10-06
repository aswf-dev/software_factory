/**
 * agent-pbt-audit 的機制留言（ADR-019 R4、R10）。
 *
 * agent 不開 Issue、不自己留言（Q25）：候選發現寫進 report.json，由機制統一貼到
 * 稽核 Issue。留言也是試行報告的資料來源——Issue 留言永久保存，artifact 90 天過期。
 *
 * 數據分兩段且標示來源，因為兩者的可信度不同：
 * - **機制實測**：牆鐘、diff 裡的 PBT 檔與 property 數——不經 agent 之手。
 * - **agent 自報（未經驗證）**：seeds、案例數、通過／失敗、候選發現。
 *
 * 留言內嵌 `（run: <id>）`：終態守衛（factory-run.yml G1、factory-run-cleanup.yml
 * G2）以「Issue 留言是否含該 run id」判定本 run 是否已留下紀錄。
 */
import { languageForExtension, extensionOf } from './languages.js'
import { parsePbtAudit, type PbtFinding } from './report.js'

export interface PbtMeasured {
  /** agent 步驟的牆鐘（毫秒）；量不到為 undefined。 */
  agentWallClockMs: number | undefined
  /** diff 中新增或修改的 PBT 檔。 */
  pbtFiles: readonly string[]
  /** 各 PBT 檔的 property 數；undefined＝該語言沒有可靠的計數樣式。 */
  propertyCounts: Readonly<Record<string, number | undefined>>
}

/** 每個欄位的長度上限：GitHub 留言上限 65536 字元，十幾條發現就可能撐爆。 */
export const FIELD_MAX = 3000

/**
 * 各語言的 property 宣告樣式。只列有把握的形態；Go、C++、OCaml 的寫法依專案而異，
 * 寧可顯示「未計數」也不要給一個看似精確的錯誤數字。
 */
const PROPERTY_PATTERNS: Partial<Record<string, RegExp>> = {
  typescript: /\bhegel\.test(?:Async)?\s*\(/g,
  java: /@HegelTest\b/g,
  rust: /#\[\s*hegel::test\b/g,
}

export function countProperties(path: string, content: string): number | undefined {
  const lang = languageForExtension(extensionOf(path))
  const re = lang === undefined ? undefined : PROPERTY_PATTERNS[lang.id]
  if (re === undefined) return undefined
  return [...content.matchAll(re)].length
}

function clip(text: string): string {
  return text.length <= FIELD_MAX ? text : `${text.slice(0, FIELD_MAX)}\n…（已截斷，全文見 run artifact 的 report.json）`
}

/** 以比內容中最長反引號串更長的 fence 包住，避免 agent 文字提前關閉程式碼區塊。 */
export function fence(text: string, lang = ''): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const f = '`'.repeat(Math.max(3, longest + 1))
  return `${f}${lang}\n${clip(text)}\n${f}`
}

/** 單行欄位：去掉換行與反引號，避免破壞 markdown 結構。 */
function inline(text: string): string {
  return clip(text).replace(/[\r\n]+/g, ' ').replace(/`/g, "'")
}

function formatMs(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`
}

function renderFinding(f: PbtFinding, i: number): string {
  const lines = [
    `<details><summary>候選發現 ${i + 1}（未回放）：${inline(f.property)}</summary>`,
    '',
    `- **依據**：\`${inline(f.source)}\``,
    `- **重現**：\`HEGEL_SEED=${inline(String(f.seed))}\`，Hegel \`${inline(f.hegelVersion)}\``,
    '',
    '**縮減後的 draws**',
    '',
    fence(f.draws),
    '',
    '**固定輸入的紅燈測試**（貼上即可在本地重現）',
    '',
    fence(f.reproTest),
  ]
  if (f.propertyToRestore !== undefined && f.propertyToRestore.trim() !== '') {
    lines.push('', '**修正後要加回的 property**', '', fence(f.propertyToRestore))
  }
  lines.push('', '</details>')
  return lines.join('\n')
}

export function buildPbtAuditComment(rawPbtAudit: unknown, measured: PbtMeasured, runId: string): string {
  const out: string[] = [`## 🔬 PBT 稽核摘要（run: ${runId}）`, '']

  const counted = measured.pbtFiles.map((p) => measured.propertyCounts[p])
  const totalProps = counted.every((c) => c !== undefined)
    ? String(counted.reduce<number>((a, c) => a + (c as number), 0))
    : '部分語言未計數'
  out.push(
    '### 機制實測',
    '',
    `- agent 牆鐘：${measured.agentWallClockMs === undefined ? '量不到' : formatMs(measured.agentWallClockMs)}`,
    `- 新增或修改的 PBT 檔：${measured.pbtFiles.length} 個`,
    `- property 數：${measured.pbtFiles.length === 0 ? '0' : totalProps}`,
  )
  for (const p of measured.pbtFiles) {
    const c = measured.propertyCounts[p]
    out.push(`  - \`${p}\`：${c === undefined ? '未計數' : `${c} 個 property`}`)
  }
  out.push('')

  const parsed = parsePbtAudit(rawPbtAudit)
  out.push('### agent 自報（未經驗證）', '')
  if (parsed.status === 'absent') {
    out.push('report.json 沒有 `pbtAudit` 欄位——本次沒有自報的稽核數據與候選發現。')
  } else if (parsed.status === 'invalid') {
    out.push(`report.json 的 \`pbtAudit\` 格式不符，未採用：${inline(parsed.detail)}`)
    out.push('', '原文見 run artifact 的 `report.json`。')
  } else {
    const v = parsed.value
    const n = (x: number | undefined): string => (x === undefined ? '未回報' : String(x))
    out.push(
      `- seeds：${v.seeds === undefined ? '未回報' : `${v.seeds.length} 個`}；每 seed 案例數：${n(v.testCasesPerSeed)}`,
      `- property：${n(v.properties)}（通過 ${n(v.passed)}、失敗 ${n(v.failed)}、逾時 ${n(v.timeouts)}）`,
    )
    const findings = v.findings ?? []
    out.push('', `### 候選發現（未回放）：${findings.length} 條`, '')
    if (findings.length === 0) {
      out.push('無。')
    } else {
      const hasRestore = findings.some((f) => f.propertyToRestore !== undefined && f.propertyToRestore.trim() !== '')
      out.push(
        '這些是 agent 執行 property 得到的反例，**尚未經人類確認**。確認是真實缺陷後，' +
          '請另開 `agent-fix-bug` 工作項，由它的 `-01-test` 層把紅燈測試寫進 repo（ADR-019 §5）。' +
          (hasRestore
            ? '「修正後要加回的 property」**不要放進 `agent-fix-bug` 工單**（fix-bug 不得變更 PBT 檔，' +
              'crosscheck 會判 `pbt-outside-audit`）：修正合併後另開 `agent-pbt-audit`，以該 property 為驗收條件加回（docs/30 §7）。'
            : ''),
        '',
        ...findings.map((f, i) => renderFinding(f, i)),
      )
    }
  }
  out.push(
    '',
    '---',
    '_audit PR 只放通過的 property，一律交人類審查、不自動合併（ADR-019 §5）。' +
      '審查時請對照 `hegel-review` 的 12 點與每個 property 的 `// source:` 依據。_',
  )
  return out.join('\n')
}
