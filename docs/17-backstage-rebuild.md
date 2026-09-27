# Backstage 重建手冊（重新安裝到其他機器 / 雲端 Ubuntu VM）

> **依據**：`02-architecture.md` D1（Backstage 不入 software_factory repo）、`backstage/versions.md`（鎖版紀錄）、`03-idp-backstage.md` §7（已驗證組態與踩坑）。
> **狀態**：2026-08-26 更新——涵蓋 PR Board 插件、Roadmap 插件、SQLite 持久化、sidebar 選單。

## 目的

讓**任何機器**（另一台 mac、雲端 Ubuntu VM）重建出與現況一致的 Backstage app（Backstage 1.53.0，含 GitHub OAuth、Catalog 三 repo、factory-work-item Template、PR Board、Roadmap、檔案型 SQLite）。

兩條路徑：

- **路徑 B（推薦）**：直接 clone 已版控的 `philipz/backstage-app`（零 drift、一鍵重建）。
- **路徑 A**：從 `create-app` 從頭 scaffold，再逐項套用客製化（文件化全部步驟，供審查與理解）。

## 前置需求

| 項目 | 需求 | 備註 |
|---|---|---|
| Node | **22 Active LTS**（本機 22.21.1） | 官方要求 Active LTS |
| Yarn | 4（repo 內 `.yarn/releases` 已隨版控） | corepack enable 即可 |
| 記憶體 | ≥ 6 GB | 官方最低需求 |
| Build 工具 | macOS：Xcode CLT；**Ubuntu：`build-essential` + `python3`** | node-gyp 需要 |
| Docker | 需要 | TechDocs `generator.runIn: docker` |
| GitHub 憑證 | OAuth App（client id/secret）、PAT（`GITHUB_TOKEN`，含 repo 讀取）、`BACKEND_SECRET` | `.env.example` 有欄位說明 |

---

## 路徑 B：clone 重建（推薦）

```bash
git clone git@github.com:philipz/backstage-app.git
cd backstage-app
cp .env.example .env          # 填 AUTH_GITHUB_CLIENT_ID/SECRET、GITHUB_TOKEN、BACKEND_SECRET（及 DEEPSEEK_API_KEY）
yarn install
set -a && source .env && set +a
yarn start                    # app :3000、backend :7007
```

**重點說明**：

- `main` = 現況（含 PR Board、Roadmap、DB 持久化、sidebar 選單、catalog 設定）。
- `backstage-db/`（SQLite 資料檔）**不在版控**（`.gitignore`）——首次啟動自動建立，roadmap/catalog 資料從零開始；若需遷移舊資料，直接複製 `backstage-db/` 目錄過去即可。
- `packages/app/src/modules/dsh/` **不在版控**（工作進行中）——clone 後無 `/dsh` 頁面（sidebar 的 DSH 選單項會指向不存在的路由）。
- `node_modules`、`.env` 均不入版控。

---

## 路徑 A：從頭重建（create-app + 客製化）

### 1. Scaffold（鎖版，見 versions.md Q03-1）

```bash
npx @backstage/create-app@0.9.0 --path backstage-app --skip-install
cd backstage-app && yarn install   # → Backstage 1.53.0
```

### 2. 環境變數

`cp .env.example .env`，填入 OAuth / PAT / BACKEND_SECRET。

### 3. 客製化項目（每一項對應現況；本機 backstage-app 為最終事實來源）

