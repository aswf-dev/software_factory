/**
 * factory-draft 前端 module：software_factory 對 Backstage scaffolder 的客製擴充。
 *
 * 兩個擴充：
 * 1. FactoryWorkItemDraftField —— 開單表單的 LLM 草稿助手欄位（docs/ADR/009）；
 * 2. work-item-history SubPage —— Create 頁的「工作項歷史」唯讀查閱分頁（docs/ADR/017）。
 *
 * 根因備忘（2026-08-21 實測，讀 frontend-app-api resolveAppNodeSpecs 原始碼確認）：
 * `features` 只接受 FrontendPlugin 或 FrontendModule——**裸的 ExtensionDefinition
 * 會被靜默丟棄**（不進 app tree，loadFormFields 永遠拿不到 → RJSF 退回預設欄位）。
 * 正確做法：用 `createFrontendModule` 包裝，pluginId 對應宿主插件（scaffolder）
 * 以取得 plugin 上下文與 attachTo 解析。
 *
 * 使用方式：features: [factoryDraftModule, ...]
 */
import React from 'react'
import { createFrontendModule, SubPageBlueprint } from '@backstage/frontend-plugin-api'
import { FormFieldBlueprint } from '@backstage/plugin-scaffolder-react/alpha'
import { FactoryWorkItemDraftField } from './draft-field/DraftFieldComponent.tsx'

export { FactoryWorkItemDraftField }

const factoryWorkItemDraftField = FormFieldBlueprint.make({
  name: 'factory-work-item-draft',
  params: {
    field: () => Promise.resolve(FactoryWorkItemDraftField),
  },
})

/**
 * Create 頁的新分頁（PageBlueprint 會把 pages input 逐一渲染成頁首 tab）。
 *
 * attachTo 明寫 page:scaffolder——SubPageBlueprint 的預設是
 * { relative: { kind: 'page' }, input: 'pages' }，而本 module 自身沒有
 * page 擴充，不能依賴 relative 解析。
 */
const workItemHistorySubPage = SubPageBlueprint.make({
  name: 'work-item-history',
  attachTo: { id: 'page:scaffolder', input: 'pages' },
  params: {
    path: 'work-items',
    // 標籤用英文以與同排的內建分頁一致（Templates / Tasks / Actions /
    // Template Editor 都是英文）。頁面內容維持中文——那些是操作語彙，
    // 不是導覽標籤。
    title: 'Task History',
    loader: () => import('./work-item-history/SubPage.tsx').then((m) => <m.SubPage />),
  },
})

const factoryDraftModule = createFrontendModule({
  pluginId: 'scaffolder',
  extensions: [factoryWorkItemDraftField, workItemHistorySubPage],
})

export default factoryDraftModule
