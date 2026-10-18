/**
 * 流程模板與 process spec 的 schema 與驗證（ADR-023；docs/29 §9）。
 *
 * **為什麼需要這個模組**：`docs/29` §9.1–9.3 的步驟序列只存在文件裡（Mermaid ＋表格），
 * 機器讀不到。UI 若要「選 S/M/L 模板 → 架構師調整 → 存檔」，模板必須先是資料。
 *
 * **「可加不可刪、不可重排」怎麼落地**：`process.yaml` **不重述**模板步驟，只宣告
 * `template: <tenant>/<name>` ＋ `template_version` 與 `extra_steps`。因此「刪掉一個必要步驟」
 * 或「調換順序」在結構上就不可能發生——不是靠驗證器擋，而是根本沒有那個欄位。驗證器只檢查：
 *   1. `template` id 與載入的模板一致、`template_version` 相同（ADR-025 釘版本）；
 *   2. `phases` 是模板 phases 的**連續前綴**（可以停在 P4，不能跳過 P2）；
 *   3. 模板的 gates 一個都不能少（可以加）；
 *   4. `extra_steps` 的 id 不與模板衝突，且 phase 必須在已宣告的 phases 內。
 *
 * `scale` 與模板**脫鉤**（ADR-025 §4）：scale 是人類宣告的治理強度，不再等於模板名。
 *
 * 規模與就緒度**不在此模組推導**：`scale` 是人的裁定，必須附 evidence（ADR-023 §2）。
 */
import { load } from 'js-yaml'
import { z } from 'zod'
import { HG_IDS } from '../hg/parse.js'

export const PHASES = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5'] as const
export type Phase = (typeof PHASES)[number]

export const TEMPLATE_NAMES = ['S', 'M', 'L'] as const
export type TemplateName = (typeof TEMPLATE_NAMES)[number]

export const STEP_KINDS = ['human', 'work-item'] as const
export type StepKind = (typeof STEP_KINDS)[number]

/** 份數單位：一張單代表什麼（docs/29 §9 表格的「× N」依據）。 */
export const STEP_UNITS = ['system', 'repo', 'module', 'defect', 'item'] as const
export type StepUnit = (typeof STEP_UNITS)[number]

/** 自訂 gate：`<TENANT-UPPER>-<NAME>`；`HG0`–`HG7` 保留（ADR-025 §3）。 */
export const GATE_ID_PATTERN = /^(?:HG[0-7]|[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)$/
const GateIdSchema = z.string().regex(GATE_ID_PATTERN, 'gate id 必須是 HG0–HG7 或 <TENANT>-<NAME>')
const PhaseSchema = z.enum(PHASES)
const TenantSchema = z.string().regex(/^[a-z][a-z0-9-]*$/, '租戶只允許小寫英數與連字號')
/** 模板名稱允許大寫（工廠 preset 是 `factory/S`、`factory/M`、`factory/L`）。 */
const NameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9-]*$/, '模板名稱只允許英數與連字號')
/** `<tenant>/<name>`（ADR-025）。 */
export const TEMPLATE_ID_PATTERN = /^[a-z][a-z0-9-]*\/[A-Za-z][A-Za-z0-9-]*$/
const TemplateIdSchema = z.string().regex(TEMPLATE_ID_PATTERN, 'template 必須是 <tenant>/<name>')

/** 工廠既有的 task_type（與 ISSUE_TEMPLATE 下拉一致；agent-onboard 走另一張表單）。 */
export const FACTORY_TASK_TYPES = [
  'agent-add-tests',
  'agent-fix-bug',
  'agent-update-deps',
  'agent-write-docs',
  'agent-write-spec',
  'agent-analyze',
  'agent-propose-skill',
  'agent-pbt-audit',
  'agent-onboard',
] as const

/** meta-contract：任何模板都不得移除的工廠閘門（ADR-025 §3）。 */
export const MANDATORY_GATES = ['HG1', 'HG2', 'HG4', 'HG5', 'HG6'] as const

const AlternativeSchema = z.object({
  kind: z.enum(STEP_KINDS),
  action: z.string().min(1).optional(),
  task_type: z.string().min(1).optional(),
})

export const StepSchema = z.object({
  id: z.string().min(1),
  phase: PhaseSchema,
  action: z.string().min(1),
  kind: z.enum(STEP_KINDS),
  task_type: z.string().min(1).optional(),
  alternatives: z.array(AlternativeSchema).min(1).optional(),
  per: z.enum(STEP_UNITS).optional(),
  /** 只在某條件成立時適用（例：只對 in-loop repo、只在揭露缺陷時）。 */
  conditional: z.boolean().optional(),
  /** false＝可省略（例：P4 的維護步驟）。預設為 true。 */
  required: z.boolean().optional(),
  gates: z.array(GateIdSchema).optional(),
})

