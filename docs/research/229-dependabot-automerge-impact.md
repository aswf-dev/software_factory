# 229 — 影響分析：Dependabot PR 自動合併的影響範圍與風險

> **任務類型**：`agent-analyze`（docs/20 §4 C1；in-loop 工作項依 docs/06 §4「僅可產出分析與方案，不得實作」）
> **分析對象**：docs/08 §4.4「第 1 期首要目標：Dependabot 類工作的閒置」——若對 Dependabot 類 PR 啟用自動合併（docs/06 §4.1 條件下的 on-loop 類別），影響範圍與風險為何。
> **性質聲明**：本報告**不具放行效力**。是否放寬、何時放寬屬人類決策（docs/06 §7.2、ADR-005 不對稱設計）。本報告不產生任何程式碼/設定變更。
> **日期**：2026-09-05　**資料**：docs/08 §4.2 B 基線（n=58）＋ philipz/software_factory 實測（gh 即時查詢，n=5）

---

## 1. 結論摘要（一頁）

**1. 閒置問題為真，且在本 repo 可重現。** 基線（docs/08 §4.2 B）：Dependabot PR 有 93% ≤200 行（自動合併門檻內）、36% 拖過一天才合併，Lead Time 中位數是人類 PR 的 13.6×。本 repo 實測重現同一模式：3 顆已合併 Dependabot PR 中 2 顆等待 >44 小時（#168、#169）。這是 `00` §2 所稱的純閒置，docs/08 §4.4 把它列為第 1 期首要目標，判斷成立。

**2. 「依賴更新」在政策上是可談自動合併的類別——但今天機械上無法執行。** ADR-005 與 docs/06 §4.2 明列「相依套件更新」屬 human-on-the-loop 類別，D5 自主性上限不排斥它。**然而** docs/06 §4.1 的六項附加條件，目前**沒有一項**會對 Dependabot PR 機械執行：整條判定管線（初次計分＋二次判定）掛在 Issue 與 `factory/*` 分支慣例上，Dependabot PR 兩樣都不符合（根因 R1）。對它開自動合併，等於**绕过閘門**而非通過閘門。

**3. 四個守衛缺口（缺口＝放寬前必須補的前置作業，見 §5）：**
- **R1 判定未接線**：二次判定只跑 `factory/*` 分支（factory-rescore.yml:61/82/118–120），`automergeAllowed` 對 Dependabot PR 永遠不被計算。
- **R2 H5 被直接觸及**：`dependabot.yml:14` 啟用了 **github-actions** 生態系——其 PR 必然修改 `.github/**`＝H5「守衛自身」路徑（risk-paths.yml:38–42）。實測 #134（gitleaks-action v2→v3，major）改的正是 `security-scan.yml`，9 分鐘合併。**讓「守衛的更新」零人工過關，抵觸 docs/05 §1.1 核心不變量的精神。**
- **R3 缺陷逃逸無法歸因**：docs/14:20 規定 `defect/escape` 必須可追溯到 `Closes #N` 的 factory PR——非 factory PR 不在紀律涵蓋內。於是 docs/08:72–77「自動合併缺陷率＝放寬的唯一依據」對該類別**無法計算**，docs/06 §7.2「放寬需附實際數據」與 docs/09:214「一次逃逸即收回」的棘輪都失去偵測器。
- **R4 trunk 錯位**：`dependabot.yml` 無 `target-branch` → PR 目前對準 **main**；ADR-013 裁決 main 是 release line、只接受人工 software-factory→main 合併（遷移過渡例外僅存於 ADR-013:40）。同時 `main-ruleset.json:25` 只保護 `~DEFAULT_BRANCH`——若改指 software-factory，該分支目前**無任何 required checks**，auto-merge 可能在 CI 完成前就落地。兩個方向目前都有問題。

