# factory-draft 客製插件（docs/ADR/009）

LLM 草稿助手的 Backstage 實作，分三層：

| 目錄 | 內容 | 驗證狀態 |
|---|---|---|
| `../../src/factory-draft/` | **純邏輯**（prompts / parse / issue-body）——typecheck + 單元測試覆蓋（repo 工具鏈） | ✅ 已測試 |
| `factory-draft-backend/` | **後端薄接線**：Express 路由 `/api/factory-draft/clarify`、`/api/factory-draft/generate`，呼叫 DeepSeek | ⚠️ 待部署時驗證 |
| `factory-draft/` | **前端擴充**：客製欄位 `FactoryWorkItemDraftField`（scaffolder field extension）＋ Create 頁「工作項歷史」唯讀 SubPage（ADR-017，清單／詳情元件取用 repo 根的 `src/work-item-history/`） | ⚠️ 待部署時驗證 |

## Wiring（外部 Backstage app，`../backstage-app/` v1.53.0，2026-08-21 已實跑驗證）

依 docs/03 §3.4 與 `backstage/versions.md`（鎖版、Q09-1 部署驗證紀錄）：

1. **依賴（link: portal）**：`packages/backend/package.json` 加
   `"@software-factory/factory-draft-backend": "link:../../../software_factory/backstage/plugins/factory-draft-backend"`；
   `packages/app/package.json` 加
   `"@software-factory/factory-draft": "link:../../../software_factory/backstage/plugins/factory-draft"`。
   然後 `yarn install`。
2. **node_modules 橋接**：repo 內建 symlink
   `backstage/plugins/node_modules → ../backstage-app/node_modules`（gitignored）。
   plugin 以 link: 掛載後實體路徑在 repo 內，Node 從實體路徑解析依賴——橋接讓
   `@backstage/*` 找得到。**不要用 `--preserve-symlinks`**（會把 plugin 變成
   node_modules 內檔案，觸發 Node 22 的 ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING）。
3. **後端註冊**：`packages/backend/src/index.ts` 加
   `backend.add(import('@software-factory/factory-draft-backend'))`。
   插件用 **`createBackendPlugin`**（不是 createBackendModule——module 的 init 只在
   宿主 plugin 存在時執行）且必須 **default export**。
4. **前端註冊**：`packages/app/src/App.tsx` 的 `features` 加入
   `factoryWorkItemDraftField`（`FormFieldBlueprint.make` 產出的 extension，new
   frontend system 模式；`createScaffolderFieldExtension` 是 legacy API 不適用）。
5. **catalog location**：`app-config.yaml` 的 `catalog.locations` 加
   `backstage/templates/factory-work-item/template.yaml` 的 url location（rules
   allow Template）。**ref 不得含斜線**（git-url-parse 拆錯 → 404）——用 main 或
   commit SHA（PR 未合併前用 SHA，合併後改 main）。
6. **app-config / env**（本機、gitignored）：
   ```yaml
   factoryDraft:
     apiKey: ${DEEPSEEK_API_KEY}     # .env 或環境變數
     baseUrl: https://api.deepseek.com   # 可省略
     model: deepseek-v4.1-flash          # 可省略（2026-09-10 起 V4 Pro 請求由官方路由至 V4.1 Flash）
   ```
   `integrations.github.token: ${GITHUB_TOKEN}`（app-config.yaml 已有）＝ philipz
   PAT（human-initiated dispatch + issues:create 共用）。
7. **啟動**：`yarn workspace backend start` **不會自動載入 .env**——先
   `set -a; . ./.env; set +a`（或 `yarn start` repo 級）。`/health` 非預設路由；
   確認存活用 `curl :7007/api/catalog/entities`（401 = 活著且 router 已掛）。

## deploy-time 驗證結果（Q09-1，2026-08-21）

- ✅ `github:issues:create` 存在於鎖版 plugin 0.9.11，outputs `issueNumber`（template 依賴）
- ✅ plugin 初始化、router 掛載（401 = 已掛、auth 保護）
- ✅ catalog 讀取 template location（無警告）
- ⏳ LLM 端點端到端 + 表單 UI：需瀏覽器 GitHub OAuth 登入後驗證（本輪未做）

## 安全邊界

- `factoryDraft.apiKey` 僅存本機 app-config；僅供草稿生成 LLM call；草稿不寫入
  Issue body（ADR-009 決策：品質標示只在表單審查畫面顯示）。
- PAT 僅供人類發起的 `github:actions:dispatch`；agent 身分不變（App token）。
