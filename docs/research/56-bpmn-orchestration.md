# 56 — BPMN 流程編排：可行性實測與證據彙整

> **狀態**：研究／證據彙整（2026-10-26）。決策見 ADR-027（治理語意）與 ADR-028（技術選型）。
> **讀者**：審查 `ADR-027`／`ADR-028` 的人、要實作 BPMN PoC 的人、要判斷「哪些結論是實測、哪些是推論」的人。
> **關聯**：`ADR-001`（GitHub 唯一真相）、`ADR-022`（前置工作項）、`ADR-023`（`process.yaml` 與拓撲 UI）、`ADR-024`（執行語意）、`ADR-025`（租戶模板）、`ADR-026`（專案擁有系統 spec）、`docs/research/55-workflow-topology-ui.md`（前一版選型）、`docs/29`（P0–P5／HG0–HG7）。

本文件只彙整 2026-10-25～26 grilling 期間**已查證的事實與實測結果**，不做新決策。標註「未驗證」者為推論或文件宣稱，PoC 必須重測（§9）。

---

## 0. 一句話結論

在 Cloudflare Durable Object（DO）內跑 BPMN 權威實例**技術上可行**，但兩條主流路線各缺一塊：bpmn.io／paed01 路線的 `bpmn-engine` 在 workerd **一 import 就崩潰**（`bpmn-elements` 本身無此問題），bpmnkit 路線的引擎**自稱模擬器、沒有 snapshot**；兩者都可用「**事件日誌為真相、喚醒時重播**」補上，bpmnkit 的重播已在 workerd 實測通過（強制驅逐 3 次、副作用不重複）。JavaScript script task 在 Workers 上兩條路線都不能用；記憶體內計時器在 DO 驅逐時會遺失。

---

## 1. 現況事實（兩個 repo）

### 1.1 工廠流程與工作項

| 項目 | 事實 | 出處 |
|---|---|---|
| 階段骨架 | P0 納管 → P1 現況分析 → P2 文件化 → P3 安全網 → P4 維護改善 → P5 演進（選用，可回 P0） | `docs/29-brownfield-adoption-playbook.md` §6 |
| 人類閘門 | HG0–HG7；簽核為結構化留言 `<!-- factory:hg id=… state=signed evidence=… -->`，由 `src/hg/parse.ts` 解析 | `docs/29` §8、`src/hg/parse.ts` |
| 機器可讀模板 | `templates/factory/{S,M,L}.yaml` ＋ `templates/index.json` | `src/process/registry.ts` |
| 工作項 | **一張 GitHub Issue ＝ 一個歸戶單位**；以 `前置工作項` 欄位（`#N`）串接 | `ADR-022` §1 |
| 開單入口 | ① Backstage `backstage/templates/factory-work-item/template.yaml` ② Issue Form `.github/ISSUE_TEMPLATE/factory-work-item.yml` ③ Scoreboard `/scoreboard/submit` → `POST /api/v1/submissions` | — |
| 格式檢查 | `src/cli/factory-issue-check.ts`：`REQUIRED_FIELDS = ['task_type','requirement','acceptance']`＋3 個 DoD 勾選字串 | — |
| 任務類型 | agent-add-tests／fix-bug／update-deps／write-docs／write-spec／analyze／propose-skill／pbt-audit（＋onboard） | `factory-run.yml` input `task_type` |

### 1.2 GitHub Actions

- `.github/workflows/factory-run.yml`：**1733 行**、**僅 `workflow_dispatch`**、job `timeout-minutes: 185`（`factory-run.yml:101`）、agent step 上限約 115 分、N-version 矩陣 a/b、concurrency `factory-<repo>-<issue>`（不取消進行中）。
- 觸發路徑：Backstage → dispatch；Issue 貼 `factory/approved` → `factory-issue-check.yml` → `gh workflow run`；Scoreboard 送單 → App REST dispatch（`factory-scoreboard/src/lib/submit-service.ts`）；Scoreboard webhook 轉送站 → `factory-stage-finalize.yml`／`factory-nversion-pick.yml`（`factory-scoreboard/src/lib/github-webhook.ts`）。無 `repository_dispatch`、無 `workflow_call`。
- 身分：GitHub App `softwarefactory-bot`（App id 4630527），token 由 `secrets.FACTORY_APP_PRIVATE_KEY` mint。
- `factory-run.yml:188` 註解：catalog／risk-paths／templates／skills 一律從**目標 repo 的 trunk（`software-factory`）**讀取（與 §7 的漂移問題相關）。

### 1.3 狀態與 Scoreboard

- 機制 repo：**無資料庫、無佇列、無工作流引擎**；狀態在 GitHub（Issue、label、PR、結構化留言）——`ADR-001`。
- Scoreboard：Astro 7.3.1 ＋ `@astrojs/cloudflare` 14.3.0 ＋ React 19.3.1 ＋ `@xyflow/react` 12.12.0；Cloudflare Workers ＋ D1（7 支手寫 SQL migration，無 ORM）；`output: 'server'`。
- **沒有任何 SSE／WebSocket／輪詢**；`/scoreboard/process/live/*` 於 request 時抓 `snapshot-latest` release（`src/lib/process/snapshot.ts`，逾時 5 s）。
- 機密只在 Worker 端：`GITHUB_APP_PRIVATE_KEY`、`SCOREBOARD_TOKEN`、`GITHUB_WEBHOOK_SECRET`、`TENANT_ACCESS`。
- 專案自訂 Worker bundle 閘門 <1 MiB 壓縮（`scripts/check-bundle-size.mjs`，`pnpm size`）。
- 全庫 `bpmn` 零命中；無 Temporal／Inngest／Step Functions／DO／Queues。

### 1.4 既有 ADR 的立場（BPMN 提案會碰到的條文）

