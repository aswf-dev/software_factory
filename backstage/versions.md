# Backstage 鎖版紀錄（Q03-1 / Q03-3）

- **Backstage create-app 版本**：`0.9.0`（`npm view @backstage/create-app version`，2026-08-17）
- **Node 支援**：Backstage 官方要求 **Node.js Active LTS**（[backstage.io/docs/getting-started](https://backstage.io/docs/getting-started/)）；本機 `22.21.1` 為 Active LTS ✅（Q03-3 解決）
- **最低需求**（官方）：6 GB 記憶體、Unix-like 系統、GNU 建置環境（macOS 需 Xcode CLT）、curl/wget
- **scaffold 位置**：repo 外 `../backstage-app/`（D1：Backstage 不入 repo、不存工廠狀態）
- **Q03-2 已驗證（2026-08-17）**：`github:actions:dispatch` 為 `@backstage/plugin-scaffolder-backend-module-github` 的內建 action，inputs：`token`/`repoUrl`/`workflowId`/`workflowInputs`/`branchOrTagName`；**無輸出 schema**（故 Template 不依賴 workflowRunUrl，改指引 Actions 頁面）
- **Q03-4 驗證**：`factory.io/*` annotation 命名空間未與 Backstage 內建 annotation 衝突（Catalog 載入無警告）
- 驗證日期：2026-08-17

# Backstage 狀態：凍結（2026-08-18 裁決，見 docs/14 §1.7）
# Phase 1-2 採純 GitHub Issue 觸發；工件保留供日後多人需求升級。

# 局部解凍（2026-08-21 裁決，見 docs/ADR/009-backstage-partial-unfreeze.md）：
# 解凍 factory-work-item 模板 + LLM 草稿 + direct dispatch 最小路徑（本機 yarn dev）；
# 其餘能力維持凍結。deploy-time 驗證項：github:issues:create 於鎖版 plugin 是否存在（約 v1.40 起）。

# Q09-1 驗證紀錄（2026-08-21，curl 實測）：
# - DeepSeek API key 有效（GET /models → HTTP 200）；帳號可用模型為
#   deepseek-v4-flash / deepseek-v4-pro / deepseek-v4-flash-vision-exp——無 deepseek-chat；
#   factory-draft 預設 model 已定為 deepseek-v4-flash（app-config 可覆寫）。

# Q09-1 部署驗證紀錄（2026-08-21，實際於 ../backstage-app v1.53.0 實跑 backend 驗證）：
# - ✅ github:issues:create 存在於 plugin-scaffolder-backend-module-github@0.9.11
#   （scaffolder 啟動 log 列出該 action）；inputs repoUrl/title/body/labels/token；
#   **outputs issueUrl + issueNumber（number）**——template 依賴 issueNumber 可運作。
# - ✅ 新 frontend system 客製欄位：FormFieldBlueprint.make + createFormField
#   （@backstage/plugin-scaffolder-react/alpha 2.0.2）——非 legacy 的
#   createScaffolderFieldExtension（那是 core-plugin-api Extension，新系統不吃）。
# - ✅ 後端插件用 createBackendPlugin（非 createBackendModule：module 的 registerInit
#   只在宿主 plugin 存在時才執行——無宿主會永久 "still initializing"）。
# - ✅ backend.add(import(...)) 慣例要求 **default export**（unwrapFeature 讀 default）。
# - ✅ 插件須 "type": "module"，且相對 import 用**明確 .ts 副檔名**（Node 22 strip-types
#   不做 .js→.ts 對映；CJS require 也找不到 .ts）。
# - ✅ link: 依賴（portal）+ repo 內 node_modules 橋接 symlink
#   （backstage/plugins/node_modules → ../backstage-app/node_modules，gitignored）——
#   讓 plugin 從實體路徑解析 @backstage；**不可用 --preserve-symlinks**
#   （會觸發 ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING）。
# - ⚠️ catalog location 的 ref **不得含斜線**：git-url-parse 把
#   blob/feat/backstage-factory-work-item/... 拆成 ref=feat、filepath 偏移 →
#   contents 404（"no matching files found"）。用單段 ref（main 或 commit SHA）。
# - ⚠️ `yarn workspace backend start` 不會自動載入 .env——需先
#   `set -a; . ./.env; set +a`（或走 `yarn start` repo 級指令）。
# - ⏳ endpoint 掛載後由 httpRouter 強制 auth（401 Missing credentials）——
#   LLM 端點需瀏覽器 GitHub OAuth 登入後才能端到端呼叫（UI 步驟，未在本輪驗證）。
