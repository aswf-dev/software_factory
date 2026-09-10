/**
 * 工作項歷史清單。
 *
 * 一次 listTasks 即可顯示所有表單欄位——list 端點回傳完整 spec.parameters
 * （secrets 不在 SELECT 範圍內）。但它**不回傳 output**，而舊任務的 Issue URL
 * 只在 log 事件裡，故清單不放 Issue 連結欄位（要放就得每列各發一次請求）；
 * 連結只出現在詳情頁。
 */
import React from 'react'
import { useApi } from '@backstage/core-plugin-api'
import { scaffolderApiRef } from '@backstage/plugin-scaffolder-react'
import { EmptyState, ErrorPanel, Link, Progress, Table } from '@backstage/core-components'
import Typography from '@material-ui/core/Typography'
import useAsync from 'react-use/esm/useAsync'
import {
  formatTimestamp,
  summarize,
  toWorkItemRecords,
  type WorkItemRecord,
} from '../../../../../src/work-item-history/task-record.ts'

/**
 * 後端 list 端點只支援 createdBy/status 篩選，沒有 template 篩選，
 * 故一次取回上限筆數再於前端過濾。實測 DB 共 43 筆任務，200 綽綽有餘。
 */
const FETCH_LIMIT = 200

export function HistoryList() {
  const scaffolderApi = useApi(scaffolderApiRef)
  const { value, loading, error } = useAsync(
    async () => scaffolderApi.listTasks({ filterByOwnership: 'all', limit: FETCH_LIMIT }),
    [scaffolderApi],
  )

  if (loading) return <Progress />
  if (error) return <ErrorPanel error={error} />

  // 拆信封、篩選、轉換、丟壞資料全在 src/ 的純函式裡完成——本元件不對資料做任何
  // 判斷，`rows` 一律來自 toWorkItemRecords(value)：回應形狀若改變，這裡會安靜地
  // 變成「查無資料」，而那是歷史頁最難察覺的失敗模式。
  const rows: WorkItemRecord[] = toWorkItemRecords(value)

  // 唯一會直接讀信封的地方是截斷提示，且是刻意的：它需要「這次實際取回幾筆、總數
  // 又有幾筆」，而 toWorkItemRecords 只回傳通過篩選的紀錄，刻意不暴露這兩個數字。
  // totalTasks 是 listTasks 回傳的權威總數（後端 DatabaseTaskStore.list 提供）；
  // 唯有總數大於已載入筆數才算截斷——剛好取回 FETCH_LIMIT 筆而別無其他，不算截斷。
  // 欄位缺失或非數字時一律視為「沒有更多」，不從資料的缺席推測截斷。
  const fetchedCount = value?.tasks?.length ?? 0
  const totalTasks = value?.totalTasks
  const isTruncated = typeof totalTasks === 'number' && totalTasks > fetchedCount

  if (rows.length === 0) {
    return (
      <EmptyState
        missing="data"
        title="尚無工作項歷史"
        description="用「開立 Factory 工作項」送出一張單之後，這裡會列出當時填寫的內容。"
      />
    )
  }

  return (
    <>
      <Table<WorkItemRecord>
        title={`工作項歷史（${rows.length} 筆）`}
        options={{ pageSize: 10, emptyRowsWhenPaging: false, search: true }}
        data={rows}
        columns={[
          {
            title: '建立時間',
            field: 'createdAt',
            render: (row) => formatTimestamp(row.createdAt),
          },
          {
            title: '一句話需求',
            field: 'oneLiner',
            render: (row) => (
              <Link to={row.taskId}>{summarize(row.oneLiner, 60) || '（未填）'}</Link>
            ),
          },
          { title: '任務類型', field: 'taskType' },
          { title: '目標 repo', field: 'targetRepo' },
          { title: '狀態', field: 'status' },
          { title: '建立者', field: 'createdBy' },
        ]}
      />
      {isTruncated && (
        <Typography variant="caption">
          僅掃描最近 {FETCH_LIMIT} 筆 scaffolder 任務，更早的紀錄未載入。
        </Typography>
      )}
    </>
  )
}
