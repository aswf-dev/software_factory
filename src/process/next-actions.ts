/**
 * 待開工作項清單（ADR-024「執行」語意）。
 *
 * **不是派工器**：本模組只算出「下一步該開哪些單」，不建立 Issue、不貼 label、不觸發
 * workflow（ADR-024 §1、§2）。人按下送出之後才走既有的 Backstage 表單／issue form。
 *
 * 規則刻意保守，且每一條偏誤都往「少開一張」而不是「多開一張」：
 *   - **依模板順序**逐模組推進，遇到第一個「未完成且未被閘門擋住」的步驟就停（每模組最多一個建議）；
 *   - **conditional 步驟不自動建議**（例：只在揭露缺陷時才開的 fix-bug）——那需要人判斷，
 *     自動建議會製造噪音，且會掩蓋真正該做的下一步；
 *   - **已存在進行中的同類工單**時不重複建議（冪等鍵附近的行為，ADR-024 §5）；
 *   - **閘門未簽**時建議的是「簽核」，不是下一張工單——因為下一步本來就過不去。
 *
 * 系統層步驟（`per: system|repo`）：P2–P4 仍逐模組推進（模組建議互不阻塞），但系統層的
 * **work-item** 步驟（P0／P1 的分析、規格等）會產生「一次一筆」的建議（2026-10-19）——
 * 沒有這筆建議，P0／P1 的 agent 工單只能靠 warning 人工開，清單永遠不完整。
 * 系統層人類步驟（P0／P1／P5）不開工單，閘門未簽時建議簽核；其餘未完成者仍以 warning 呈現。
 *
 * 完成／進行中判定（2026-10-19）：一旦 repo 有任何工單帶 `step_id`（ADR-023 §5 provenance），
 * 就以 `step_id` 為準，不再用 task_type 跨步驟比對——否則舊的同類型工單會讓新模板的步驟
 * 「假完成」。完全沒有 provenance 的舊 repo 仍維持 task_type fallback（遷移期相容）。
 */
import { z } from 'zod'
import { extractField } from '../cli/factory-issue-check.js'
import { moduleOfIssue, parseStepId } from '../graph/build.js'
import type { IssueInput } from '../graph/build.js'
import type { GateStatus } from '../hg/parse.js'
import type { ModuleEntry, ProcessSpec, Step, Template } from './spec.js'

export const STAGE_DONE_LABEL = 'stage/done'

export interface NextActionsInput {
  system: string
  template: Template
  process: ProcessSpec
  modules: readonly ModuleEntry[]
  issues: readonly IssueInput[]
  gates: readonly GateStatus[]
  generatedAt: string
}

export interface WorkItemAction {
  kind: 'work-item'
  /** 模組層＝`<system>/<module-id>`；系統層＝`<system>`（2026-10-19 起系統層也會建議）。 */
  scope: string
  template_step: string
  task_type: string
  task_types: string[]
  reason: string
}

export interface GateAction {
  kind: 'gate'
  scope: string
  gate: string
  template_step: string
  reason: string
}

export type NextAction = WorkItemAction | GateAction

const WorkItemActionSchema = z.object({
  kind: z.literal('work-item'),
  scope: z.string().min(1),
  template_step: z.string().min(1),
  task_type: z.string().min(1),
  task_types: z.array(z.string().min(1)),
  reason: z.string().min(1),
})

const GateActionSchema = z.object({
  kind: z.literal('gate'),
  scope: z.string().min(1),
  gate: z.string().min(1),
  template_step: z.string().min(1),
  reason: z.string().min(1),
})

/** 輸出契約（factory-snapshot 會把它崁進快照，consumer 可直接驗證）。 */
export const NextActionsSchema = z.object({
  system: z.string().min(1),
  generated_at: z.string().min(1),
  actions: z.array(z.discriminatedUnion('kind', [WorkItemActionSchema, GateActionSchema])),
  warnings: z.array(z.string()),
})

export interface NextActionsDocument {
  system: string
  generated_at: string
  actions: NextAction[]
  warnings: string[]
}

/**
 * 步驟屬於系統層而非模組層。
 *
 * `per` 明確標示時照它；模板裡的人類步驟沒有 `per`，依 `docs/29` §9 的階段語意：
 * P0／P1／P5 是系統層，P2–P4 是模組層。
 */