**4. 方案結論（§4 詳述）**：
- **方案 A（GitHub 原生全量自動合併）— 拒絕**：§4.1 六條件中至少四項（on-loop 類別判定、硬性規則、行數門檻、擁有者否決）無執行點；在單人 repo `required_approving_review_count: 0` 的現況下（main-ruleset.json:39–40），它等同把 main 變成無人工閘門的自動進料口。
- **方案 B（分層閘控：npm only ＋ semver patch/minor ＋ ≤200 行 ＋ catalog 否決 ＋ 逃逸觀察窗）— 建議**，並以**方案 C（Dependabot security updates 先行試點）作為入口**。B 把「類別判定」這個 docs/06 §8 局限 3 承認的盲區收斂到可機械驗證的最小子集。
- **方案 D（以 `agent-update-deps` 取代 bot）— 拒絕**：github-actions 更新對 agent 根本不可行（停手規則 3：不得修改 CI 設定），且 agent 重做 bot 工作只增加成本、不減少任何缺口。

**5. 建議的下一步（§5 含驗收條件草案）**：先做與放寬決策**無關**、本身即有價值的前置工作項——WI-A（docs/14 歸因紀律擴充）、WI-B（trunk 對齊＋ruleset 補齊＋`action_required` 實測），再做 WI-D（ADR：是否把 Dependabot 類列入 Phase 3 候選），最後才轮到 WI-C（閘門實作，Phase 3 時序）。**在第 1/2 期紀律下（docs/09:76「第 1 期不開放自動合併」、docs/09:144「≥50 樣本」尚未滿足），本報告的建議是「補前置、不動閘門」。**

---

## 2. 證據與根因

### 2.1 基線數據（docs/08 §4.2 B，來源 `philipz/fubon-tradingbot`，n=58）

| 指標 | Dependabot | 人類 | 倍數 | 引用 |
|---|---|---|---|---|
| Lead Time 中位數 | 488 分（8.1 時） | 36 分 | 13.6× | docs/08:169 |
| Lead Time P90 | 7,904 分（≈5.5 天） | 210 分 | 37.6× | docs/08:170 |
| PR 大小中位數 | 10 行 | 314 行 | 0.03× | docs/08:171 |
| ≤200 行比例 | **93%** | 40% | — | docs/08:172 |
| 超過 1 天 | **36%**（21/58） | 0.7% | — | docs/08:173 |

docs/08:175 判定「變更極小、風險極低、卻等最久」＝純閒置；docs/08:224 把「Dependabot 類工作的閒置」列為第 1 期首要目標。**本次分析不挑戰該判定，只分析「以自動合併解消」這一手段的影響範圍。**

### 2.2 本 repo 實測（可重現）

```bash
gh pr list --state all --author app/dependabot --limit 30 \
  --json number,title,state,createdAt,mergedAt,additions,deletions,baseRefName
```

| PR | 生態系 | 大小 | base | 結局 | Lead Time | 觀察 |
|---|---|---|---|---|---|---|
| #134 | github-actions | 2 行 | main | merged | **9 分** | 改 `.github/workflows/security-scan.yml`（**H5 路徑**）、v2→v3 **major**；合併速度快於任何人閱讀 diff |
| #167 | npm | 44 行 | main | closed（過期作廢） | — | 多版本併載被關掉＝閒置的另一種形態：過期流失 |
| #168 | npm | 10 行 | main | merged | **2,646 分（≈44.1 時）** | 重現「>1 天」群 |
| #169 | npm | 10 行 | main | merged | **2,649 分（≈44.2 時）** | 同上 |
| #170 | npm | **512 行** | main | closed | — | vitest 4.1.10→4.1.11（一個版本號）的 **lockfile 膨脹**＝512 行，>200 行門檻 |

三點解讀（誠實標註樣本限制，n=5）：
1. 「>1 天」在已合併者中占 2/3，與基線 36% 同向；**閒置問題在本 repo 亦為真**。
2. **#134 證明 H5 觸及不是假設**——github-actions 生態系上線的日期（2026-08-20，dependabot.yml:1）之後的第一顆 action 更新就是守衛檔本身，且為 major。今天它靠「人類手動合併」擋著；**auto-merge 一開，這顆就會直進 main**。
3. **#170 證明 ≤200 行門檻對 npm lockfile 有意外殺傷**：基線「93% ≤200 行」以 additions+deletions 計，本 repo 有 2/5 顆超限——門檻保留是對的，但「93% 可自動合併」的樂觀估計對 lockfile 型 repo 應下修（見 §6 限制）。

