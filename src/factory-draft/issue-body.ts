/**
 * Factory Work Item 的 Issue title/body 構造（純函式）。
 *
 * 與 .github/ISSUE_TEMPLATE/factory-work-item.yml 表單輸出格式逐字對齊：
 * - 欄位標題用 `### <標題>`（與 src/cli/factory-issue-check.ts 的 FIELD_TITLES 同源）；
 * - DoD 三項全部以 `- [x] <label>` 輸出（DOD_LABELS 同源，3/3 全勾契約）。
 *
 * 使用情境：Backstage factory-work-item 模板的 github:issues:create 以相同格式
 * 構造 body（template.yaml 的 block scalar 複製此格式；對抗性測試
 * factory-assets 釘住兩邊逐字一致）。本模組是格式的「可測試參考實作」——
 * round-trip 測試證明 buildIssueBody 的產出可直接通過 factory-issue-check。
 */
import { DOD_LABELS } from '../cli/factory-issue-check.js'

export interface FactoryIssueBodyInput {
  taskType: string
  requirement: string
  targetRepo: string
}

/** Issue 標題：一律帶 `[factory] ` 前綴（與 ISSUE_TEMPLATE 的 title 模式一致）。 */
export function buildIssueTitle(oneLiner: string): string {
  return `[factory] ${oneLiner.trim()}`
}

/** 建構與表單輸出格式一致的 Issue body。 */
export function buildIssueBody(input: FactoryIssueBodyInput): string {
  const dod = DOD_LABELS.map((label) => `- [x] ${label}`).join('\n')
  return [
    '### 任務類型',
    '',
    input.taskType,
    '',
    '### 需求描述（PRD）',
    '',
    input.requirement,
    '',
    '### 驗收標準（DoD）',
    '',
    dod,
    '',
    '### 目標 repo（預設本 repo）',
    '',
    input.targetRepo,
    '',
  ].join('\n')
}