export function isSystemStep(step: Step): boolean {
  if (step.per === 'system' || step.per === 'repo') return true
  if (step.per !== undefined) return false
  return step.kind === 'human' && (step.phase === 'P0' || step.phase === 'P1' || step.phase === 'P5')
}

/** 步驟接受的任務類型：`task_type` 或所有 work-item 替代方案。 */
export function taskTypesOf(step: Step): string[] {
  if (step.task_type !== undefined) return [step.task_type]
  const types: string[] = []
  for (const alternative of step.alternatives ?? []) {
    if (alternative.task_type !== undefined && !types.includes(alternative.task_type)) {
      types.push(alternative.task_type)
    }
  }
  return types
}

/** 這批工單是否已帶 step provenance（任一工單有 `step_id` 即視為 repo 已遷移）。 */
export function usesStepProvenance(issues: readonly IssueInput[]): boolean {
  return issues.some((issue) => parseStepId(issue.body) !== undefined)
}

export interface CompletionOptions {
  /** true＝只認 `step_id` 相符的工單（provenance 優先）；預設 false＝舊的 task_type fallback。 */
  requireStepId?: boolean
}

const isIssueDone = (issue: IssueInput): boolean =>
  issue.state === 'CLOSED' || issue.labels.includes(STAGE_DONE_LABEL)

/** 完成＝有同任務類型、且已關閉或貼了 `stage/done` 的工作項（或 provenance 相符）。 */
export function isStepDone(
  step: Step,
  issues: readonly IssueInput[],
  gates: readonly GateStatus[] = [],
  options: CompletionOptions = {},
): boolean {
  const doneByIssue =
    options.requireStepId === true
      ? issues.some((issue) => parseStepId(issue.body) === step.id && isIssueDone(issue))
      : issues.some(
          (issue) =>
            taskTypesOf(step).includes(readTaskType(issue.body) ?? '') && isIssueDone(issue),
        )
  if (doneByIssue) return true
  // 人類步驟沒有工作項，完成訊號是「它的閘門已簽」。只要求存在任一 signed 實例
  // （scope 的精細判定留給 gateSigned 的建議邏輯）。
  if (step.kind !== 'human') return false
  const required = step.gates ?? []
  if (required.length === 0) return false
  return required.every((gateId) =>
    gates.some((gate) => gate.id === gateId && gate.state === 'signed'),
  )
}

/** 進行中＝有同任務類型（或 provenance 相符）、且尚未完成的工作項（避免重複建議）。 */
export function isStepInFlight(
  step: Step,
  issues: readonly IssueInput[],
  options: CompletionOptions = {},
): boolean {
  if (options.requireStepId === true) {
    return issues.some((issue) => parseStepId(issue.body) === step.id && !isIssueDone(issue))
  }
  return issues.some(
    (issue) =>
      taskTypesOf(step).includes(readTaskType(issue.body) ?? '') && !isIssueDone(issue),
  )
}

function readTaskType(body: string): string | undefined {
  return extractField(body, 'task_type')
}

function gateSigned(
  step: Step,
  gates: readonly GateStatus[],
  scopes: readonly string[],
): { signed: boolean; missing: string[] } {
  const missing: string[] = []
  for (const gateId of step.gates ?? []) {
    const signed = gates.some(
      (gate) => gate.id === gateId && gate.state === 'signed' && scopes.includes(gate.scope),
    )
    if (!signed) missing.push(gateId)
  }
  return { signed: missing.length === 0, missing }
}

/**
 * 產生待開工作項清單。
 *
 * 排序：先依模組輸入順序，再依模板步驟順序——輸出穩定，diff 可讀。
 */