export const TemplateSchema = z.object({
  /** 租戶 slug（ADR-025）；工廠 preset 為 `factory`。 */
  tenant: TenantSchema,
  /** 模板 slug；id 為 `<tenant>/<name>`。 */
  name: NameSchema,
  /** 發布後不可變：改流程＝新版。 */
  version: z.number().int().positive(),
  source: z.string().min(1),
  phases: z.array(PhaseSchema).min(1),
  gates: z.array(GateIdSchema),
  steps: z.array(StepSchema).min(1),
})

export const ProcessSpecSchema = z.object({
  system: z.string().min(1),
  scale: z.enum(TEMPLATE_NAMES),
  scale_evidence: z.string().min(1),
  /** `<tenant>/<name>`，系統釘選的模板（ADR-025）。 */
  template: TemplateIdSchema,
  /** 釘選的模板版本；與載入的模板檔案必須相同。 */
  template_version: z.number().int().positive(),
  phases: z.array(PhaseSchema).min(1),
  gates: z.array(GateIdSchema),
  extra_steps: z.array(StepSchema).optional(),
})

export const READINESS_LEVELS = ['R0', 'R1', 'R2'] as const
export type Readiness = (typeof READINESS_LEVELS)[number]

/**
 * 目標 repo 的 `factory/process.yaml`（模組級，ADR-023 附錄 A.2）。
 *
 * 模組是**變更治理單位**：識別碼 `<system>/<module-id>`，`paths` 是就緒度與覆蓋率的
 * 機械歸屬。`readiness` 只能由人填並附 `readiness_evidence`——本模組不推導它。
 */
export const ModuleEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'module id 只允許小寫英數與連字號'),
  paths: z.array(z.string().min(1)).min(1),
  build_unit: z.string().min(1).optional(),
  spec: z.string().min(1).optional(),
  readiness: z.enum(READINESS_LEVELS).optional(),
  readiness_evidence: z.string().min(1).optional(),
  owner: z.string().min(1).optional(),
})

export const ModuleSpecSchema = z.object({
  system: z.string().min(1),
  modules: z.array(ModuleEntrySchema).min(1),
})

export type ModuleEntry = z.infer<typeof ModuleEntrySchema>
export type ModuleSpec = z.infer<typeof ModuleSpecSchema>

/** 解析 `factory/process.yaml`；`readiness` 未附 evidence 視為錯誤（ADR-023 附錄 A.3）。 */
export function loadModuleSpec(text: string): ValidationResult & { modules?: ModuleSpec } {
  let raw: unknown
  try {
    raw = load(text)
  } catch {
    return { ok: false, errors: ['YAML 無法解析'] }
  }
  const parsed = ModuleSpecSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, errors: schemaErrors(parsed.error.issues) }
  const errors: string[] = []
  const seen = new Set<string>()
  for (const module of parsed.data.modules) {
    if (seen.has(module.id)) errors.push(`modules.${module.id}: id 重複`)
    seen.add(module.id)
    if (module.readiness !== undefined && module.readiness_evidence === undefined) {
      errors.push(`modules.${module.id}: readiness 必須附 readiness_evidence`)
    }
  }
  return errors.length === 0
    ? { ok: true, errors: [], modules: parsed.data }
    : { ok: false, errors }
}

export type Step = z.infer<typeof StepSchema>
export type Template = z.infer<typeof TemplateSchema>
export type ProcessSpec = z.infer<typeof ProcessSpecSchema>

export interface ValidationResult {
  ok: boolean
  errors: string[]
}

