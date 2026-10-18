/**
 * factory-graph 的文件組裝（ADR-023 附錄 B；docs/research/55）。
 *
 * **這個模組只做「搬運與組裝」，不做判定**：工作項類型、相依、三軸、就緒度全部來自
 * 既有來源（Issue body／label／process.yaml／HG 留言），本模組不重新計算任何一項。
 * 理由：`ADR-001` 說 GitHub 是唯一真相，`ADR-023` §2 說判定留在 `src/cli`；
 * 若這裡開始「推測」，UI 就會畫出一個看起來很有說服力但錯的圖。
 *
 * v1 的誠實邊界（寫進 warnings，不藏在程式裡）：
 *   - 前置是否完成只依 `stage/done` 標籤，**不含 PR 合併狀態**（那是 ADR-022 的完整判定，
 *     需要 PR 資料；v1 先不取，且把限制講出來）。
 *   - 沒提供模組清單時，工作項掛在系統節點下。
 *   - `warnings` 永遠是 advisory，不得變成閘門（ADR-024 §4）。
 */
import { minimatch } from 'minimatch'
import { z } from 'zod'
import { extractDeclaredPaths, extractField, parsePrerequisites } from '../cli/factory-issue-check.js'
import type { GateStatus } from '../hg/parse.js'
import type { ModuleEntry, ProcessSpec } from '../process/spec.js'

/** 人工覆寫：前置／階段已完成（ADR-022）。 */
export const STAGE_DONE_LABEL = 'stage/done'
export const NEEDS_HUMAN_LABEL = 'needs-human'

export interface IssueInput {
  number: number
  title: string
  body: string
  labels: readonly string[]
  state: 'OPEN' | 'CLOSED'
}

export interface BuildInput {
  system: string
  issues: readonly IssueInput[]
  modules?: readonly ModuleEntry[] | undefined
  process?: ProcessSpec | undefined
  gates?: readonly GateStatus[] | undefined
  generatedAt: string
  github?: string | undefined
  rev?: string | undefined
}

export type NodeKind = 'system' | 'module' | 'workitem'
export type WorkItemState = 'open' | 'closed' | 'waiting-prereq' | 'needs-human'

export interface GraphNode {
  id: string
  kind: NodeKind
  label: string
  scale?: string
  phase?: string
  readiness?: string
  owner?: string
  spec?: string
  task_type?: string
  /**
   * 流程步驟的一次執行（ADR-023 §5）。來源是 Issue body 第一個 `###` 之前的
   * `> 流程步驟：S10` 行；未標示時省略（advisory，不影響 state／gates）。
   */
  step_id?: string
  state?: WorkItemState
  prereqs?: number[]
  oversight?: string
  needs_human?: boolean
}

export interface GraphEdge {
  from: string
  to: string
  kind: 'contains' | 'prerequisite'
}

export interface GraphDocument {
  system: string
  generated_at: string
  source: { github: string; rev: string | null }
  nodes: GraphNode[]
  edges: GraphEdge[]
  gates: GateStatus[]
  warnings: string[]
}

/**
 * 輸出契約的可驗證版本。
 *
 * 存在的理由：Scoreboard 會 vendor `docs/research/fixtures/factory-graph.sample.json`；
 * 沒有可執行的 schema，「vendored 的樣本」遲早會與 CLI 的真實輸出漂移。
 */
export const GraphDocumentSchema = z.object({
  system: z.string().min(1),
  generated_at: z.string().min(1),
  source: z.object({ github: z.string().min(1), rev: z.string().nullable() }),
  nodes: z.array(
    z.object({
      id: z.string().min(1),
      kind: z.enum(['system', 'module', 'workitem']),
      label: z.string().min(1),
      scale: z.string().optional(),
      phase: z.string().optional(),
      readiness: z.string().optional(),
      owner: z.string().optional(),
      spec: z.string().optional(),
      task_type: z.string().optional(),
      step_id: z.string().min(1).optional(),
      state: z.enum(['open', 'closed', 'waiting-prereq', 'needs-human']).optional(),
      prereqs: z.array(z.number()).optional(),
      oversight: z.string().optional(),
      needs_human: z.boolean().optional(),
    }),
  ),
  edges: z.array(
    z.object({
      from: z.string().min(1),
      to: z.string().min(1),
      kind: z.enum(['contains', 'prerequisite']),
    }),
  ),
  gates: z.array(
    z.object({
      id: z.string().min(1),
      scope: z.string().min(1),
      state: z.enum(['signed', 'missing']),
      signed_by: z.string().optional(),
      signed_at: z.string().optional(),
      evidence: z.string().optional(),
    }),
  ),
  warnings: z.array(z.string()),
})

const OVERSIGHT_LABELS = ['oversight/on-loop', 'oversight/review', 'oversight/in-loop'] as const

/** 可作為 step id 的字元：英數、連字號、底線（S10、L12a、quint-verification）。 */
const STEP_ID = /^[A-Za-z][A-Za-z0-9_-]*$/

/**
 * 讀 Issue body 的流程步驟 provenance（ADR-023 §5）。
 *
 * 只認**第一個 `###` 之前**的 blockquote 行，格式 `> 流程步驟：S10`（全形或半形冒號）：
 *   - 放在前置區是刻意的——`extractField` 從 `###` 開始讀，這行不會污染任何欄位；
 *   - 也避免 PRD 內文剛好提到「流程步驟」時被誤認。
 *
 * 沒有標示或格式不合時回 `undefined`：**不以 task_type 猜測**，因為同一個 task_type
 * 可能對應多個步驟（agent-analyze → S4／S5、M5／M6／M7）。
 */
