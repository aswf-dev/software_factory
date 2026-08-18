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
