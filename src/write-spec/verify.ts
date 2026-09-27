/**
 * write-spec 的驗證清單（verify.yml）與結果判定（ADR-018 §7、§8、§12）。
 *
 * `verify.yml` 只宣告**要跑什麼**：實例 × 不變量 × 步數 × 逾時 × witness，
 * 以及每個實例常數的 domain_justification（Q21）。**不能宣告預期結果**——schema
 * 拒絕任何未知欄位。每條不變量的結果一律由 CI 計算：
 * - 違反：候選發現（未回放）；回放由後續 fix-bug 的紅燈測試完成（Q31）。
 * - 成立：必須至少在一個實例上有 witness 可達，否則是假綠燈嫌疑（陷阱 C）。
 *   witness 是**情境**（不變量要保護的前提確實發生，例如「所有票都已回來」），
 *   只能定義在 model.qnt（Q34）：若 witness 等於不變量的否定，不變量成立時它必然
 *   不可達，正確的不變量會一律被判為假綠燈。
 * - 逾時：照實記錄。
 * 工單的成敗取決於證據是否完整，不是不變量是否成立。
 *
 * Quint 輸出格式取自 0.32.0 實測：`[ok] No violation found`（exit 0）、
 * `[violation] Found an issue`（exit 1，run 與 verify 相同）、
 * `WIT_x was witnessed in N trace(s) out of M explored (P%)`。
 */
import { load } from 'js-yaml'
import { z } from 'zod'
import type { SpecFinding } from './scope.js'

/** 全部檢查的逾時總和上限：agent 已用掉大部分 job 時間，驗證須在剩餘時間內完成。 */
export const MAX_TOTAL_TIMEOUT_SECONDS = 1800

const ConstantSchema = z
  .object({ value: z.string(), domain_justification: z.string().trim().min(1) })
  .strict()
const InstanceSchema = z
  .object({ module: z.string().regex(/^\w+$/), constants: z.record(z.string(), ConstantSchema).default({}) })
  .strict()
const CheckSchema = z
  .object({
    instance: z.string(),
    invariant: z.string(),
    mode: z.enum(['run', 'verify']).default('run'),
    max_steps: z.number().int().positive(),
    max_samples: z.number().int().positive().default(10000),
    timeout_seconds: z.number().int().positive(),
    witnesses: z.array(z.string()).min(1),
  })
  .strict()
const VerifyConfigSchema = z
  .object({ instances: z.array(InstanceSchema).min(1), checks: z.array(CheckSchema).min(1) })
  .strict()

export type VerifyConfig = z.infer<typeof VerifyConfigSchema>
export type VerifyCheck = VerifyConfig['checks'][number]

/** 依前綴取 `val` 名稱（出現順序）。 */
export function extractValNames(text: string, prefix: string): string[] {
  return [...text.matchAll(/^\s*(?:pure\s+)?val\s+(\w+)/gm)]
    .map((m) => m[1] as string)
    .filter((n) => n.startsWith(prefix))
}

/**
 * 不變量階段：每個 `INV_*` 正上方的連續註解區塊裡必須有 `// source:` 引用。
 * 內容是否逐字對應 source.md 由人審查；這裡只確保引用不會整個被省略。
 */
export function checkInvariantSources(text: string): string[] {
  const lines = text.split('\n')
  const errors: string[] = []
  let found = 0
  lines.forEach((line, i) => {
    const m = line.match(/^\s*(?:pure\s+)?val\s+(INV_\w+)/)
    if (m === null) return
    found++
    let hasSource = false
    for (let j = i - 1; j >= 0 && (lines[j] as string).trim().startsWith('//'); j--) {
      if ((lines[j] as string).trim().startsWith('// source:')) hasSource = true
    }
    if (!hasSource) errors.push(`\`${m[1]}\` 上方沒有 \`// source:\` 引用註解`)
  })
  return found === 0 ? ['`invariants.qnt` 沒有任何 `val INV_*`'] : errors
}

/** 從 `import <mod>(` 之後掃到配對的右括號，回傳括號內文字。 */
function balancedArgs(text: string, open: number): string {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i)
  }
  return text.slice(open + 1)
}