| ADR | 條文 | 與 BPMN 提案的關係 |
|---|---|---|
| `ADR-001` | GitHub 是唯一事實來源 | DO 若持有流程狀態需修訂 |
| `ADR-023` §3 | 選 React Flow 的判準①「沒有內建執行引擎」；Rete.js／LiteGraph 的執行引擎「在本案是負債」 | 正面衝突 |
| `ADR-023` §4 | v1 不可派工、不可簽核 | 正面衝突 |
| `ADR-023` 重評觸發條件 #1 | 「需要在**瀏覽器內執行**流程 → 重評 Rete.js」（`ADR-023` 第 109 行） | 本提案即觸發此條，但評估對象改為 BPMN |
| `ADR-024` §1／§2 | 「執行」＝產生待開清單；UI **不得**呼叫 `factory-run`、不得貼 `factory/approved` | 正面衝突 |
| `ADR-024` §5 | 冪等判定只看 Issue 既有欄位，**不新增隱藏標記** | 衝突（multi-instance＋重做無法以既有欄位區分） |
| `ADR-025` | meta-contract（四種 step kind、task_type 白名單、P0–P5、必含 HG1/2/4/5/6）；自訂閘門單簽核者、`signers` 為 GitHub 帳號 | 需映射到 BPMN 擴充屬性 |
| `ADR-026` | 系統 spec 歸專案 repo `factory/system.yaml`；名冊 `processes/registry.json`（**尚未建立**） | 需改寫為 BPMN 對應 |

另：兩 repo 的 step-kind 詞彙不一致——機制 repo `src/process/spec.ts` 只有 `['human','work-item']`，Scoreboard `src/lib/process/types.ts` 有 `['workitem','human','gate','decision']`，`ADR-025` §3 宣告四種。

### 1.5 刪除 process.yaml 後仍存活的 YAML 讀取者

grep 結果：刪除 `src/process`、`src/graph`、`factory-graph`／`factory-next`／`factory-snapshot`／`factory-template` 之後，`src/`、`.github/workflows/` 內**唯一**仍讀模板 YAML 的是 `src/cli/factory-hg.ts`——`import { loadTemplate } from '../process/spec.js'`（第 21 行）、`loadTemplate(readFile(options.templatePath))`（第 186 行），用途是取得 `gate_defs.signers` 供自訂閘門驗證（`src/hg/parse.ts:279` `signersOf`）。

---

## 2. 實測 1 — bpmn.io／paed01 路線於 workerd ＋ DO

- 環境：2026-10-25；wrangler 4.146.0／workerd 1.20261001.1、compat date 2026-09-03、`nodejs_compat`、SQLite-backed DO。
- 版本：bpmn-engine 26.0.5、bpmn-elements 18.1.2、bpmn-moddle 10.3.1、moddle-context-serializer 6.0.2、smqp 15.0.0、@0dep/bpmn-extensions 1.0.1（feelin 8.2.0）、bpmn-js 18.31.1、esbuild 0.28.2。
- 暫存目錄：`/var/folders/lj/x1ztfvqx1m54mvl8hv1l51qr0000gq/T/tmp.WNxXa0NwFR`（`probe/` workerd probe、`proj/` Scoreboard 暫存副本〔已刪 `.env` 與 token 檔〕、`out/` bundle、`docs/` 抓下的文件、`timers.md`、`api.md`）。

### 2.1 執行相容性

