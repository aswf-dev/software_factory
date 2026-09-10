/**
 * 工作項歷史詳情（唯讀）。
 *
 * useTaskEventStream 一次給齊三樣東西：task.spec.parameters（表單原值）、
 * output（新任務的 Issue links）、stepLogs（舊任務唯一留有 Issue URL 的地方）。
 * 內建 OngoingTask 用的是同一個 hook，已完成任務會 replay 完整事件。
 *
 * 本頁不重造 log 檢視——底部連回內建任務頁。
 */
import React from 'react'
import { useParams } from 'react-router-dom'
import { useTaskEventStream } from '@backstage/plugin-scaffolder-react'
import { ErrorPanel, InfoCard, Link, Progress } from '@backstage/core-components'
import Box from '@material-ui/core/Box'
import Typography from '@material-ui/core/Typography'
import { extractIssueUrl } from '../../../../../src/work-item-history/issue-url.ts'
import {
  formatTimestamp,
  toWorkItemRecord,
} from '../../../../../src/work-item-history/task-record.ts'

function Field(props: { label: string; value: string }) {
  return (
    <Box marginBottom={1.5}>
      <Typography variant="subtitle2" color="textSecondary">
        {props.label}
      </Typography>
      <Typography variant="body2" component="pre" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
        {props.value.length > 0 ? props.value : '（無內容）'}
      </Typography>
    </Box>
  )
}

export function HistoryDetail() {
  const { taskId } = useParams()
  const stream = useTaskEventStream(taskId ?? '')

  if (stream.error) return <ErrorPanel error={stream.error} />
  if (!stream.task) return <Progress />

  const record = toWorkItemRecord(stream.task)
  if (record === null) {
    return <ErrorPanel error={new Error(`任務 ${taskId ?? ''} 的資料無法解析`)} />
  }

  const logLines = Object.values(stream.stepLogs ?? {}).flat()
  const issueUrl = extractIssueUrl({ output: stream.output, logLines })

  return (
    <Box>
      {issueUrl !== undefined && (
        <Box marginBottom={2}>
          <Typography variant="subtitle2" color="textSecondary">
            已建立的 Issue
          </Typography>
          <Link to={issueUrl}>{issueUrl}</Link>
        </Box>
      )}

      <Box marginBottom={2}>
        <InfoCard title="表單內容（唯讀）" titleTypographyProps={{ component: 'h2' }}>
          <Field label="一句話需求（Issue 標題）" value={record.oneLiner} />
          <Field label="任務類型" value={record.taskType} />
          <Field label="目標 repo" value={record.targetRepo} />
          <Field label="目標分支" value={record.baseBranch} />
          <Field label="需求描述（PRD）" value={record.requirement} />
        </InfoCard>
      </Box>

      <InfoCard title="任務資訊" titleTypographyProps={{ component: 'h2' }}>
        <Field label="Task ID" value={record.taskId} />
        <Field label="建立者" value={record.createdBy} />
        <Field label="建立時間" value={formatTimestamp(record.createdAt)} />
        <Field label="狀態" value={record.status} />
        {/* 內建任務頁的路徑；scaffolder 的 task routeRef 未公開匯出，故直接寫路徑。 */}
        <Link to={`/create/tasks/${record.taskId}`}>查看執行 log</Link>
      </InfoCard>
    </Box>
  )
}