| # | 項目 | 檔案 | 內容 |
|---|---|---|---|
| 1 | GitHub OAuth 登入（唯一登入，移除 guest） | `packages/app/src/App.tsx` | `SignInPageBlueprint.make`（github-auth-provider）+ `createFrontendModule({ pluginId: 'app' })`；backend 註冊 `plugin-auth-backend-module-github-provider`；signIn resolver `usernameMatchingUserEntityName`（GitHub 登入名 → User entity `metadata.name`） |
| 2 | **PR Board 插件** | `packages/app/package.json` + `App.tsx` | `yarn --cwd packages/app add @backstage-community/plugin-github-pull-requests-board@1.3.1`；App.tsx `features` 加 `githubPullRequestsBoardPlugin`（自 `/alpha` default import）；Group 頁 Overview 卡片 + Pull Requests 分頁 |
| 3 | **Roadmap 插件** | `packages/app/package.json`、`packages/backend/package.json`、`packages/backend/src/index.ts` | `yarn --cwd packages/app add @rothenbergt/backstage-plugin-roadmap@2.3.0`；`yarn --cwd packages/backend add @rothenbergt/backstage-plugin-roadmap-backend@1.0.1`；`backend.add(import('@rothenbergt/backstage-plugin-roadmap-backend'))`；前端自動發現（`app.packages: all`） |
| 4 | Sidebar 選單 | `packages/app/src/modules/nav/Sidebar.tsx` | Menu group 加 DSH 與 Roadmap 項（`SidebarItem`，Map icon）——roadmap page 擴充未設 title，不會自動產生 nav item |
| 5 | **DB 持久化** | `app-config.yaml` | `backend.database.connection.directory: ./backstage-db`（**不可用檔案路徑字串**——Backstage 1.53 基底連線拒絕，見踩坑） |
| 6 | Roadmap 設定 | `app-config.yaml` | `roadmap.adminUsers: [group:default/factory-team]`（通知收件人；權限由 allow-all policy 決定） |
| 7 | Catalog locations | `app-config.yaml` | software_factory / fubon-tradingbot / spring-modulith-orders 的 `catalog-info.yaml`、Template（`agent-add-tests`、`factory-work-item`）；`users.yaml`（User/Group）改 `type: file` 讀 backstage-app 本地（部署組態）；**url 型 ref 不得含斜線**（用 `main` 或 commit SHA） |
| 8 | factory-draft（選用，ADR-009） | 見 `backstage/plugins/README.md` | link: portal 依賴 + `backstage/plugins/node_modules` 橋接 symlink + backend.add + App.tsx field extension |
| 9 | 團隊白名單（**部署組態**） | backstage-app repo 根目錄 `users.yaml` | User `philipz`、`tradingbot-tw` + Group `factory-team`（User `metadata.name` 必須等於 GitHub 登入名，signIn resolver 靠它比對）。2026-09-19 自 software_factory `backstage/users.yaml` 移入——白名單隨部署與使用者而異，不屬產品 repo |

### 4. 啟動與驗證

```bash
set -a && source .env && set +a
yarn start
```

**驗證清單**：

- [ ] 瀏覽器 http://localhost:3000 → GitHub OAuth 登入（philipz）
- [ ] Catalog 出現三 repo Component（software-factory / fubon-tradingbot / spring-modulith-orders）+ factory-team group
- [ ] `group:default/factory-team` 頁面 PR Board 顯示開放 PR（需要 Component `spec.owner` 為該 group 且帶 `github.com/project-slug`）
- [ ] `/roadmap` 看板可新增 feature（權限：allow-all）
- [ ] 持久化：新增 feature → 重啟 backend → feature 仍在（`packages/backend/backstage-db/roadmap.sqlite`）

---

## 雲端 Ubuntu VM 部署注意（路徑 A/B 皆適用）

1. **Build 環境**：`sudo apt install build-essential python3`（node-gyp 依賴）。
2. **Docker**：TechDocs builder 需要。
3. **對外位址**：`app-config.yaml` 的 `app.baseUrl` / `backend.baseUrl` / `cors.origin` 目前是 `localhost`——改為 VM 位址（或網域）。
4. **GitHub OAuth callback**：GitHub OAuth App 的 callback URL 需更新為 VM 位址。
5. **`auth.environment`**：目前 `development`；正式環境改 `production`，產線組態放 `app-config.production.yaml`。
6. **暴露範圍**：`start.sh` 綁 DSH 於 127.0.0.1:7800（不對外，正確）；Backstage :3000/:7007 建議走 reverse proxy + TLS。
7. **版本漂移**：安裝新插件前對照 `backstage/versions.md` 的鎖版與相容性核對紀錄。

---

## 參考

- `backstage/versions.md` —— 鎖版紀錄（create-app 0.9.0、Backstage 1.53.0、Q 系列驗證與踩坑）
- `docs/03-idp-backstage.md` §7 —— 已驗證組態表、9 條踩坑、啟動方式
- `backstage/plugins/README.md` —— factory-draft 插件 wiring（ADR-009）
- `start.sh` / `stop.sh` —— 本機服務管理（DSH web + Backstage）