/** 以最外層逗號切分參數，取 `名稱 = 值` 的名稱。 */
function topLevelNames(args: string): string[] {
  const names: string[] = []
  let depth = 0
  let start = 0
  const take = (part: string): void => {
    const m = part.match(/^\s*(\w+)\s*=/)
    if (m !== null) names.push(m[1] as string)
  }
  for (let i = 0; i < args.length; i++) {
    const c = args[i]
    if (c === '(' || c === '{' || c === '[') depth++
    else if (c === ')' || c === '}' || c === ']') depth--
    else if (c === ',' && depth === 0) {
      take(args.slice(start, i))
      start = i + 1
    }
  }
  take(args.slice(start))
  return names
}

/** instances.qnt 中每個模組 `import model(...)` 實例化時指定的常數名稱。 */
export function extractInstanceConstants(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  const heads = [...text.matchAll(/module\s+(\w+)\s*\{/g)]
  heads.forEach((h, idx) => {
    const start = (h.index as number) + h[0].length
    const end = heads[idx + 1]?.index ?? text.length
    const body = text.slice(start, end)
    const imp = body.match(/import\s+\w+\s*\(/)
    out[h[1] as string] =
      imp === null ? [] : topLevelNames(balancedArgs(body, (imp.index as number) + imp[0].length - 1))
  })
  return out
}

export interface VerifyContext {
  invariantsText: string
  modelText: string
  instancesText: string
}

export function parseVerifyConfig(
  yamlText: string,
  ctx: VerifyContext,
): { config?: VerifyConfig | undefined; errors: string[] } {
  let raw: unknown
  try {
    raw = load(yamlText)
  } catch (err) {
    return { errors: [`verify.yml 不是合法 YAML：${(err as Error).message.split('\n')[0]}`] }
  }
  const parsed = VerifyConfigSchema.safeParse(raw)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    return { errors: [`verify.yml 不符 schema（不得宣告預期結果等未知欄位）：${detail}`] }
  }
  const config = parsed.data
  const errors: string[] = []

  const declared = new Set<string>()
  const instanceConstants = extractInstanceConstants(ctx.instancesText)
  for (const inst of config.instances) {
    if (declared.has(inst.module)) errors.push(`實例名稱重複：\`${inst.module}\``)
    declared.add(inst.module)
    const constants = instanceConstants[inst.module]
    if (constants === undefined) {
      errors.push(`實例 \`${inst.module}\` 不存在於 instances.qnt`)
      continue
    }
    for (const c of constants) {
      if (inst.constants[c] === undefined) {
        errors.push(`實例 \`${inst.module}\` 的常數 \`${c}\` 缺 domain_justification（Q21：設定範圍須以程式實際接受的輸入為準）`)
      }
    }
  }

  const invariants = extractValNames(ctx.invariantsText, 'INV_')
  const modelWitnesses = new Set(extractValNames(ctx.modelText, 'WIT_'))
  const invariantVals = new Set(extractValNames(ctx.invariantsText, ''))
  for (const check of config.checks) {
    if (!declared.has(check.instance)) errors.push(`檢查引用未宣告的實例：\`${check.instance}\``)
    if (!invariants.includes(check.invariant)) {
      errors.push(`檢查引用不存在的不變量：\`${check.invariant}\`（必須是 invariants.qnt 的 INV_*）`)
    }
    for (const w of check.witnesses) {
      if (modelWitnesses.has(w)) continue
      errors.push(
        invariantVals.has(w)
          ? `witness \`${w}\` 定義在 invariants.qnt——情境 witness 必須由模型階段定義在 model.qnt（Q34）：` +
              '不變量階段的 WIT_* 描述的是違反本身，不變量成立時必然不可達，會把正確的不變量誤判為假綠燈'
          : `witness \`${w}\` 不存在於 model.qnt（必須是 model.qnt 的 \`val WIT_*\`，Q34）`,
      )
    }
  }
  for (const inv of invariants) {
    if (!config.checks.some((c) => c.invariant === inv)) errors.push(`\`${inv}\` 沒有任何檢查涵蓋`)
  }
  const total = config.checks.reduce((sum, c) => sum + c.timeout_seconds, 0)
  if (total > MAX_TOTAL_TIMEOUT_SECONDS) {
    errors.push(`逾時總和 ${total}s 超過上限 ${MAX_TOTAL_TIMEOUT_SECONDS}s`)
  }
  return { config, errors }
}

export type CheckStatus = 'holds' | 'violated' | 'timeout' | 'error'

export interface ParsedOutput {
  status: CheckStatus
  witnesses: Record<string, number>
  detail?: string | undefined
}

export interface CheckResult extends ParsedOutput {
  instance: string
  invariant: string
  mode: 'run' | 'verify'
  /** 違反時 CI 保留的反例 ITF（repo 內路徑）。 */
  trace?: string | undefined
}

export function parseQuintOutput(exitCode: number | null, output: string, timedOut: boolean): ParsedOutput {
  if (timedOut) return { status: 'timeout', witnesses: {} }
  if (output.includes('[violation]')) return { status: 'violated', witnesses: {} }
  if (exitCode === 0 && output.includes('[ok]')) {
    const witnesses: Record<string, number> = {}
    for (const m of output.matchAll(/^(\w+) was witnessed in (\d+) trace/gm)) {
      witnesses[m[1] as string] = Number(m[2])
    }
    return { status: 'holds', witnesses }
  }
  const tail = output.split('\n').filter((l) => l.trim() !== '').slice(-5).join('\n')
  return { status: 'error', witnesses: {}, detail: tail }
}

export type InvariantStatus = 'holds' | 'violated' | 'vacuous' | 'timeout' | 'error'

export interface InvariantResult {
  invariant: string
  status: InvariantStatus
  traces: string[]
}

/** 每條不變量彙總所有實例：違反 > 錯誤 > 逾時 > 成立（至少一個 witness 可達）／假綠燈。 */
export function aggregateByInvariant(results: readonly CheckResult[]): InvariantResult[] {
  const order: string[] = []
  for (const r of results) if (!order.includes(r.invariant)) order.push(r.invariant)
  return order.map((invariant) => {
    const rs = results.filter((r) => r.invariant === invariant)
    const violated = rs.filter((r) => r.status === 'violated')
    if (violated.length > 0) {
      return {
        invariant,
        status: 'violated' as const,
        traces: violated.flatMap((r) => (r.trace === undefined ? [] : [r.trace])),
      }
    }
    if (rs.some((r) => r.status === 'error')) return { invariant, status: 'error' as const, traces: [] }
    if (rs.some((r) => r.status === 'timeout')) return { invariant, status: 'timeout' as const, traces: [] }
    const reached = rs.some((r) => Object.values(r.witnesses).some((n) => n > 0))
    return { invariant, status: reached ? ('holds' as const) : ('vacuous' as const), traces: [] }
  })
}

/** 證據判定：錯誤與假綠燈擋下（needs-human）；違反與逾時只記錄。 */
export function judgeEvidence(results: readonly InvariantResult[]): {
  mismatches: SpecFinding[]
  advisories: SpecFinding[]
} {
  const mismatches: SpecFinding[] = []
  const advisories: SpecFinding[] = []
  for (const r of results) {
    if (r.status === 'vacuous') {
      mismatches.push({
        kind: 'write-spec-vacuous',
        detail: `\`${r.invariant}\` 在所有實例都成立，但沒有任何 witness 可達——可能是模型到不了不變量要保護的情境（假綠燈）`,
      })
    } else if (r.status === 'error') {
      mismatches.push({ kind: 'write-spec-check-error', detail: `\`${r.invariant}\` 的檢查執行失敗，詳見 run log` })
    } else if (r.status === 'violated') {
      advisories.push({
        kind: 'write-spec-candidate-finding',
        detail:
          `\`${r.invariant}\` 找到反例——**候選發現（未回放）**：${r.traces.join('、')}。` +
          '請開 agent-fix-bug 工單，由 01-test 的紅燈測試回放到真實程式（Q31）',
      })
    } else if (r.status === 'timeout') {
      advisories.push({ kind: 'write-spec-timeout', detail: `\`${r.invariant}\` 的檢查逾時，結論未知` })
    }
  }
  return { mismatches, advisories }
}
