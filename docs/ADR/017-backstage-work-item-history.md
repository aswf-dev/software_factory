# ADR-017：Backstage 解凍擴大——工作項歷史唯讀查閱

- **狀態**：已接受
- **日期**：2026-09-10
- **決定者**：使用者裁決（brainstorming 設計會談）
- **對應**：`ADR-009`（局部解凍）、`14-observation-period.md` §1.7（#50 凍結裁決）、`03-idp-backstage.md` §3.4

## 脈絡

ADR-009 解凍的最小路徑是「factory-work-item 模板 + LLM 草稿 + direct dispatch」。實際使用後出現一個 ADR-009 未涵蓋的需求：**表單送出後無法回溯當時填了什麼**。

現況（2026-09-10 查證 Backstage 1.53.0 / `@backstage/plugin-scaffolder@1.38.1`）：

- 內建 `/create/tasks` 清單只有 Task ID / Template / Created / Owner / Status 五欄；
- 任務詳情頁只顯示步驟、log 與本專案 template 的 `output.text`（僅含一句話需求與任務類型）；
- 完整表單原值**一直存在** scaffolder DB 的 `spec.parameters`（實測當時的任務皆有），只是沒有查閱介面；
- 內建「Start Over」讀得到完整原值，但它開的是一張新表單，不是唯讀檢視。

稽核需求是「某次是誰、在何時、用什麼 PRD 內容、開了哪張 Issue」——資料齊備，缺的只是呈現。

## 決策

**解凍範圍擴大，新增一項**：Create 頁的唯讀查閱分頁（路徑 `/create/work-items`，頁籤標籤 **Task History**——與同排的內建分頁 Templates / Tasks / Actions 一致用英文，頁面內容維持中文）。

1. **唯讀**。不新增任何寫入路徑、不新增後端端點、不擴充憑證或權限範圍。資料一律來自現有的 scaffolder read API（`listTasks` / `getTask` / `streamLogs`）。
2. **實作落在本 repo**：以 `SubPageBlueprint` 掛入既有的 `factory-draft` 前端 module（`attachTo: { id: 'page:scaffolder', input: 'pages' }`），`../backstage-app` 零改動。解析與轉換邏輯放 repo 根目錄的 `src/work-item-history/`（`narrow.ts` / `task-record.ts` / `issue-url.ts`），受本 repo 的 vitest 與覆蓋率門檻管束——該目錄在 `vitest.config.ts` 設有 **100% 覆蓋率門檻**。
3. **template 附帶一項純新增**：`output.links` 輸出 `github:issues:create` 的 `issueUrl`；`parameters`、`steps` 與原有的 `output.text` 一字未動。在此之前的任務退回解析 log 取得同一資訊。
4. **任務辨識與清單在前端完成**：scaffolder 的 list 端點只支援 `createdBy`/`status` 篩選，沒有 template 篩選，故「只留 factory-work-item」的過濾由 `toWorkItemRecords` 在前端做。

**維持凍結的其餘範圍**：Backstage 其他 Template、Scoreboard、TechDocs 部署、catalog 探索、維運承諾——全部維持 #50 與 ADR-009 的凍結狀態。

## 後果

### 正面
- 稽核閉環：工作項的「填了什麼」不再只能靠 GitHub Issue 反推或翻 DB。
- 零擴權：唯讀、無新端點、無新憑證，安全邊界與 ADR-009 相同。
- 可逆（D1 延續）：全部工件在本 repo 版控，移除擴充即完全退回 ADR-009 狀態。

### 負面
- Backstage 的維護面再擴大一塊 UI；升版時 `SubPageBlueprint` / `useTaskEventStream` 的簽章變動需重驗。
- 舊任務的 Issue 連結依賴 log 字串解析，屬於已知的脆弱點（退化後果僅為少一個連結，不是頁面損壞）。
- **`backstage/plugins/**` 不在本 repo 的任何自動化防護內**：React 元件（`SubPage.tsx` / `HistoryList.tsx` / `HistoryDetail.tsx`）既不在 `tsconfig.json` 的 include，也不在 `vitest.config.ts` 的 test scope，因此 `pnpm typecheck` 與 `pnpm test` 綠燈**對它們不構成證據**。唯一驗證是 Task 10 的瀏覽器實測（Create 頁是否真的掛出 Task History 分頁），該項是必要驗收項而非選項。這也是解析與轉換邏輯刻意留在 `src/work-item-history/`、由 100% 門檻釘住的原因。
- 套件名 `factory-draft` 現在同時裝著草稿欄位與歷史頁，名實不符；日後若再增擴充應考慮更名。
- **前端 bundle 無法消化 repo 根 `src/` 的 `.js` import 慣例**：`src/work-item-history/{task-record,issue-url}.ts` 被前端 plugin 引入，而 `src/**` 慣例是用 `.js` 副檔名互相 import（`tsconfig.build.json` 要把 `src/` emit 成給 Node 消費的 ESM，必須有副檔名）。vitest 與 tsc 都會把 `./narrow.js` 對映到 `narrow.ts`，所以本 repo 測試全綠；但 Backstage CLI 的 rspack **沒有 `extensionAlias`**，解析不到 `./narrow.js`，整個前端 bundle 失敗，且錯誤被報成 `Can't resolve '@software-factory/factory-draft'`——完全指不到真因。已確認 CLI 未提供使用者覆寫 bundler 設定的途徑，故改為讓這兩個模組**自足**（無任何相對 import），並加對抗性測試把此約束釘成紅燈。**任何日後被前端引入的 `src/` 模組都受同一約束。**
- **插件反向 import repo 根的 `src/`，跨越了套件邊界**：兩個元件（`HistoryList.tsx` / `HistoryDetail.tsx`；`SubPage.tsx` 只組路由，不取用 `src/`）以 `../../../../../src/work-item-history/*.ts` 取用純函式（backend 插件早有同模式先例）。目前可行——Backstage CLI 的 TS/TSX loader 規則沒有 `include` 限制，且 specifier 帶明確副檔名。但它依賴兩個未被任何測試釘住的消費端性質：(a) 若 CLI 收緊 loader 規則，或改用 Vite（`server.fs.allow` 以 workspace root 為界，會擋掉 repo 外的 `software_factory/src`），就會在 dev 直接壞掉；(b) 這個套件因此永遠無法獨立建置或發佈，也無法被其他 app 消費。**取捨理由**：把邏輯移進插件會讓它離開 `tsconfig` 與 vitest 的防護範圍（見上一條），而本功能的整個架構決定就是把邏輯放在受測處、元件保持笨。fallback 見 `docs/superpowers/plans/2026-09-10-backstage-work-item-history.md` Task 10 Step 3。