### 2.3 根因 R1——判定管線與 Dependabot PR 完全未接線

`docs/06` §4.1 的六條件由 `src/scoring/score.ts` 實作：on-loop 層級（:131–133）、`factory.io/agent-automerge` 否決（:134–136）、硬性規則（:137–139）、≤200 行（:30、:140–142），輸出 `automergeAllowed`（:152）。但這個判定**只有兩個消費端**：

| 管線 | 觸發 | 對 Dependabot PR | 引用 |
|---|---|---|---|
| 初次判定（factory-issue-check → factory-judge） | **Issue** 標記 ready | Dependabot 不開 Issue → 無輸入 | docs/06 §5.1 |
| 二次判定（factory-rescore.yml） | PR 事件，**僅 `factory/*` 分支** | 分支名 `dependabot/*` → 整組跳過 | factory-rescore.yml:61、:82、:118–120 |

且 `factory-rescore` 以 `Closes #N` 或 `factory/N-*` 反查 Issue（src/cli/factory-rescore.ts:47–52）——Dependabot PR 兩者皆無，**判定在結構上無法建構**。註：workflow 內已標註此邊界（「Dependabot 等非 factory PR 的 run 不取得 secrets」，factory-rescore.yml:57–58，源自 GitHub 對 Dependabot PR 的 secrets 限制）。
→ **結論：今日若開啟 auto-merge，它不是「通過 docs/06 判定」，而是「繞過 docs/06 判定」。這是最大的單一影響：把政策中『判定先於執行』（docs/06:20「判定發生在 agent 啟動之前，由 CI 執行」）的次序反轉成『先合併、無判定』。**

### 2.4 根因 R2——github-actions 生態系 ≡ H5（守衛自身）