- **bpmn-engine 26.0.5 於 Worker 啟動即崩潰**：`src/index.js:15-16` 在模組載入時執行 `createRequire(fileURLToPath(import.meta.url))` 並 `require('../package.json')`；workerd 錯誤 `The "path" argument must be of type string or an instance of URL. Received undefined at fileURLToPath`。CJS build（`lib/index.cjs:165`）相同。
- 把上述兩行 patch 成常數後，於 stateless Worker 與 DO 皆可執行：userTask → `getState` → `ctx.storage.put` → `new Engine().recover()` → `resume()` → `signal()` → end ✔；`${environment.variables.go}` 條件 ✔；FEEL 條件 `= go and n > 1`（@0dep）✔；PT1S 計時器 ✔（約 1010 ms）。
- **JS scriptTask 與 `language="javascript"` 條件失敗**：`The runInThisContext method is not implemented`。唯一以字串產生程式碼者為 `bpmn-engine/src/JavaScripts.js`（`node:vm` `Script`）；bpmn-elements、smqp、bpmn-moddle、moddle-context-serializer、@0dep、feelin、lezer **均無** `eval`／`new Function`／`vm`。
- Workers 禁止 `eval()`／`new Function`（[web-standards](https://developers.cloudflare.com/workers/runtime-apis/web-standards/)）；`node:vm` 為非功能 stub，`node:events` 支援（[nodejs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)）。
- **只用 bpmn-elements（不含 bpmn-engine）的 bundle 沒有任何 `node:*` import**。
- 先例：[0dep.se/run](https://0dep.se/run/) 直接使用 bpmn-elements（非 bpmn-engine）＋@0dep 擴充＋bpmn-js，純瀏覽器、無持久化。未找到 bpmn-engine 跑在 Cloudflare／DO 的先例。

### 2.2 Bundle 大小（esbuild minify，gzip -9）

| 入口 | raw | gzip |
|---|---|---|
| `bpmn-engine` | 337 KiB | 80.0 KiB |
| bpmn-engine ＋ @0dep/bpmn-extensions | 548 KiB | 149.6 KiB |
| @0dep/bpmn-extensions 單獨（feelin 57.9 KiB gz） | 236 KiB | 76.5 KiB |
| bpmn-elements ＋ bpmn-moddle ＋ serializer | 319 KiB | 74.3 KiB |
| bpmn-elements ＋ serializer（無 moddle） | 250 KiB | 58.0 KiB |
| bpmn-js Modeler（瀏覽器） | 567 KiB | 165.2 KiB |
| bpmn-js Viewer／NavigatedViewer | 185／194 KiB | 52.9／55.9 KiB |

- **Scoreboard 真實 build**（暫存副本，以其 `check-bundle-size.mjs` 量測）：基線 **588.3 KiB** 壓縮；加入匯入 bpmn-engine 的 DO 後 **726.1 KiB**（+137.8 KiB）。
- 文件過期：`astro.config.mjs` 註解寫 441 KiB（實測已 588 KiB）；`check-bundle-size.mjs` 寫「3 MiB free／10 MiB paid 壓縮」，Cloudflare 現行為 **64 MiB 未壓縮、無壓縮上限**（[limits](https://developers.cloudflare.com/workers/platform/limits/#worker-size)）。1 MiB 為專案自訂門檻。

### 2.3 狀態、計時器與定義變更

- `getState()` 每個 definition 內含 `source`（序列化定義）→ **每個實例自帶定義副本**。實測：start→userTask→end 6,497 B（`source` 1,582 B），首次 resume 後 8,033 B，30 次 recover/resume 後持平；40 個 userTask 線性流程 31.8–34.7 KB。DO 單值上限 2 MB。
- 移除 `source`、於 recover 時提供定義：只在使用預先序列化的 `sourceContext` 時可行；以 XML `source` 會丟 `Cannot read properties of undefined (reading 'id')`（[#137](https://github.com/paed01/bpmn-engine/issues/137) 相關）。
- 速度（Node 22，**非 workerd**）：recover＋resume＋signal＋getState 中位數 5.1 ms、p95 8.5 ms、max 12 ms；冷啟 XML 解析＋執行 22 ms。workerd 內 CPU **未驗證**；Free 方案 CPU 10 ms／request。
- 計時器：預設使用全域 `setTimeout`；**延遲 ≥ 2,147,483,647 ms（約 24.8 天）時不排程**——P30D 實測 `{delay:2592000000, expireAt:…, hasRef:false}`，永不觸發。resume 時沿用較早的 `expireAt`，已過期者立即完成（[#152](https://github.com/paed01/bpmn-engine/issues/152)）。DO 內有待決 `setTimeout` 會**阻止 hibernation**、使 DO 常駐計費最長 15 分（[lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)）。timers → DO alarm 轉接層**未實作、未驗證**。
- **定義變更**（sourceContext）：在等待中 task **之後**插入新 task → resume 正常走到新 task；**更名等待中 userTask 的 id → 實例靜默卡住**（postponed=[]、不結束、無錯誤）。無內建遷移 API。
- 另觀察：流程已完成後 `await engine.stop()` 不 resolve（Node，未追查）。

### 2.4 Durable Objects 平台事實

| 項目 | 事實 | 出處 |
|---|---|---|
| 儲存 | SQLite 後端每 DO 10 GB（Free 帳號 5 GB 總量）；key＋value ≤ 2 MB；SQL 敘述 ≤ 100 KB | [limits](https://developers.cloudflare.com/durable-objects/platform/limits/) |
| CPU | 每 request 預設 30 s、可設至 5 min（`limits.cpu_ms`）；每個 request／WS 訊息重置；alarm handler wall time 15 min | 同上 |
| 記憶體 | 128 MB／isolate，多個 DO 可共用 isolate | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/#memory) |
| Alarms | 每 DO 一個 `setAlarm`（新值覆蓋）；`alarm()` at-least-once、最多重試 6 次（指數退避自 2 s）；同 DO 同時只跑一個 | [alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) |
| WebSocket Hibernation | `ctx.acceptWebSocket(ws, tags)`（≤10 tags）、每 DO ≤ 32,768 條；`serializeAttachment` ≤ 16,384 bytes；閒置約 10 s 後 hibernate（前提：無待決計時器）；喚醒時重跑 constructor | [websockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)、[state](https://developers.cloudflare.com/durable-objects/api/state/) |
| PITR | SQLite-backed DO 可用 `getBookmarkForTime()`＋`onNextSessionRestoreBookmark()` 把**單一 DO**（SQL 與 KV 資料）還原到過去 **30 天**內任一時點 | [sqlite-storage-api](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) |
| 方案 | **Free 方案可用 DO（僅 SQLite 後端）**：100k req/day、13,000 GB-s/day、5M rows read、100k rows written/day；Paid：$0.15/M req、$12.50/M GB-s（以 128 MB 計）；`setAlarm` 計 1 row write；WS 入站訊息 20:1 計費 | [pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |

PITR 的界線（由文件推得）：還原只倒回 DO 自身資料，**GitHub 上的事實不會跟著倒回**；以 `deleted_classes` migration 刪除 class 不屬 PITR 保護範圍（未實測）。

### 2.5 Astro adapter 與 DO 同 Worker 部署

- 現況：Scoreboard `wrangler.jsonc` **無 `main`**（註解稱宣告 `main` 會讓 build 失敗）、無 `durable_objects`、無 `migrations`。
- Astro 文件：`workerEntryPoint` 已移除；改為 wrangler `"main": "./src/worker.ts"`，自 `@astrojs/cloudflare/handler` 匯出 `{ fetch: handle }` 並同檔 `export class MyDurableObject`（[Astro Cloudflare](https://docs.astro.build/en/guides/integrations-guide/cloudflare/)）。
- **已實測（暫存副本，adapter 14.3.0／Astro 7.3.1）**：`main: ./src/worker.ts`＋`durable_objects.bindings`＋`migrations[new_sqlite_classes]` → `astro build` 成功，`dist/server/wrangler.json` 保留 binding 與 migration，`entry.mjs` 匯出 `{ ProcessInstance, default }`；`wrangler dev` 下 DO 執行 bpmn-engine 並於第二次 request 自 storage 恢復，Astro 路由照常服務。→ 既有註解所指的失敗是「指向 build 產物」，不是 source entry。
- 另一路：獨立 Worker 以 `durable_objects.bindings[].script_name` 綁定（本機需另一個 `wrangler dev` 程序）。
- build 警告 `IMPORT_IS_UNDEFINED default … bpmn-moddle/dist/index.js` 無害（引擎用 `BpmnModdle ?? default`）。

### 2.6 GitHub 身分與 Cloudflare Access

- GitHub App **user access token**（web application flow／device flow）所發請求「歸屬於該使用者」，留言顯示使用者頭像＋App 徽章；權限為「使用者可及範圍 ∩ App 權限 ∩ App 安裝範圍」；每位使用者須授權 App；token 預設 **8 小時**過期、可 refresh（[on behalf of a user](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user)、[generating](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)）。
- 帶 App 徽章的使用者留言是否被 `src/hg/parse.ts` 視為本人簽核：**未驗證**。
- Cloudflare Access JWT 含 `email`、`sub`、`identity_nonce` 等；自訂 claim 只對 SAML/OIDC IdP、約 1 KB 截斷；GitHub IdP 為 OAuth app，**文件未記載 JWT 含 GitHub login**（[application token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)、[GitHub IdP](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/github/)）。`/cdn-cgi/access/get-identity` 是否含 GitHub login：**未驗證**。Scoreboard 目前未使用 get-identity，也未使用 user-to-server token。

---

## 3. 實測 2 — bpmnkit

完整報告：`/var/folders/lj/x1ztfvqx1m54mvl8hv1l51qr0000gq/T/tmp.eOkVGdgv7J/REPORT-bpmnkit.md`（同目錄 `pkgs/` 安裝、`out/` bundle、`probe/` workerd Worker＋DO、`rt*.mjs`＋`fx/` 往返測試）。來源：[bpmnkit.com](https://bpmnkit.com/)、[github.com/bpmnkit/bpmnkit](https://github.com/bpmnkit/bpmnkit)。

### 3.1 專案概況

- 自述「The complete TypeScript toolkit for Camunda 8 process automation」；全程 Camunda 8／Zeebe 導向（`zeebe:taskDefinition`／`ioMapping`／`loopCharacteristics`／`subscription`）。
- 建立 2026-02-18（約 8 個月）；12★、2 forks、289 commits；貢獻者 urbanisierung 227、github-actions 61、外部 1 → **實質單一維護者**；README 標「AI-assisted: claude」。
- 授權：全部 MIT（`@bpmnkit/camunda-docspack` 為 CC-BY-SA-3.0）；**無浮水印／署名條款**（`@bpmnkit/plugins/watermark` 為選用、顯示自己的 logo）。
- 29 個 npm 套件；主要：core 1.6.1、editor 1.5.1、canvas 1.0.2、engine 1.3.0、feel 1.1.1（宣稱 DMN TCK 94%）、plugins 1.2.2、cli 1.4.0；reebe-wasm 0.2.0 為實驗性。
- 節奏：自 2026-03-15 約每週發版（engine 34 版、editor 40 版），最新 2026-10-20。週下載（10/16–22）：core 242、editor 80、engine 40、canvas 67；對照 bpmn-js 187,966。
- 成熟度訊號：362 個測試檔、14 個 CI workflow（含 dmn-tck）；Core tier 12 個套件（含 engine）遵循 semver（[stability](https://bpmnkit.com/docs/getting-started/stability)）。

### 3.2 編輯器與檢視器

| 入口（esbuild minify，gzip -9） | min | gzip |
|---|---|---|
| canvas 檢視器 | 288 KiB | 77.0 KiB |
| `BpmnEditor` 單獨 | 395 KiB | 101.6 KiB |
| editor ＋ HUD ＋ SideDock ＋ 通用 config-panel | 584 KiB | 147.6 KiB |
| ＋ config-panel-bpmn（帶 Camunda connector 目錄） | 3.0 MB | 577 KiB（應避免） |

- 技術：純 TypeScript、命令式 DOM/SVG；無 React、無 Web Components。Node 無 DOM 時 import 成功（可放 Astro island，於 client 端建構）；**實際 Astro/React 掛載未於瀏覽器驗證**。
- 擴充：`createConfigPanelPlugin(...).registerSchema(elementType, schema, adapter)`；非 moddle descriptor，自訂屬性存於 `el.unknownAttributes`／`el.extensionElements`；渲染出的 DOM／class 名稱**非公開 API**。
- **往返解析再匯出**（core 1.6.1 parse→export，兩邊再以 bpmn-moddle 讀回比對）：
  - Camunda Modeler 風格檔（collaboration、lane、group、annotation、`zeebe:*`、`factory:taskType|gate|phase` 屬性、`<factory:config>` 擴充元素、bioc 顏色）：**261 個 key 0 差異**，bpmn-moddle 0 警告，匯出冪等。
  - bpmn-js `complex.bpmn`（169 KB）：67／3593 差異，全為省略顯式 `="false"` 預設值與空 `<extensionElements/>`（無害）。
  - `activity-markers-combination.bpmn` 拋出 `Missing required attribute targetNamespace`（比 bpmn-js 嚴格）。
  - `Bpmn.export` 會重排位元組（108 行檔案 187 行變動）；**`exportPreserving(original, defs)` 未變更時位元組相同、更名後只有 1 行 diff**。
  - headless 編輯操作（move／rename／connect／changeType）保留全部 `factory:*` 屬性與擴充元素。
- 未驗證：`<factory:*>` 擴充資料放在 **`<bpmn:process>` 層級**時是否保留（上述測試的 `<factory:config>` 所在層級未記錄）。

### 3.3 引擎（@bpmnkit/engine 1.3.0）

- README 自述：模擬 BPMN 執行「for tests, demos and debugging, **NOT for running production processes**」。
- root 入口無 `eval`／`new Function`／`node:vm`；`scriptFormat="javascript"` 的 script 被**忽略**（task 完成、程式未執行）；條件一律以 FEEL 評估。`./wasm-runner` 入口使用 `node:fs`＋`createRequire`，root 不載入。
- API：`deploy({bpmn})`、`start(id, vars)`、`registerJobWorker(type, handler)`（`job.complete/fail/throwError` 可延後呼叫 → 用來讓 user task 等待）、`deliverMessage(name, vars, correlationKey)`、signal、`onChange` 事件流（element:entering/entered/leaving/left、variable:set、job:created、feel:evaluated、process:completed/failed）。
- 支援：exclusive／parallel／inclusive／event-based gateway、計時器、message／signal／error／escalation／compensation／terminate、boundary event、embedded／event subprocess、transaction、call activity、parallel／sequential multi-instance、DMN。
- **已驗證的語意缺口**：(a) 沒有註冊 worker 的 userTask／serviceTask **立即自動完成**；(b) 獨立 `receiveTask` **不等待** message（需改用 intermediate message catch event）；(c) inclusive／complex join 不等待；conditional event 不執行；(d) job 物件沒有 elementId；(e) 未設 `zeebe:taskDefinition` 時 job type 預設為元素類型（如 `userTask`）。
- **持久化：無 getState／serialize／recover API**；token、scope、subscription、timer 均為私有記憶體欄位；計時器用模組全域時鐘（`setTimerClock` 未從 root 匯出）→ 無耐久計時器。
- **workerd 實測**（wrangler 4.146.0、compat 2026-09-03、SQLite DO）：
  - stateless Worker：2 個 repo 的 multi-instance subprocess → message catch（錯誤 correlationKey 被拒、正確者被接受）→ userTask → FEEL gateway `=approved = true and count(results[item != null]) = 2 and conclusion = "success"` → 完成。
  - DO：以**事件日誌重播**實作恢復（`ctx.storage.kv` 存 start 變數＋以 `(elementId, loopCounter)` 為鍵的 job 結果＋message；重播時 worker 回傳日誌中的結果、不執行副作用）。流程 start → `ctx.abort()` 驅逐 → message → 驅逐 → 完成 userTask → 驅逐：每次 `replayed=true`、終點正確、**副作用計數維持 3（無重複 GitHub 呼叫）**、日誌 378 bytes。
  - Bundle：probe Worker minify 312.7 KiB／gz 86.0 KiB；瀏覽器 engine＋core 299 KiB／gz 80.2 KiB。

### 3.4 工具

- `lintDiagram(defs)` 回傳純資料報告，Node 與瀏覽器皆可（core-lint 91.5 KiB gz）；可對映 `.bpmnlintrc`；`@bpmnkit/core/node` 可載入真正的 bpmnlint（僅 Node）。**未見自訂規則 API**（未驗證「確實沒有」）→ `factory:*` 規則需自寫 TypeScript。
- fluent builder ＋ Sugiyama auto-layout；builder 選項無自訂屬性欄位（未知選項靜默丟棄）→ `build()` 後設定 `el.unknownAttributes`＋`defs.namespaces`（已驗證可正確匯出）。另有 `semanticHash`／`diffSemantics`、`generateProcessTypes`、LLM 用 compact 格式。

---

## 4. 先例 — CamundaSagaPatternExample（WanderSaga）

- 位置：`/Users/cfh00805122/lab/playground/CamundaSagaPatternExample`；線上：[wandersaga.philipz.workers.dev](https://wandersaga.philipz.workers.dev/)。
- 技術：`@bpmnkit/engine` ^1.3.0 ＋ Hono ^4.13.14，部署於**一般 Worker**（`wrangler.jsonc`：`main: src/index.js`、compat 2026-10-26、`nodejs_compat`、Static Assets、Observability 100% 取樣）；**無 DO、無 D1**。
- 流程 `Models/BookHolidaySagaPatternV3.bpmn`：平行預訂（BookFlight／BookTrain／BookHotel）→ user task 確認 → exclusive gateway → 取消時拋出補償事件，引擎依逆序呼叫 Cancel* 補償處理器。
- 已在 production 展示的模式（讀碼）：
  - **user task ＝「握住 job 不 complete」**：`registerJobWorker('userTask', job => booking.pendingUserJob = job)`，使用者決策時 `job.complete({confirm})`（`src/index.js:87-90`、`194-200`）。
  - `instance.onChange` → 廣播到 WebSocket／SSE（`src/index.js:132-150`、`157-211`）。
  - 載入轉接層 `src/bpmn.js`：`camunda:topic` → `zeebe:taskDefinition`（第 12–23 行）、JUEL `${…}` → FEEL `= …`（第 25–35 行）。
- **沒有證明的事**：
  - 實例存在模組層級 `const bookings = new Map()`（`src/index.js:10`），**無持久化**、無驅逐恢復、無跨週存活、無多人協作。
  - HTTP 備援路徑（`POST /api/bookings` 後再 `GET /api/bookings/:id/events` 或 `POST /decision`）依賴同一 isolate 的記憶體；後續 request 落到不同 isolate 時會得到 404 `Booking not found`（**已實測證實，見 §4.1**）。
- 測試：README 記載 32 個測試全數通過，含由 `specs/quint/REPORT.md`、`specs/lean/REPORT.md` 形式化反例轉成的 CE-1～CE-6（本次**未重跑**）。

### 4.1 Production 資源用量實測（2026-10-26）

帳號方案：**Workers Paid**（使用者於 Cloudflare 後台確認，2026-11-01 續約）。部署版本 `6ac26aa7`（另見早期版本 `35d314df`、`667de229`、`3cb98be3`）。

**資料來源**

1. Cloudflare GraphQL Analytics `workersInvocationsAdaptive`（`scriptName: "wandersaga"`，查詢過去 30 天；僅 2026-10-26 有資料，與 09:50 首次部署吻合）。cpuTime 單位為微秒，下表換算為毫秒。
2. 對正式站送少量受控流量，同時以 `wrangler tail --format json` 記錄逐請求的 `cpuTime`／`wallTime`（毫秒）：5 次 WebSocket Saga（3 次確認、2 次取消）、1 次 HTTP 備援流程、4 次 SSE 閒置測試。腳本：`/tmp/wandersaga-load.mjs`；原始 tail：`/tmp/wandersaga-tail.jsonl`（暫存，未入庫）。
3. 未取得：wrangler OAuth token 無計費與 Workers Observability 查詢權限（API 回 10000 Authentication error），故無逐請求 Observability 日誌；方案由使用者確認。

**當日彙總（Analytics，06:20 UTC 為止）**

| outcome | 請求數 | CPU P50 | CPU P99 | wall P50 | CPU 合計 |
|---|---|---|---|---|---|
| success | 61 | 7.2 ms | 55.0 ms | 8.5 ms（WS 小時桶約 2.9 s） | 約 1.0 s |
| clientDisconnected | 5 | 730.7 ms | 1,414.0 ms | 約 6,010 s（約 100 分鐘） | 約 3.64 s（**約 78%**） |
| loadShed | 1 | 3.1 ms | 3.1 ms | 32 s | — |

當日合計約 67 次請求、約 4.6 s CPU。`loadShed` 1 筆出現在早期版本 `667de229`（原因未查）。

**逐請求實測（tail）**

| 路徑 | CPU（ms） | wall | 備註 |
|---|---|---|---|
| `GET /api/ws`，完整 Saga（確認路徑） | 26、31、35 | 約 1.95 s | 每次 22 個事件 |
| `GET /api/ws`，完整 Saga（取消＋3 個補償） | 25、38 | 約 3.7 s | 每次 32 個事件 |
| `POST /api/bookings`（`Bpmn.parse`＋建立引擎＋啟動） | 冷 10–14，熱 3 | 3–15 ms | 前幾次落在新 isolate |
| `GET /events`、`POST /decision`（實例不在此 isolate） | 0–3 | — | 404／400 |
| 非受控流量的 SSE 連線（閒置等待決策） | 4 | 12.5 s | 約 0.3 ms CPU／秒 |

**判讀**

- **bpmnkit 引擎在 workerd 的成本（第一手數據）**：熱狀態下解析 BPMN＋建立引擎＋啟動約 **3 ms**；之後每推進一個 BPMN 節點（含 FEEL 判斷、job 完成、序列化並送出 WS 事件）約 **1 ms**。一次完整 Saga 25–38 ms，大致與事件數成正比。樣本數小（5 次 WS），僅供量級參考。
- **單次 Saga 已超過 Free 方案每次請求 10 ms 的上限**；在 Paid 帳號上全部成功（Paid 預設 30 s／請求）。
- **clientDisconnected 的 5 筆是 SSE 輪詢迴圈**：`src/index.js:256-266` 每 500 ms 醒來一次，直到使用者決策或斷線；換算約 0.3 ms CPU／秒，掛 100 分鐘即 0.7–1.4 s，與 Analytics 一致。閒置連線佔了當日 CPU 約 78%。
- **HTTP 備援路徑跨 isolate 失效已證實**：同一 bookingId 在 POST 之後的 3 次 `/events` 有 2 次 404，3 次 `/decision` 全部 400（`No pending user decision for this booking`）；另 4 次「POST 後立即開 SSE」全部 404。純記憶體狀態不能跨請求，需要 DO 這類「一個實例一個固定的家」的機制。

### 4.2 優化後再測（2026-10-26 19:53，版本 `be1d916f`）

WanderSaga 於 commit `f83056b`（perf：BPMN AST 快取＋事件驅動 SSE）與 `1ffc6e6`（Smart Placement）後重新部署。以相同腳本、相同方法再測（8 次 WS Saga：5 次確認、3 次取消；1 次 HTTP 備援；SSE 閒置 30 s）。

**改了什麼（`git diff 60abde2 1ffc6e6`）**

| 項目 | 做法 | 出處 |
|---|---|---|
| BPMN AST 快取 | `getOrPrepareDefinitions(xml)` 以 XML 字串為鍵、模組層級 `Map` 快取「解析＋`camunda:topic`→`zeebe` 轉接＋JUEL→FEEL」後的 definitions；每個 booking 只做 `new Engine()`＋`engine.deploy({ bpmn: defs })` | `src/bpmn.js` |
| 模組初始化預熱 | 模組頂層呼叫 `getOrPrepareDefinitions(V3_BPMN_XML)`，解析成本移到 isolate 啟動時 | `src/index.js:6-7` |
| 事件驅動 SSE | `Promise.race([新事件, stream.sleep(30000)])`：只在有新事件、client 中斷或 30 s keepalive 時醒來（原為每 500 ms） | `src/index.js` SSE handler |
| 中斷即釋放 | 監聽 `c.req.raw.signal` 的 `abort`，立刻喚醒迴圈並移除 listener | 同上 |
| 完成後清理 | 流程完成 5 分鐘後以 `setTimeout` 從 `bookings` Map 移除 | `src/index.js` `process:completed` |
| Smart Placement | `wrangler.jsonc` `placement.mode: "smart"` | `wrangler.jsonc` |

**前後對照（tail 逐請求 CPU，毫秒）**

| 路徑 | 優化前（`6ac26aa7`） | 優化後（`be1d916f`） |
|---|---|---|
| WS Saga，確認（22 事件） | 26、31、35 | 20（第一次）、10、10、11、16 |
| WS Saga，取消＋補償（32 事件） | 25、38 | 13、14、13 |
| `POST /api/bookings` | 冷 10–14，熱 3 | 6、13 |
| SSE 閒置 | 4 ms／12.5 s（約 0.3 ms／秒，非受控流量） | **3 ms／30.2 s**（約 0.1 ms／秒，含建立連線） |

Analytics（06:40 UTC 之後的 7 筆 success）：CPU P50 13.9 ms、P99 32.5 ms。

**判讀**

- 完整 Saga 的 CPU 中位數約從 **31 ms 降到 13 ms（約 -58%）**；換算每個 BPMN 事件約 **0.4–0.5 ms**（熱狀態），先前約 1 ms。
- 降幅大於「省下一次 XML 解析」（約 3 ms）所能解釋的，部分可能來自 isolate 暖機與 JIT 狀態差異；樣本小（8 次），**確切歸因未驗證**。
- 閒置 SSE 不再定時醒來，閒置成本降為原本約三分之一以下；100 分鐘的閒置連線估計從 0.7–1.4 s 降到數十毫秒量級（推估）。
- **仍超過 Free 的 10 ms**（10–20 ms），結論「需要 Workers Paid」不變。
- **未改變的問題**：HTTP 備援跨 isolate 依然失效（3 次 `/events` 為 404、200、404，3 次 `/decision` 全部 400），因為狀態仍只在 isolate 記憶體；WS 流程結束後仍由 client 關閉連線。
- **Smart Placement 對此 Worker 預期無效**：Smart Placement 依據 subrequest 的後端位置調整執行位置，而 WanderSaga 的 subrequests 為 0（Analytics `sum.subrequests = 0`）。
- **`setTimeout` 清理在 Worker 上不保證執行**：timer 依附在請求生命週期上，連線結束後 isolate 可能被回收；在 DO 中長 timer 則會阻止 hibernation 並持續計費 duration。

**對 BPMN 設計的含意（已反映於 `ADR-028` §1、§4.2、§4.7）**

1. 日誌重播成本約與事件數成正比：以優化後每事件約 0.4–0.5 ms 推估，重播 200 筆事件的日誌每次冷喚醒約需 100 ms CPU（**未實測**；重播不含 WS 序列化，可能更低），仍遠超 Free 上限；正式環境需 Workers Paid（帳號已是 Paid）。
4. 解析過的 definitions 應以「模板 id＋版本＋內容雜湊」為鍵在模組層級快取，跨 booking（在 DO 中為同一 isolate 內的多個 DO）共用，且必須視為唯讀。
5. 延後的清理工作在 DO 中一律用 alarm，不用 `setTimeout`。
2. DO 醒著時應把引擎實例留在記憶體，只有冷啟動喚醒才重播，避免每個事件都付一次完整重播成本。
3. 任何「醒來檢查」的輪詢迴圈都會持續消耗 CPU 並阻止 DO hibernation，佐證 Q19（WebSocket Hibernation）與 Q17（v1 不用計時器）。

---

## 5. 比較與選型依據摘要

| 面向 | bpmn.io ＋ bpmn-elements／bpmn-engine | bpmnkit |
|---|---|---|
| 編輯器 | bpmn-js Modeler 165.2 KiB gz；moddle 擴充生態成熟；`Bpmn.export` 類工具會整檔重排 | 147.6 KiB gz（含面板）；`exportPreserving` 1 行 diff |
| 檢視器 | NavigatedViewer 55.9 KiB gz；overlay／marker API 成熟 | canvas 77.0 KiB gz；overlay 能力**未驗證** |
| 引擎 | bpmn-elements 多年使用；有 `getState`／`recover`／`resume` | 自稱模擬器；無 snapshot；三項語意缺口 |
| workerd | bpmn-elements 可（無 `node:*`）；bpmn-engine import 崩潰需 patch | 可（實測） |
| 持久化實測 | snapshot recover 於 DO 通過（patch 後） | 日誌重播於 DO 通過（驅逐 3 次） |
| JS script | 不可（node:vm stub） | 被忽略（不執行） |
| FEEL | @0dep/bpmn-extensions（+76.5 KiB gz） | 內建 @bpmnkit/feel |
| 授權 | bpmn-js：MIT ＋ bpmn.io 浮水印須完整可見 | MIT，無浮水印 |
| 成熟度 | 多年、bpmn-js 週下載約 18.8 萬 | 8 個月、單一維護者、AI 協作、engine 週下載 40 |
| 主要風險 | 需維護 patch 或自寫 adapter；兩套擴充描述（moddle） | 維護者風險、週發版變動、Zeebe 耦合、需自建日誌重播 |

混用相容性（實測）：bpmnkit 匯出的 XML 以 bpmn-moddle 讀取 0 警告，但 bpmn-elements 端需 `zeebe:*`（@0dep 或 zeebe-bpmn-moddle）與 `factory:*` 的 moddle descriptor；反向使用時 bpmn-js 必須載入 zeebe-bpmn-moddle 且檔案須帶 `targetNamespace`。

選型依據（決策見 `ADR-028`）：①「事件日誌為真相、喚醒時重播」在兩條路線都需要（稽核、reconcile、outbox 冪等），因此 bpmnkit 缺 snapshot 不再是決定性缺點，且重播已在 workerd 實測；② 編輯器、linter、模擬、正式執行共用同一種 BPMN 方言與 `zeebe:*` 解讀，避免「編輯器合法、引擎讀不懂」；③ WanderSaga 已提供可移植的 job worker／onChange／轉接層程式碼；④ 以與引擎無關的 adapter 介面隔離，bpmn-elements 為退場方案。語意缺口改由發布時 linter 擋下。

---

## 6. 全面改用 BPMN XML 的可行性（Q42）

### 6.1 現有 YAML 檔案與 BPMN 對應

| 現有檔案 | 內容 | BPMN 對應 |
|---|---|---|
| `templates/<tenant>/<name>.yaml`、`templates/factory/{S,M,L}.yaml` | phases、gates、`gate_defs`、steps | **拆成每階段一個可呼叫流程**：`<tenant>.<name>.v<N>.P0` …；`gate_defs` → 模板 process 的 `<bpmn:extensionElements><factory:gateDef id signers scope evidence/>` |
| `processes/<system>.yaml`（ADR-026 後為專案 repo `factory/system.yaml`） | system、scale、scale_evidence、template、template_version、phases、gates、extra_steps（例：`processes/tradingbot-tw/saga-pattern.yaml`） | 專案 repo `factory/system.bpmn`：以 callActivity 依序串接採用的階段（只取 P0–P3 即只串到 P3）；extra_steps 直接畫成後接節點；`<factory:system scale scaleEvidence/>` |
| 專案 repo `factory/process.yaml` | 模組 id、paths glob、build_unit、spec、readiness＋evidence、owner、core | 同一 `system.bpmn` 的 `<factory:modules frozenAt="HG2"><factory:module …/></factory:modules>` |

範例骨架：

```xml
<bpmn:process id="tradingbot-tw.saga-pattern" isExecutable="true">
  <bpmn:extensionElements>
    <factory:system scale="S" scaleEvidence="tradingbot-tw/saga-pattern#6"/>
    <factory:modules frozenAt="HG2">
      <factory:module id="workers" paths="src/workers/**" readiness="R1"
                      readinessEvidence="…" owner="tradingbot-tw"/>
    </factory:modules>
  </bpmn:extensionElements>
  <bpmn:startEvent id="start"/>
  <bpmn:callActivity id="p0" calledElement="tradingbot-tw.saga-pattern.v1.P0"/>
  <bpmn:callActivity id="p1" calledElement="tradingbot-tw.saga-pattern.v1.P1"/>
  <bpmn:endEvent id="end"/>
</bpmn:process>
```

### 6.2 技術限制

1. **BPMN 元素 id 必須是 XML NCName**：不得含 `/`、`@`（也不得以數字開頭）。`factory/M@3` 不合法 → 命名規則改為 `factory.M.v3.P1`。
2. **`<bpmn:definitions>` 層不允許 `extensionElements`**（BPMN 2.0 schema 中 `tDefinitions` 無此子元素）→ 系統／模組／gateDef 擴充資料只能放在 `<bpmn:process>`（或元素）層級。
3. 跨檔 callActivity：bpmnkit 引擎支援 call activity（同一 engine 內已 deploy 的定義）；**多檔部署＋版本化 id 解析未驗證**。
4. 擴充資料放在 process 層級時 bpmnkit 是否完整保留：**未驗證**（§3.2）。
5. Camunda Modeler／bpmn-js 會保留但不顯示 `factory:` 資料；模組清單（glob）需專用表單編輯。
6. 模組與 scale 同檔，CODEOWNERS 無法於單一檔案內分開指派審查者。
7. 刪除 YAML 後唯一需改的既有程式：`factory-hg` 讀取 `gate_defs.signers` 的來源（§1.5）。

### 6.3 範圍外（不是流程描述，不換成 BPMN）

- `processes/registry.json`（納管名冊，平台權限；尚未建立）
- `catalog-info.yaml`（Backstage／三軸計分）
- `.github/factory/risk-paths.yml`（guardrail H1–H7）

---

## 7. 分支漂移查核（2026-10-26，`git fetch --prune` 之後）

| repo | 事實 |
|---|---|
| software_factory | 本地 `main` 與 `origin/main` 0/0；工作區僅未追蹤 `_staging/`；開啟中 PR 只有 dependabot #130（js-yaml），未碰 `docs/ADR`；ADR-027／028 編號未被使用 |
| software_factory `software-factory` trunk | 相對 `origin/main` **0 ahead／140 behind**；tip `2db6156`（2026-10-11，PR #35）；落後的 commit 中 **49 個**動到 `.github`／`src`／`.dsh`；`.github/workflows` **14 個檔案不同**（+952／−164）；trunk 上尚無 `templates/factory/*.yaml` |
| factory-scoreboard | 本地 `main` 與 `origin/main` 0/0；遠端 **`software-factory` 分支不存在**（`git ls-remote --heads origin 'software-factory*'` 無結果） |

影響：
- 依 `factory-run.yml:188`，以機制 repo 為目標的工作項會從落後 140 commits 的 trunk 讀取 skills／templates／risk-paths。
- Scoreboard 缺 `software-factory` 分支 → **不符合 README 接入條件 #2**，對它派工會在 `Verify trunk branch exists` 失敗。最可能原因：PR #90（`software-factory` → `main`）合併後被「自動刪除 head branch」刪除（**推論，未查 repo 設定**）。

處置：**使用者裁決 Q43＝(a)，已於 2026-10-26 執行**（以 GitHub REST API，無 force push）：

| 動作 | 結果 |
|---|---|
| 機制 repo：`PATCH git/refs/heads/software-factory`（`force=false`）至 main `028ad9b` | compare `software-factory...main` 由 ahead 140／behind 0 變為 `identical` |
| Scoreboard：`POST git/refs` 以 main `fb159e1` 重建 `refs/heads/software-factory` | 建立成功 |
| 兩個 repo 新增 ruleset `software-factory-trunk`（id 25876339、25876340），只含 `deletion` 與 `non_fast_forward` 兩條規則，`enforcement: active`、無 bypass | `GET rules/branches/software-factory` 兩邊皆回 `deletion`、`non_fast_forward` |

- ruleset 刻意**不含** PR／審查／status check 規則：只防止刪除與 force push，不改變既有的推送與合併流程。既有的 `main-protection` ruleset 只套用在預設分支，未修改。
- 兩個 repo 都開著 `delete_branch_on_merge: true`；trunk 受 `deletion` 規則保護後，「trunk 合回 main」的 PR 合併時不會再被自動刪除（推論：此即 Scoreboard trunk 消失的原因）。
- 重建後檢查 Scoreboard 接入條件：`software-factory` 分支上有 `catalog-info.yaml` 與 `.github/factory/risk-paths.yml`、`has_issues: true`。GitHub App 是否已安裝於 Scoreboard 無法以目前的 token 查詢（**未驗證**），但 Scoreboard 曾有工廠產出的 PR（#27 `factory/26-01-analyze`），推論已安裝。
- 之後 trunk 需要與 main 同步時，以 fast-forward（`force=false`）更新即可；`non_fast_forward` 規則會擋下任何改寫歷史的推送。

---

## 8. `1.2.0` 以來的盤點（供 Q39 方案 B）

兩 repo 的 `1.2.0` tag 皆位於 `process.yaml` 工作開始之前：

| repo | `1.2.0` commit | 至 HEAD |
|---|---|---|
| factory-scoreboard | `70e0921`（2026-10-13，PR #34） | 88 commits（44 merges）、130 檔、+16,917／−70 |
| software_factory | `6785c7f`（2026-10-17，PR #54） | 94 commits（48 merges）、63 檔、+9,152／−108 |

主要集中在 2026-10-17～22（ADR-023～026 實作）。

### 8.1 process.yaml 專屬（方案 B 中待刪）

- 機制 repo：`src/process/*`、`src/graph/*`、`src/cli/factory-graph.ts`、`factory-next.ts`、`factory-snapshot.ts`、`factory-template.ts`（含測試）、`.github/workflows/factory-snapshot.yml`、`templates/**/*.yaml`、`templates/index.json`、`processes/**`、`docs/research/fixtures/factory-graph.sample.json`。
- Scoreboard：`src/lib/process/*`（含 fixtures）、`src/components/process/*`（React Flow）、`src/pages/scoreboard/process/**`、相關測試。
- 受影響的真實使用者：`tradingbot-tw/saga-pattern`（PR #121／#122）、`agent-playground/restate-cloudflare-workers-poc`。

### 8.2 1.2.0 之後新增、BPMN 仍需保留

（以 `git cat-file -e 1.2.0:<path>` 確認為 1.2.0 之後新增）

| 項目 | 依賴者 |
|---|---|
| `src/hg/parse.ts`（294 行＋396 行測試）、`src/cli/factory-hg.ts`、自訂閘門解析（#81）、依 repo 角色驗證簽核者（#125／#127） | 閘門簽核驗證 |
| Scoreboard `src/lib/tenant-access.ts`、`page-access.ts`、`rate-limit.ts`、`retention.ts`、`origin`／`repo-slug`／`submission-input` 輸入驗證、identity-switch（#81 scoreboard） | 多人、多租戶、WebSocket 鑑權 |
| `/api/v1/process/pr`、`/api/v1/process/modules-pr` 的「存檔＝開 PR」模式（路徑白名單、伺服器端驗證） | 發布 `.bpmn` 可沿用 |
| #128 vite GHSA-587h 修補 | 安全 |
| `docs/ADR/023`～`026`、`docs/research/55-*.md` | 決策歷史（應標 superseded，不刪） |

`src/cli/factory-issue-check.ts`、`src/factory-draft/issue-body.ts` 於 1.2.0 後亦有修改（各 +26／+12 行），與 process 改動交織。

---

## 9. PoC 待驗證項目

1. bpmnkit canvas 是否支援 token／狀態 overlay 與 marker（否則改用 bpmn-js NavigatedViewer）。
2. `<bpmn:process>` 層級 `extensionElements` 內的 `factory:*` 擴充資料經 bpmnkit parse→editor→`exportPreserving` 後完整保留。
3. bpmnkit 引擎多檔部署＋版本化 `calledElement`（`factory.M.v3.P1`）解析；multi-instance callActivity。
4. 事件日誌重播在真實模板規模（S/M/L、模組 ×N）下的確定性與 CPU：冷喚醒重播的 CPU 與日誌長度的關係（§4.2 推估優化後每事件約 0.4–0.5 ms）、熱路徑（記憶體快取命中）每事件的 CPU、DO 冷喚醒頻率。帳號為 Workers Paid，上限 30 s／請求。
5. 啟動時檢查「每個 taskDefinition type 都有 handler」可防止語意缺口 (a)。
6. Astro/React island 實際掛載 bpmnkit editor（瀏覽器）；bundle 合計維持 <900 KiB（Worker 端）。
7. GitHub App user-to-server token 留言（帶 App 徽章）能被 `src/hg/parse.ts` 判為本人簽核；token 刷新流程。
8. `/cdn-cgi/access/get-identity` 是否回傳 GitHub login；否則需獨立 GitHub OAuth 對應 email→login。
9. DO PITR 還原後接 reconcile 的實際流程；`deleted_classes` 風險。
10. DO WebSocket hibernation：無待決計時器時確實 hibernate；兩個瀏覽器同時連線的快照＋增量（序號去重）。
11. bpmn-js 能開啟 bpmnkit 匯出的同一份檔案（含 `targetNamespace`、`zeebe:*`、`factory:*`）。
12. WanderSaga 測試重跑（README 宣稱 32 pass）。HTTP 備援跨 isolate 行為已於 §4.1 實測證實，不需再驗。
13. 引擎升級時以新版本重播進行中實例日誌的相容性閘門（Q40）可行性。