### 中性
- 部署形式不變：仍為 repo 外 `../backstage-app/` 的本機 `yarn dev`（D1：Backstage 不入 repo）。瀏覽器實測結果回寫 `backstage/versions.md`。
- **實測時的一個陷阱**：`PageLayout` 把分頁渲染成**相對**的 `<a href="work-items">`。從 Create 落地頁（`/create/templates`）點分頁會正確到 `/create/work-items`；但若在詳情頁 `/create/work-items/<id>` 上點同一個分頁，會變成 `/create/work-items/work-items`。這是**上游既有行為**，內建 Templates / Tasks 分頁完全相同，不是本頁引入的缺陷。實測請從 Create 落地頁點分頁。

### 實作教訓（兩個可轉移的教訓）

**一、一個守衛加了又移除，因為它可證明不會生效。** `output.links` 一度加上 `if: ${{ steps['create-issue'].output.issueUrl }}`，想避免 create-issue 失敗時渲染出 href 為空的「已建立的 Issue」連結。對實際安裝的 render 路徑查證後證明它永遠不會觸發，兩個彼此獨立的原因：

- **輸入不可達**：`NunjucksWorkflowRunner`（`@backstage/plugin-scaffolder-backend` 的實際安裝版本）在渲染 output 之前就 `if (firstError) throw firstError`；`create-issue` 沒有 `continueOnFailure`，任一步失敗即整個任務中止、根本不渲染 output，所以進到守衛時 `issueUrl` 必然存在。
- **就算可達也會被抹掉**：`render()` 對「渲染成空字串」的單一模板回傳 `undefined`，而它作為 `JSON.parse` 的 reviver 會**刪除該 key**——`if` 連同 `url` 一起消失，`filterConditionalItems` 的測試 `"if" in obj` 因此為 false，該項目照樣被保留。守衛什麼都濾不掉。

守衛與其誤導性註解已移除（UI 端本來就受保護：前端 `LinkOutputs` 濾掉無 `url`/`entityRef` 的連結，`src/work-item-history/issue-url.ts` 也先收窄再比對）。**教訓：型別存在 ≠ 行為存在。查證到 `ScaffolderOutputLink.if` 這個欄位在型別宣告中存在，不構成「這個守衛會生效」的證據。**

**二、一條斷言被刪除，因為一行註解就能讓它通過。** template 的契約測試原本用 `expect(t).toContain('links:')` 與 `expect(t).toContain("steps['create-issue'].output.issueUrl")`。實測：把真正的 `links:` 區塊整段換成一行同時含這兩個字串的 YAML 註解，測試照樣綠，而 `js-yaml` 解析出的 `spec.output` 只剩 `text`——整個功能被刪掉，測試仍會通過。該斷言已改為對**解析後的 YAML 樹**斷言：`spec.output.links` 存在、長度為 1、`url` 逐字等於該表達式，且與 `output.text` 並存。**教訓：對設定檔做字串比對，只證明「這些字出現在檔案某處」，註解裡的字同樣算數；要斷言的是解析後的結構。**

**三、前端 bundle 看不到 `src/**` 的 `.js` 慣例，而本 repo 的所有測試都看不到這個事實。** 前端 plugin 以 `../../../../../src/work-item-history/task-record.ts` 取用純函式（明確 `.ts`，rspack 解析得到），但那個檔案用 `'./narrow.js'` 引入共用工具。本 repo 的 vitest 與 tsc 都會把 `.js` 自動對映到 `.ts`，因此**1091 條測試全綠、typecheck 乾淨、覆蓋率 100%**——同時前端 bundle 完全編不起來。更糟的是錯誤訊息指向進入點（`Can't resolve '@software-factory/factory-draft'`），而不是真正失敗的那一行，容易查錯方向。**教訓：測試綠燈的範圍就是測試執行的範圍；跨出那個範圍的整合（這裡是 bundler）需要自己的驗證，而「用真實 bundler 的 resolver 走訪一次 import 圖」是最便宜的那一道。** 這個約束已由對抗性測試釘住：`src/work-item-history/{task-record,issue-url}.ts` 不得有任何相對 import。


## 未採用的替代方案

- **覆寫內建 Tasks 分頁**：等於 fork 官方頁面，其他 template 的任務歷史會被我們的實作取代，升版維護成本高。
- **新開獨立插件包**：邊界較乾淨，但需修改 `../backstage-app` 的 `package.json` 與 `App.tsx`（另一個 repo）才能註冊，改動半徑大於收益。掛進既有的 `factory-draft` module 則 `../backstage-app` 零改動。
- **在清單頁顯示 Issue 連結**：`listTasks` 不回傳 `output`，舊任務的 URL 又只在 log 中，逐列取用會造成 N+1 請求；改為只在詳情頁顯示。