- `.github/dependabot.yml:14–19` 設定 `package-ecosystem: github-actions`。
- `.github/factory/risk-paths.yml:38–42`（H5）＝ `".github/**"`、`CODEOWNERS`、`catalog-info.yaml`、`.dsh/skills/**`——**任何 action bump 必然命中 H5 → risk=2 → 總分 ≥2 → 依 docs/06:96 失去 on-loop 資格**。
- CODEOWNERS:17–19 亦把 `/.github/` 全系保護——這是**機制層**（docs/02 D4 雙層防護）；但 `main-ruleset.json:39–40` 現況 `required_approving_review_count: 0`、`require_code_owner_review: false`（單人 repo 註意點：作者不能自批），**CODEOWNERS 的強制審查目前並未在 GitHub 層生效**——現在唯一的人閘是「人類手動按下 merge」。auto-merge 一開，這道閘消失。
- 疊加 GitHub「批准工作流」政策：修改 workflow 檔的 PR，其工作流 run 需維護者手動批准（`action_required`），見 [events-that-trigger-workflows – GitHub Docs](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows) 與 [dangoslen#104 的實例討論](https://github.com/dangoslen/dependabot-changelog-helper/issues/104)。若為真（**待實測，見 WI-B-3**），github-actions 生態系 PR 的 required check 會卡在 `action_required` → auto-merge 永遠等待（自動化價值＝0）或誘使人類「批准 run 就好」→ 審計變成蓋章。**無論哪種，對 Dependabot 的 actions 更新開 auto-merge 都不是捷徑。**

### 2.5 根因 R3——缺陷逃逸歸因紀律不涵蓋非 factory PR

- 放寬的**唯一**數據依據是「自動合併缺陷率」（docs/08:72–77），政策放寬程序明列「附上支持該放寬的實際數據（如：該類別連續 50 次自動合併零缺陷）」（docs/06:239–243）。
- 但 docs/14:20 的標記紀律把 `defect/escape` 定義收斂在「可追溯到某顆 **factory PR**（`Closes #N`）」；docs/14:28 的逃逸率分母是「期間內合併的**工作項**數」——Dependabot PR 既非工作項也無 Issue 連結，**不進分子也不進分母**。
- 棘輪（docs/09:214「任一自動合併類別出現缺陷逃逸，立即收回」）假設「逃逸可被偵測並歸到類別」。以現行紀律，自動合併的 Dependabot PR 出事時**無人負責把它記為 defect/escape**——收緊機制沒有感測器。
- 基線 repo 缺陷標記本就薄弱（docs/08:210：僅 1 個 `bug` 標籤，Q08-2 未完成）——即使紀律擴充，樣本也要從零累積。

### 2.6 根因 R4——trunk 錯位（ADR-013 之後新增的結構性問題）

- `dependabot.yml` 未設 `target-branch` → GitHub 預設對準 default branch＝**main**（實測 5/5 顆 baseRefName 皆為 main）。
- ADR-013:26 裁定：「main 成為 release line，只接受**人工**的 software-factory → main 合併」；ADR-013:40 的「dependabot → main 仍合併進 main」只是**遷移過渡**條款，非永恆例外。
- 因此「對 Dependabot 開 auto-merge」若照當前配置執行，就是**讓自動合併直接進 release line**，抵觸兩段式合併紀律；而 main 上的依賴變更與 software-factory 分歧後，人工同步（ADR-013:40）会在 `package-lock.json` 上高機率衝突。
- 反向修正（`target-branch: software-factory`）目前同樣有洞：ruleset 只套 `~DEFAULT_BRANCH`（main-ruleset.json:25），**software-factory 分支無 required checks**；`gh pr merge --auto` 在無保護分支上只等 PR 上的 checks 綠（且 actions 生態系另有 action_required 問題），strict 同步（branch up to date）也無人強制。
- **→ trunk 對齊是任何自動合併方案的前置，且它本身（改 `.github/**`）就是 H5 變更，必須走人類 PR。**

### 2.7 殘餘風險——閘門全綠也不消風的供應鏈暴露（誠實標註）

自動合併條件（CI 綠＋audit gate＋行數）能擋的是**已知**問題：`npm audit --audit-level=high`（test.yml:42–43）只認 npm 已公告的 CVE；全新發佈的惡意/被劫持版本（typosquat、維護者帳號遭 takeover）**沒有 CVE、測試全綠、行數極小**——恰好是 auto-merge 最順路的形態。≤200 行是**大小**閘門，不是**內容**閘門。這是所有 auto-merge 政策（含非工廠環境）的共通殘餘風險，方案 B 以「冷卻窗（版本發佈滿 N 天）＋ semver 白名單」部分緩解，無法根除。此風險的存在也是「先補歸因（R3）再開閘門」的理由——開了就必須看得見後果。

---

## 3. 影響範圍

### 3.1 受影響機制／模組

| 機制 | 影響 | 觸發點 |
|---|---|---|
| docs/06 判定管線（score/rescore/judge） | 被旁通（R1）；擴充後需新增「非 Issue PR」的判定輸入形態 | §2.3 |
| H5 守衛自我保護（risk-paths/CODEOWNERS/ruleset） | github-actions 生態系更新＝守衛檔自動進 main（R2）；software-factory 分支保護缺口（R4） | §2.4、§2.6 |
| docs/14 標記紀律／docs/08 指標口徑 | 自動合併缺陷率需擴充定義才能涵蓋該類別（R3） | §2.5 |
| ADR-013 兩段式合併流程 | dependabot→main 自動合併破壞 release-line 紀律；lockfile 同步衝突（R4） | §2.6 |
| factory-run 的 agent 執行環境 | 合併基準點移動頻率↑ → `gh stack sync` 衝突↑ → SR1（連續兩次 sync 失敗停手）與 needs-human 率↑ | §3.3 |
| `agent-update-deps` 任務類型 | 職权重疊：同一依賴 bot 與 agent 雙軌處理→互斥 PR、lockfile 打架 | §3.3 |
| 下游試點 repo ×4（fubon、spring-modulith、uber 兩所） | config-only 移植模式下，policy 若寫進工廠文件，各 repo dependabot 狀態不一致；需 per-repo 開關（catalog 否決權對應） | §3.4 |

### 3.2 受影響指標（對 docs/08 的具體衝擊）

- **正向**：B 組 Lead Time／超過 1 天比例直接歸零（488→≈CI 時長）；「閒置比」改善在第 2 期出場條件（docs/09:136–138）中變得可见。
- **紀律**：docs/08 §5.3 成對觀察規定「自動合併率 ↑ 必須搭配自動合併缺陷率」同屏顯示（docs/08:251–255）——**缺陷率現況無法計算（R3），先開速度的話就違反自家反 Goodhart 防線**。docs/08:240 另把「agent 自動合併率」列為危險指標：可觀察、不可作目標。
- **口徑污染**：Dependabot PR 非工作項（無 Issue、無 report.json、不進 factory-crosscheck）。若放進同一張月報，執行成功率/needs-human 率的分母會被摻水——需維持 docs/08 §4.2 A/B「必須分開計算」（docs/08:165）的原則，自動合併統計獨立成欄。

### 3.3 與 agent 產出的並行交互（Issue 點名的第四項）

1. **stack 基底漂移**：stacked PR 逐層 base 於 `$BASE_BRANCH`（docs/07 §2.2）。Dependabot 每週五投放（dependabot.yml:8–11）＋自動合併落地時，進行中的 factory 疊要 `gh stack sync`；lockfile 是單一熱檔，**衝突即交易性回滾**（sync 語意），連續兩次 → SR1 停手 → needs-human。Dependabot 合併頻率越高，agent 工作項無辜卡住的機率越高。
2. **雙軌處理**：`agent-update-deps`（docs/09:125 就緒）與 Dependabot 對同一套件各開一顆 PR → 內容重複、互斥衝突。需在派工層面劃界（例：Issue 建立時若同套件的 dependabot PR 開放中，該 update-deps 工作項暫緩）。
3. **審查佇列互擠**：docs/08 §2.2 將「審查佇列深度」列為瓶頸指標。自動合併**降低**人類佇列中的 Dependabot 佔用（基線 repo 58 顆裡 21 顆拖過一天＝人類注意力被 10 行的 PR 中斷）——這是速度面最干净的贏面；但代價是第 1 節所述把偵測責任整體移到「事後抽查＋逃逸歸因」。

### 3.4 受影響使用者／角色

- **倉庫擁有者（現為單人 philipz）**：docs/06 §4.1 設計的「擁有者無條件否決權」目前對 Dependabot 不存在（沒有接線）；同時單人 repo 的 `required_approving_review_count: 0`（main-ruleset.json:39）讓「自動合併」在當下語意＝「**完全無人參與**」。第二審查者出現前，本 repo 不適合任何零人工類別。
- **未來的工廠 agent**：main 上的依賴漂移經人工 sync 進入 trunk 後，agent 讀到的 catalog/risk-paths 不變，但 `npm ci` 環境與 lockfile 歷史會含 bot commit——對抗性測試與 e2e stub 的基準環境變動頻率↑。
- **試點 repo 導入者**：若「Dependabot 自動合併」成為工廠標準政策之一，config-only 移植承諾（docs/09 語言無關性）要求每 repo 可開可關（映射到 `factory.io/agent-automerge`＋生態系白名單），政策文件需提前定義該註解對 bot PR 是否適用——目前它只約束 agent（docs/03 §2.2、catalog-info.yaml:24–27 的語境）。

---

## 4. 方案比較

### 4.1 對 docs/06 §4.1 六條件的滿足度

| §4.1 條件 | A 原生全量 | B 分層閘控 | C security 先行 | D agent 代跑 |
|---|---|---|---|---|
| 屬 §4.2 on-loop 類別 | ✗（類別語意未驗證，actions＝H5） | ✓（限 npm 依賴更新＝明列類別） | ✓（明列） | ✓（明列） |
| catalog `agent-automerge` 否決生效 | ✗（GitHub 原生不讀 catalog） | ✓（閘門讀 catalog） | ✓ | ✓（走既有管線） |
| required checks 全綠 | △（action_required 卡死風險） | ✓＋冷卻窗 | ✓ | ✓ |
| 未觸及 CODEOWNERS 保護路徑 | ✗（actions 生態系必觸 `/.github/`） | ✓（npm 更新不觸 H1–H7；規則仍跑一次防範疇外） | ✓（同左） | △（agent 依停手規則 3 不得改 CI → actions 更新不可達） |
| 變更 ≤200 行 | ✗（原生無行數閘） | ✓ | ✓ | ✓ |
| 未觸發停手規則 | —（管線外） | ✓（門禁自訂等價條款） | ✓ | ✓ |
| **逃逸率可測（§7.2 數據前提）** | ✗ | △→✓（需 WI-A 先落地） | △→✓ | ✓（report.json/crosscheck 現成） |

### 4.2 方案 A——GitHub 原生全量自動合併【拒絕】

`gh pr merge --auto`（或 repo 層級 dependabot auto-merge）套用於所有 Dependabot PR，僅靠 required checks。
**拒絕理由**：(1) §2.3——判定不存在，條件四缺一即應退回人類審查，此方案四項無執行點；(2) §2.4——actions 生態系直進守衛檔；(3) 現況 review 要求為 0，自動合併＝零人工進 main，違反 docs/09:76 第 1 期紀律與 ADR-013 兩段式；(4) 單次事故即需收回（docs/09:214），但 A 方案連「該類別」的統計邊界都沒有。**被拒方案保留於此的目的：它是「看起來最省事」的選項，後續任何『先開了再說』的提議都應對照本表。**

### 4.3 方案 B——分層閘控自動合併【建議，Phase 3 時序】

新增一個獨立的「依賴更新門禁」（概念上對標 factory 管線，但輸入為 PR 而非 Issue）：
1. **範圍**：僅 `package-ecosystem: npm`；**僅 semver patch/minor**（major 一律人工——#134 教訓；用 dependabot `ignore` 條件或門禁端解析版本）；github-actions 生態系**明確排除**（H5 永久人工，除非人類另有 ADR）。
2. **機械條件**：變更檔案不命中 H1–H7（重用 `matchHardRules`，score.ts:78–92）；`changedLines ≤ 200`（score.ts:30）；目標 repo catalog `factory.io/agent-automerge ≠ "false"`；required checks 綠＋**冷卻窗**（版本發佈 ≥ N 天，預設建議 3–7 天，對 §2.7 殘餘風險）。
3. **trunk**：僅在 WI-B 完成後，target-branch 為該 repo 工廠 trunk、且 trunk 有與 main 同構的 ruleset（required check `test`、strict）。
4. **進場**：docs/09 §4 進入條件＋ADR-005 不對稱表（該類別逃逸率 0、樣本 ≥50、經 platform-team 審查）；**收緊**：一次 `defect/escape` 歸因到該類別 → 立即關閉，重回人工（複用 `automergeBlockers` 的單向棘輪語意，score.ts:129、rescore :164–176）。
5. **可觀察性**：每顆自動合併的 PR 由門禁寫一條結構化紀錄（對標 `.factory/run/report.json`），供 docs/08 新欄「B 組自動合併缺陷率」計算。
**代價**：新增 workflow＋CLI＋對抗測試（未來 WI-C 的實作範圍）；冷卻窗牺牲部分速度換供应链纵深。

### 4.4 方案 C——Dependabot security updates 先行【建議作為 B 的第一階段試點】

只對 **Dependabot security updates**（由 Dependabot alerts 自動開的修復 PR，dependabot.yml:2 註記其存在）啟用 B 的門禁子集。
**理由**：這類 PR 的「不合併成本」最高——`npm audit --audit-level=high` 紅燈（test.yml:42–43）會把整條 CI 卡住，36% 的 >1 天空窗就是 CVE 暴露窗；同時其收益/風險比最清楚（修的是已知漏洞）。
**風險與限制**：security 修復可能指向 major（最小修複版本跨大版本）→ 必須套 semver 白名單，超出即退回人工；樣本量小，湊齊 ≥50 需較長時間——適合當「閘門機制的低噪音驗證場」，不適合當唯一途徑。

### 4.5 方案 D——以工廠 agent（`agent-update-deps`）取代/並行 bot【拒絕（作為本問題的答案）】

讓 agent 開依賴更新 PR，經完整判定管線，Phase 3 再對該類型開自動合併。
**拒絕理由**：(1) **不可達**——github-actions 更新 agent 依停手規則 3 必然停手（不得修改 CI 設定），D6 權限也未授 `Workflows`；(2) **無增益**——npm 更新本已是 docs/06 §4.2 明列類別，走 agent 只是把確定性的 bot 工作換成有 token 成本、成功率 <100% 的機率性執行（docs/08 §2.3），且 R2/R3/R4 一個都不會因此消失；(3) **重複**——Dependabot 已存在且免费。
**保留價值**：作為「依賴更新的**大版本/成組升級**」的執行者是合理的（那本來就需要人審＋可能需跨檔修正），但不構成對本 Issue 主問題（閒置）的解方。

---

## 5. 建議下一步（可直接開成工作項；決策屬人類）

> 排序原則：WI-A/WI-B 與「是否放寬」**無關**、本身即補既有缺口（defect 紀律與 trunk 保護缺口），可立即開工；WI-D 是決策記錄；WI-C 在 B 全綠後才實作。

### WI-A（agent-write-docs｜P1）缺陷標記紀律擴充：非 factory PR 的逃逸歸因
改 `docs/14` §1 與 `docs/08` §2.4：定義 `defect/escape` 對「合併後發現、可追溯到依賴版本變更（含 Dependabot commit）」的歸因規則（修正 Issue 引用來源 commit/PR，無 `Closes #N` 亦可入統計）；docs/08 增「自動合併缺陷率（依賴更新類）」觀察欄與 §5.3 成對顯示要求。
**驗收條件草案**：① docs/14 判定表新增該類目且與 §1.3 公式一致；② 以基線 repo 歷史 1 例演算歸因流程（附於 PR 描述）；③ 不改任何程式碼。

### WI-B（人類 PR——觸 `.github/**`＝H5，依停手規則 3 不得交 agent｜P1）trunk 對齊＋保護補齊＋原生政策實測
1. 決定制裁 `dependabot.yml` `target-branch`（建議：工廠 trunk `software-factory`；若暫不改，需在 ADR-013 把「dependabot→main」從過渡條款升為永久例外並說明 lockfile 同步紀律）。
2. 為 `software-factory` 分支建立與 `main-protection` 同構 ruleset（required check `test`、strict；`config/github/` 記錄檔同步更新）。
3. **實測**下一顆 github-actions 生態系 PR 的 check 是否卡 `action_required`（驗證 §2.4 末段），結果記入本報告或新 ADR。
**驗收條件草案**：① ruleset GET 可見 software-factory 受保護；② 下一顆 dependabot PR baseRefName 符合裁決；③ action_required 實測紀錄存在。

### WI-D（人類/ADR｜P2）Phase 3 候選類別決策
在 `docs/09` §4 工作項 3.1 與 ADR 層面裁決：「Dependabot 類（npm，patch/minor，≤200 行）」是否列入自動合併候選、與 `agent-add-tests`/`agent-write-docs` 的優先序、以及 github-actions 生態系是否**永久**排除於自動合併。
**驗收條件草案**：① 新 ADR（仿 ADR-005 格式：脈絡/決策/後果/替代方案）；② docs/09 表格更新；③ docs/06 §4.1「類型級限制」段落如需引用則同步。

### WI-C（未來的 agent 工作項｜P3，僅在 WI-D 裁決『列入』且 docs/09 §4 進入條件滿足後）實作依賴更新門禁
`src/scoring` 增純函式（重用 `matchHardRules`/`AUTOMERGE_MAX_LINES`）＋ `factory-automerge-deps` CLI ＋ workflow（read-only PR 事件 → 全條件通過才 `gh pr merge --auto`）＋ **對抗性測試**：斷言 H5 路徑、major、>200 行、catalog 否決、checks 未綠——每一項都必須**擋下**（docs/11 §7.1「驗證守衛真的會擋」）。
**驗收條件草案**：① 五類對抗案例紅→綠；② 演練一次真實 npm patch PR 全綠自動合併＋紀錄落地觀察窗；③ 觀察窗（建議 ≥90 天）內該類別 `defect/escape`＝0 方可延長。

### 觀測建議（非工作項）
WI-A 落地後，把「B 組自動合併缺陷率」納入既有 `factory-metrics` 月報欄位（docs/09 2.5 務實版），人類只在非零時介入——這才是 docs/06 §2「on the loop」的正確形態。

---

## 6. 本分析的限制（誠實揭露）

1. **本 repo 樣本 n=5**，方向性與基線（n=58）一致，比例數字不可当真。
2. **未量測試點 repo 的 Dependabot 現況**（fubon-tradingbot 為基線來源；其餘試點 repo 的 dependabot 配置未逐一盤點）——WI-B 決策時應補。
3. `action_required` 行為依 GitHub 政策文件與公開案例推斷，**未在本 repo 實測**（列入 WI-B-3）。
4. 冷卻窗天數（3–7 天）為業界慣例引用，非本專案實證值；Q06-3（行數門檻校準）同样待校準。
5. 依 docs/08 §4.3 基線四限制（含 agent 影響混入、單人 repo 無交接等待），改善幅度的宣讀需保留同等謹慎。

---

## 附錄 A：引用清單（檔案×行）

| 引用 | 位置 | 用途 |
|---|---|---|
| Dependabot 基線（93%/36%/13.6×） | docs/08-metrics-kpi.md:163–175 | §2.1 |
| 第 1 期首要目標 | docs/08-metrics-kpi.md:220–224 | §1、§2.1 |
| 自動合併缺陷率＝放寬唯一依據 | docs/08-metrics-kpi.md:72–77 | §2.5 |
| 成對觀察／危險指標 | docs/08-metrics-kpi.md:240、:251–255 | §3.2 |
| 監督層級表／§4.1 六條件／單向棘輪 | docs/06-human-oversight-policy.md:93–97、:103–122 | §2.3、§4 |
| on-loop 類別明列「相依套件更新」 | docs/06-human-oversight-policy.md:124–134（:129） | §1、§4 |
| 放寬程序（實際數據） | docs/06-human-oversight-policy.md:237–245 | §2.5 |
| 二次判定（單向升級） | docs/06-human-oversight-policy.md:193–208 | §2.3 |
| 第 1 期不開放自動合併 | docs/09-roadmap.md:76、:79 | §1、§4.2 |
| Phase 3 進入條件／候選類別／收回棘輪 | docs/09-roadmap.md:144、:186–208、:214 | §1、§5 |
| 缺陷標記紀律（Closes #N） | docs/14-observation-period.md:15、:20、:28、:34 | §2.5 |
| H5 路徑模式 | .github/factory/risk-paths.yml:36–42 | §2.4 |
| github-actions 生態系啟用 | .github/dependabot.yml:14–19（無 target-branch：:5–13） | §2.4、§2.6 |
| rescore 僅 factory/* 分支 | .github/workflows/factory-rescore.yml:57–58、:61、:82、:118–120 | §2.3 |
| findLinkedIssue（Closes/factory/N） | src/cli/factory-rescore.ts:47–52 | §2.3 |
| automerge 條件實作 | src/scoring/score.ts:30、:129–142、:152；rescore :164–176 | §2.3、§4.3 |
| dogfooding 否決（agent-automerge false） | catalog-info.yaml:24–27 | §3.4 |
| 兩段式合併／過渡例外 | docs/ADR/013-trunk-unification-software-factory.md:26（決策 5）、:40 | §2.6 |
| ruleset 僅保護預設分支、review=0 | config/github/main-ruleset.json:12、:25、:39–40 | §2.4、§2.6 |
| CODEOWNERS 守衛保護 | CODEOWNERS:17–19 | §2.4 |
| npm audit 紅燈 gate | .github/workflows/test.yml:40–43 | §2.7、§4.4 |
| ADR-005 不對稱放寬／收緊 | docs/ADR/005-autonomy-ceiling.md（決策、放寬收緊表） | §1、§4.3、§5 |

*本報告由 `agent-analyze` 工作項產出（Issue #229），變更範圍僅 `docs/research/`。*
