/**
 * 「工作項歷史」分頁的路由（/create/work-items）。
 *
 * 結構刻意與內建的 TasksSubPage 一致：index 為清單、:taskId 為詳情，
 * 讓詳情頁有可分享的網址（稽核情境需要）。
 */
import React from 'react'
import { Route, Routes } from 'react-router-dom'
import { Content } from '@backstage/core-components'
import { HistoryList } from './HistoryList.tsx'
import { HistoryDetail } from './HistoryDetail.tsx'

export function SubPage() {
  return (
    <Routes>
      <Route
        index
        element={
          <Content>
            <HistoryList />
          </Content>
        }
      />
      <Route
        path=":taskId"
        element={
          <Content>
            <HistoryDetail />
          </Content>
        }
      />
    </Routes>
  )
}