export function nextActions(input: NextActionsInput): NextActionsDocument {
  const warnings: string[] = []
  const steps = [...input.template.steps, ...(input.process.extra_steps ?? [])]
  // provenance 優先：repo 一旦有 step_id，完成／進行中判定就只認 step_id（見檔頭說明）。
  const completion: CompletionOptions = { requireStepId: usesStepProvenance(input.issues) }
  const moduleSteps = steps.filter((step) => !isSystemStep(step))
  const systemSteps = steps.filter(isSystemStep)

  const unfinishedSystem = systemSteps.filter(
    (step) =>
      step.required !== false &&
      step.conditional !== true &&
      !isStepDone(step, input.issues, input.gates, completion),
  )
  if (unfinishedSystem.length > 0) {
    warnings.push(
      `系統層步驟尚未完成：${unfinishedSystem.map((step) => step.id).join('、')}——以下模組建議可能過早`,
    )
  }

  // 系統層建議：依模板順序，最多一筆（work-item → 開單；human 且有未簽閘門 → 簽核）。
  // 模組建議不受它阻塞——P2–P4 仍各自推進（docs/29 §6）。
  const systemActions: NextAction[] = []
  for (const step of systemSteps) {
    if (step.conditional === true || step.required === false) continue
    if (isStepDone(step, input.issues, input.gates, completion)) continue
    if (step.kind === 'human') {
      const gate = gateSigned(step, input.gates, ['system'])
      if ((step.gates ?? []).length > 0 && !gate.signed) {
        systemActions.push({
          kind: 'gate',
          scope: input.system,
          gate: gate.missing[0] as string,
          template_step: step.id,
          reason: `${step.id} 的系統層閘門尚未簽核`,
        })
        break
      }
      continue
    }
    if (isStepInFlight(step, input.issues, completion)) continue
    const gate = gateSigned(step, input.gates, ['system'])
    if (!gate.signed) {
      systemActions.push({
        kind: 'gate',
        scope: input.system,
        gate: gate.missing[0] as string,
        template_step: step.id,
        reason: `${step.id} 的系統層閘門尚未簽核`,
      })
      break
    }
    const types = taskTypesOf(step)
    if (types.length === 0) continue
    systemActions.push({
      kind: 'work-item',
      scope: input.system,
      template_step: step.id,
      task_type: types[0] as string,
      task_types: types,
      reason: `${step.id} 尚未有完成紀錄（系統層）`,
    })
    break
  }

  const actions: NextAction[] = [...systemActions]
  for (const module of input.modules) {
    const scope = `${input.system}/${module.id}`
    const moduleIssues = input.issues.filter((issue) => moduleOfIssue(issue, [module]) !== undefined)
    const scopes = ['system', scope, module.id]

    for (const step of moduleSteps) {
      if (step.required === false) continue

      // 人類步驟不會產生工作項；它的「完成」由閘門簽核代表。
      // 閘門未簽 → 建議簽核；已簽 → 視為已完成；沒有閘門 → 只能 warning，不能猜。
      if (step.kind === 'human') {
        const gate = gateSigned(step, input.gates, scopes)
        if (!gate.signed) {
          actions.push({
            kind: 'gate',
            scope,
            gate: gate.missing[0] as string,
            template_step: step.id,
            reason: `${step.id} 為人類步驟，需完成並由 ${gate.missing.join('、')} 簽核`,
          })
          break
        }
        warnings.push(`${scope}：${step.id} 為人類步驟（無待簽閘門），未自動建議`)
        continue
      }

      if (isStepDone(step, moduleIssues, input.gates, completion)) {
        const gate = gateSigned(step, input.gates, scopes)
        if (!gate.signed) {
          actions.push({
            kind: 'gate',
            scope,
            gate: gate.missing[0] as string,
            template_step: step.id,
            reason: `${step.id} 已完成，但 ${gate.missing.join('、')} 尚未簽核`,
          })
          break
        }
        continue
      }

      if (step.conditional === true) {
        warnings.push(`${scope}：${step.id} 為條件式步驟，未自動建議`)
        continue
      }

      if (isStepInFlight(step, moduleIssues, completion)) {
        warnings.push(`${scope}：${step.id} 已有進行中的工單，不重複建議`)
        break
      }

      const types = taskTypesOf(step)
      const taskType = types[0]
      if (taskType === undefined) {
        warnings.push(`${scope}：${step.id} 沒有可建議的任務類型`)
        break
      }

      const gate = gateSigned(step, input.gates, scopes)
      actions.push({
        kind: 'work-item',
        scope,
        template_step: step.id,
        task_type: taskType,
        task_types: types,
        reason:
          gate.signed
            ? `${step.id} 尚未有完成紀錄`
            : `${step.id} 尚未有完成紀錄（完成後需 ${gate.missing.join('、')} 簽核）`,
      })
      break
    }
  }

  if (actions.length === 0) warnings.push('目前沒有可建議的下一步')

  return {
    system: input.system,
    generated_at: input.generatedAt,
    actions,
    warnings,
  }
}
