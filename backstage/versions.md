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
# - 2026-09-11 更新：DeepSeek 官方公告 V4.1 Flash 於 2026-09-10 12:00（北京時間）發布，
#   V4.1 Pro 上線前 V4 Pro 請求全部路由至 V4.1 Flash 並按其單價計費 → factory-draft
#   預設 model 改為 deepseek-flash（app-config 可覆寫）。

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
# - ⚠️ PAT 需含 **Commit statuses: Read**（fine-grained）——TechDocs 的 stale check
#   會呼叫 commits/{ref}/status?per_page=0（GithubUrlReader.getRepoDetails），缺此
#   權限回 403 "Resource not accessible by personal access token"（2026-08-21 實測，
#   非 rate limit）。改權限不需重生 token，backend 重啟生效。

# 2026-08-22 實測教訓（feat/factory-draft-robustness）：
# - DeepSeek 偶發回傳空 content（choices[0].message.content 缺失）→ callDeepSeek 丟錯；
#   Express 4 不自動捕獲 async handler rejection → response 永不送出 →
#   前端無限轉圈（log: Unhandled rejection LLM response missing content）。
# - 修正：router 全部端點包 try/catch（失敗一律回 500）；callDeepSeek 加 90 秒
#   AbortController 逾時 + 空回應記錄 finish_reason/原始摘要；前端 post() 加 120 秒
#   逾時 + busy 提示「正在呼叫 LLM（可能需 20–60 秒）」。

# 2026-08-26 更新（PR Board + Roadmap + 持久化 + 版控）
# - 新增插件鎖版（與 Backstage 1.53.0 套件集逐一核對相容）：
#   @backstage-community/plugin-github-pull-requests-board@1.3.1（frontend，/alpha）
#   @rothenbergt/backstage-plugin-roadmap@2.3.0（frontend，自動發現）
#   @rothenbergt/backstage-plugin-roadmap-backend@1.0.1（backend，backend.add 註冊）
# - DB 持久化：backend.database.connection 用 `directory: ./backstage-db`
#   （Backstage 1.53 基底連線**不接受檔案路徑字串**，實測 error
#   `connection.filename is not supported`；每個 plugin 產生 <pluginId>.sqlite）。
# - roadmap.adminUsers: group:default/factory-team（通知收件人；權限為 allow-all）。
# - Roadmap 的 page 擴充未設 title → 不會自動產生 sidebar nav item，
#   需在 packages/app/src/modules/nav/Sidebar.tsx 手動加 SidebarItem。
# - backstage-app 已入版控（獨立 repo，D1 不變：不入 software_factory repo）：
#   https://github.com/philipz/backstage-app（main = 現況；不含 node_modules/.env/backstage-db/dsh）。
# - 重建指引：docs/17-backstage-rebuild.md（路徑 B：clone；路徑 A：create-app 逐項套用）。

# 2026-09-11 工作項歷史查閱分頁（ADR-017）部署驗證——實測結果
#
# 【啟動指令】`yarn dev` 不存在（Usage Error: Couldn't find a script named "dev"）。
#   正確為 repo 級 `yarn start`（= backstage-cli repo start），且需先載入 .env：
#     cd ../backstage-app && set -a && . ./.env && set +a && yarn start
#
# ✅ 驗證項 1：SubPageBlueprint 的 `attachTo: { id: 'page:scaffolder', input: 'pages' }`
#   生效——Create 頁出現第六個分頁。頁籤標籤為 **Task History**（2026-09-11 由
#   「工作項歷史」改為英文，與同排內建分頁 Templates / Tasks / Actions /
#   Template Editor 一致；頁面內容維持中文）。標籤由對抗性測試釘住。
# ✅ 驗證項 3：useTaskEventStream 對已完成任務 replay 時完整帶回 output 與 stepLogs。
# ✅ 瀏覽器驗收 8/8 通過（使用者確認，2026-09-11）：
#   分頁出現／清單只列 factory-work-item（不含 agent-add-tests）／清單六欄正確／
#   點入詳情且網址 /create/work-items/<taskId> 重整後仍正確／PRD 全文不截斷／
#   舊任務顯示由 log 解析出的 Issue 連結／新單顯示由 output.links 來的連結／
#   「查看執行 log」正確連到 /create/tasks/<taskId>。
#   ⚠️ 分頁請從 Create 落地頁（/create/templates）點：PageLayout 的分頁是相對
#   href，從詳情頁點會變成 /create/work-items/work-items。此為上游既有行為，
#   內建 Templates / Tasks 分頁完全相同。
#
# ⚠️ 驗證項 2 以另一種方式失敗並修正（原以為會是 rspack 擋跨 root import）：
#   症狀是 `Can't resolve '@software-factory/factory-draft' in packages/app/src`，
#   看似套件找不到，實際上套件一直在、也解析得到——真因在它的依賴鏈。
#   本 repo `src/**` 用 `.js` 副檔名互相 import（tsconfig.build.json 要把 src/
#   emit 成給 Node 消費的 ESM，必須有副檔名），vitest 與 tsc 都會自動對映到
#   `.ts`，所以 1091 條測試全綠、typecheck 乾淨、覆蓋率 100%——同時前端 bundle
#   完全編不起來。Backstage CLI 的 rspack **沒有 extensionAlias**（已 grep
#   cli-module-build 確認），無法解析 `./narrow.js`；CLI 也未提供使用者覆寫
#   bundler 設定的途徑。
#   修法（commit 0fe7724）：讓被前端引入的模組自足——task-record.ts 與
#   issue-url.ts 各複製一份收窄工具，刪除 narrow.ts。未採用「把邏輯搬進插件」
#   的 fallback，因其需動 tsconfig/vitest 的 include 與 allowImportingTsExtensions，
#   而 tsconfig.build.json 的 noEmit:false 與該旗標衝突（TS5096）。
#   ✅ 已加對抗性測試釘住「前端引入的 src/ 模組不得有相對 import」（mutation 驗證過）。
#   ✅ 驗證方式：以 Backstage 實際安裝的 rspack resolver（enhanced-resolve，
#      套用 CLI 的 resolve 設定）從 packages/app/src 走訪整個前端 import 圖
#      → 本 repo 7 個檔案、0 筆解析失敗（修正前 2 筆失敗）。
#
# ⚠️ 教訓（同 ADR-017 第三條）：測試綠燈的範圍就是測試執行的範圍。跨出測試
#   範圍的整合（bundler）需要自己的驗證，而「用真實 bundler 的 resolver 走訪
#   一次 import 圖」是最便宜的那一道。