function schemaErrors(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string[] {
  return issues.map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`)
}

/** 單一模板（或步驟陣列）的內部一致性：id 唯一、human 不得帶 task_type、work-item 必須有任務類型。 */
export function validateSteps(steps: readonly Step[], prefix = ''): ValidationResult {
  const errors: string[] = []
  const seen = new Set<string>()
  for (const step of steps) {
    const at = `${prefix}${step.id}`
    if (seen.has(step.id)) errors.push(`${at}: 步驟 id 重複`)
    seen.add(step.id)

    if (step.kind === 'human') {
      if (step.task_type !== undefined) errors.push(`${at}: human 步驟不得帶 task_type`)
      continue
    }
    if (step.task_type === undefined && step.alternatives === undefined) {
      errors.push(`${at}: work-item 步驟必須有 task_type 或 alternatives`)
    }
    if (step.task_type !== undefined && step.alternatives !== undefined) {
      errors.push(`${at}: task_type 與 alternatives 只能擇一`)
    }
    for (const alt of step.alternatives ?? []) {
      if (alt.kind === 'work-item' && alt.task_type === undefined) {
        errors.push(`${at}: work-item 的替代方案缺少 task_type`)
      }
      if (alt.kind === 'human' && alt.task_type !== undefined) {
        errors.push(`${at}: human 的替代方案不得帶 task_type`)
      }
    }
  }
  return { ok: errors.length === 0, errors }
}

export function validateTemplate(input: unknown): ValidationResult & { template?: Template } {
  const parsed = TemplateSchema.safeParse(input)
  if (!parsed.success) return { ok: false, errors: schemaErrors(parsed.error.issues) }

  const errors: string[] = []
  let previous = -1
  for (const phase of parsed.data.phases) {
    const index = PHASES.indexOf(phase)
    if (index <= previous) errors.push(`phases: ${phase} 的順序不正確`)
    previous = index
  }
  const stepResult = validateSteps(parsed.data.steps)
  errors.push(...stepResult.errors)

  // meta-contract（ADR-025 §3）：task_type 白名單、必含工廠閘門、自訂 gate 的租戶前綴。
  const knownTaskTypes = new Set<string>(FACTORY_TASK_TYPES)
  const tenantPrefix = `${parsed.data.tenant.toUpperCase()}-`
  for (const step of parsed.data.steps) {
    if (step.task_type !== undefined && !knownTaskTypes.has(step.task_type)) {
      errors.push(`${step.id}: 未知的 task_type ${step.task_type}`)
    }
    for (const alt of step.alternatives ?? []) {
      if (alt.task_type !== undefined && !knownTaskTypes.has(alt.task_type)) {
        errors.push(`${step.id}: 未知的 task_type ${alt.task_type}`)
      }
    }
  }
  for (const gate of MANDATORY_GATES) {
    if (!parsed.data.gates.includes(gate)) errors.push(`gates: 工廠必含 ${gate} 不得移除`)
  }
  for (const gate of parsed.data.gates) {
    if (/^HG[0-7]$/.test(gate)) continue
    if (!gate.startsWith(tenantPrefix)) {
      errors.push(`gates: 自訂 gate ${gate} 必須以 ${tenantPrefix} 開頭`)
    }
  }

  return { ok: errors.length === 0, errors, template: parsed.data }
}

/**
 * 驗證 `process.yaml` 是否忠於它宣告的模板。
 *
 * `process` 只需宣告 template／phases／gates／extra_steps；模板步驟不會被重述，
 * 所以「刪除」與「重排」在結構上不可能。
 */
export function validateProcess(input: unknown, template: Template): ValidationResult {
  const parsed = ProcessSpecSchema.safeParse(input)
  if (!parsed.success) return { ok: false, errors: schemaErrors(parsed.error.issues) }
  const process = parsed.data
  const errors: string[] = []

  const expectedId = `${template.tenant}/${template.name}`
  if (process.template !== expectedId) {
    errors.push(`template: process 宣告 ${process.template}，但比對的模板是 ${expectedId}`)
  }
  if (process.template_version !== template.version) {
    errors.push(
      `template_version: process 釘 ${process.template_version}，但載入的模板是 ${template.version}`,
    )
  }

  const prefix = template.phases.slice(0, process.phases.length)
  if (process.phases.length > template.phases.length || prefix.join(',') !== process.phases.join(',')) {
    errors.push(`phases: 必須是模板 phases 的連續前綴（${template.phases.join('>')}），收到 ${process.phases.join('>')}`)
  }
  for (const phase of process.phases) {
    if (!template.phases.includes(phase)) errors.push(`phases: 模板未定義 ${phase}`)
  }

  const missingGates = template.gates.filter((gate) => !process.gates.includes(gate))
  for (const gate of missingGates) errors.push(`gates: 模板的 ${gate} 不得移除`)

  const templateIds = new Set(template.steps.map((step) => step.id))
  const extraSteps = process.extra_steps ?? []
  for (const step of extraSteps) {
    if (templateIds.has(step.id)) errors.push(`extra_steps: ${step.id} 與模板步驟 id 衝突`)
    if (!process.phases.includes(step.phase)) {
      errors.push(`extra_steps: ${step.id} 的階段 ${step.phase} 不在已宣告的 phases 內`)
    }
  }
  const extraResult = validateSteps(extraSteps, 'extra_steps.')
  errors.push(...extraResult.errors)

  return { ok: errors.length === 0, errors }
}

/** 解析並驗證模板 YAML；同時做內部一致性檢查。 */
export function loadTemplate(text: string): ValidationResult & { template?: Template } {
  let raw: unknown
  try {
    raw = load(text)
  } catch {
    return { ok: false, errors: ['YAML 無法解析'] }
  }
  return validateTemplate(raw)
}

/** 解析 process.yaml（不做模板比對，比對請呼叫 `validateProcess`）。 */
export function loadProcessSpec(text: string): ValidationResult & { process?: ProcessSpec } {
  let raw: unknown
  try {
    raw = load(text)
  } catch {
    return { ok: false, errors: ['YAML 無法解析'] }
  }
  const parsed = ProcessSpecSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, errors: schemaErrors(parsed.error.issues) }
  return { ok: true, errors: [], process: parsed.data }
}

/** 模板的「必要步驟」——驗證與 UI 都用它決定哪些不可略過。 */
export function requiredSteps(template: Template): Step[] {
  return template.steps.filter((step) => step.required !== false)
}