export function parseStepId(body: string): string | undefined {
  const firstHeading = body.search(/^###\s/m)
  const prefix = firstHeading === -1 ? body : body.slice(0, firstHeading)
  const match = prefix.match(/^\s*>\s*流程步驟\s*[：:]\s*([^\s]+)\s*$/m)
  const id = match?.[1]
  return id !== undefined && STEP_ID.test(id) ? id : undefined
}

/** 工作項歸屬的模組：以 PRD 宣告路徑比對模組的 glob，第一個命中者勝。 */
export function moduleOfIssue(issue: IssueInput, modules: readonly ModuleEntry[]): ModuleEntry | undefined {
  const declared = extractDeclaredPaths(issue.body)
  if (declared.length === 0) return undefined
  return modules.find((module) =>
    declared.some((path) => module.paths.some((glob) => minimatch(path, glob))),
  )
}

export function workItemState(
  issue: IssueInput,
  issuesByNumber: ReadonlyMap<number, IssueInput>,
): { state: WorkItemState; unresolved: number[] } {
  if (issue.labels.includes(NEEDS_HUMAN_LABEL)) return { state: 'needs-human', unresolved: [] }

  const unresolved = parsePrerequisites(issue.body).filter((n) => {
    const prereq = issuesByNumber.get(n)
    return prereq === undefined || !prereq.labels.includes(STAGE_DONE_LABEL)
  })
  if (unresolved.length > 0) return { state: 'waiting-prereq', unresolved }
  return { state: issue.state === 'CLOSED' ? 'closed' : 'open', unresolved: [] }
}

function oversightOf(labels: readonly string[]): string | undefined {
  return OVERSIGHT_LABELS.find((label) => labels.includes(label))
}

/**
 * 組出 `factory-graph --json` 的文件。
 *
 * 輸出刻意保持穩定排序（模組依輸入、工作項依編號、邊依 from/to），讓 diff 與測試可讀。
 */
export function buildGraph(input: BuildInput): GraphDocument {
  const warnings: string[] = []
  const modules = input.modules ?? []
  const issues = [...input.issues].sort((a, b) => a.number - b.number)
  const issuesByNumber = new Map(issues.map((issue) => [issue.number, issue]))

  if (input.process === undefined) {
    warnings.push('未提供 process.yaml：無法輸出規模與階段')
  }
  if (modules.length === 0) {
    warnings.push('未提供模組清單：工作項掛在系統節點下')
  }
  if (issues.some((issue) => parsePrerequisites(issue.body).length > 0)) {
    warnings.push('前置完成判定僅依 stage/done 標籤，未含 PR 合併狀態（v1 限制）')
  }

  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  let unlabeledStepCount = 0

  const systemNode: GraphNode = { id: input.system, kind: 'system', label: input.system }
  if (input.process !== undefined) {
    systemNode.scale = input.process.scale
    systemNode.phase = input.process.phases[0] as string
  }
  nodes.push(systemNode)

  for (const module of modules) {
    const id = `${input.system}/${module.id}`
    const node: GraphNode = { id, kind: 'module', label: module.id }
    if (module.readiness !== undefined) node.readiness = module.readiness
    if (module.owner !== undefined) node.owner = module.owner
    if (module.spec !== undefined) node.spec = module.spec
    nodes.push(node)
    edges.push({ from: input.system, to: id, kind: 'contains' })
  }

  for (const issue of issues) {
    const taskType = extractField(issue.body, 'task_type')
    if (taskType === undefined) warnings.push(`#${issue.number}: 缺少任務類型欄位`)

    const { state, unresolved } = workItemState(issue, issuesByNumber)
    for (const n of unresolved) {
      if (!issuesByNumber.has(n)) warnings.push(`#${issue.number}: 前置 #${n} 不在清單中`)
    }

    const module = moduleOfIssue(issue, modules)
    const prereqs = parsePrerequisites(issue.body)
    const node: GraphNode = {
      id: `issue:${issue.number}`,
      kind: 'workitem',
      label: `#${issue.number} ${issue.title}`,
      state,
      prereqs,
      needs_human: issue.labels.includes(NEEDS_HUMAN_LABEL),
    }
    if (taskType !== undefined) node.task_type = taskType
    const stepId = parseStepId(issue.body)
    if (stepId !== undefined) node.step_id = stepId
    else unlabeledStepCount += 1
    const oversight = oversightOf(issue.labels)
    if (oversight !== undefined) node.oversight = oversight.slice('oversight/'.length)
    nodes.push(node)

    const parent = module === undefined ? input.system : `${input.system}/${module.id}`
    edges.push({ from: parent, to: node.id, kind: 'contains' })
    for (const prereq of prereqs) {
      if (issuesByNumber.has(prereq)) edges.push({ from: `issue:${prereq}`, to: node.id, kind: 'prerequisite' })
    }
  }

  if (unlabeledStepCount > 0) {
    warnings.push(
      `${unlabeledStepCount} 張工單未標示流程步驟（\`> 流程步驟：S10\`），無法掛到步驟`,
    )
  }

  const gates = input.gates ?? []
  for (const gate of gates) {
    if (gate.state === 'missing') warnings.push(`${gate.id}（${gate.scope}）尚未簽核`)
  }

  edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))

  return {
    system: input.system,
    generated_at: input.generatedAt,
    source: { github: input.github ?? input.system, rev: input.rev ?? null },
    nodes,
    edges,
    gates: [...gates].sort((a, b) => a.id.localeCompare(b.id) || a.scope.localeCompare(b.scope)),
    warnings,
  }
}
