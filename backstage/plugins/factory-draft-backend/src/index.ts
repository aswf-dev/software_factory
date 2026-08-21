/**
 * factory-draft-backend 插件入口（docs/ADR/009 的 LLM 草稿助手後端）。
 *
 * ⚠️ 假設待實作驗證（Q03-2 模式）：本檔案使用 Backstage new backend system 的
 * `createBackendPlugin` / `coreServices` API，實際簽章以部署時鎖定的 Backstage
 * 版本為準（記錄於 backstage/versions.md）。
 *
 * 依賴的純邏輯（prompt 建構、JSON 解析、issue body 格式）在 repo 的
 * `src/factory-draft/`（typecheck + 單元測試覆蓋）；本檔案只做薄接線。
 */
import { coreServices, createBackendPlugin } from '@backstage/backend-plugin-api'
import { createRouter } from './router.ts'

export const factoryDraftBackendPlugin = createBackendPlugin({
  pluginId: 'factory-draft',
  register(env) {
    env.registerInit({
      deps: {
        http: coreServices.httpRouter,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
      },
      async init({ http, config, logger }) {
        http.use(await createRouter({ config, logger }))
      },
    })
  },
})

// backend.add(import(...)) 慣例：unwrapFeature 讀 default export
export default factoryDraftBackendPlugin
