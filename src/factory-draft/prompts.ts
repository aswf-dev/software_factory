/**
 * LLM 草稿助手的 prompt 建構（純函式，無副作用）。
 *
 * 對應 docs/ADR/009 的生成模式：
 * - 「🎯 釐清需求」= grill-me 收斂版：一次只問一輪 frontier 問題（編號、附建議
 *   答案），最多 CLARIFY_MAX_ROUNDS 輪，使用者可隨時跳過直接生成；
 * - 「✨ 一次生成」= 一次 LLM call 回傳結構化 JSON（title/requirement/dod/
 *   targetRepo/notes），notes 為「推測與未確認事項」品質標示。
 *
 * 設計對齊 docs/01 的職責邊界：LLM 只產草稿與釐清，最終送出權在使用者。
 */
export const CLARIFY_MAX_ROUNDS = 3

export interface ClarifyQa {
  question: string
  answer: string
}

export const SYSTEM_PROMPT = `你是 software factory 的「工作項草稿助手」，負責把使用者的自然語言需求轉成 factory 工作項（GitHub Issue）的制式草稿。

規則：
1. 你只產生草稿與釐清問題，不決定「要做什麼」或「優先順序」——最終決定權永遠在使用者。
2. 產出必須符合 .github/ISSUE_TEMPLATE/factory-work-item.yml 的欄位要求：任務類型、需求描述（PRD，含目標模組/檔案、做什麼、為什麼、範圍、已知問題，可選填不變量）、驗收標準（DoD，必須可驗證）。
3. 誠實標示：凡是你從描述「推測」的內容，一律列入 notes（推測與未確認事項）。`

export function buildClarifyPrompt(input: {
  requirement: string
  round: number
  history: ClarifyQa[]
}): string {
  const historyText =
    input.history.length === 0
      ? '（尚無）'
      : input.history.map((h, i) => `第 ${i + 1} 輪 你問：${h.question}\n使用者答：${h.answer}`).join('\n')
  return `${SYSTEM_PROMPT}

任務：對使用者的需求進行「grill-me 收斂版」釐清——只問**一輪**你最需要確認的 frontier 問題（不超過 4 題），目的是讓驗收條件可驗證。

使用者原始需求：
${input.requirement}

目前釐清歷史：
${historyText}

第 ${input.round} 輪（總上限 ${CLARIFY_MAX_ROUNDS} 輪，使用者可隨時跳過直接生成）。

輸出格式：編號列表，每題一行「Qn：<問題>（建議答案：<你推薦的答案>）」。不要輸出其他內容。`
}

export function buildGeneratePrompt(input: {
  requirement: string
  history: ClarifyQa[]
}): string {
  const historyText =
    input.history.length === 0
      ? '（無釐清，直接生成）'
      : input.history.map((h, i) => `第 ${i + 1} 輪 你問：${h.question}\n使用者答：${h.answer}`).join('\n')
  return `${SYSTEM_PROMPT}

任務：把使用者的需求一次轉成完整的 factory 工作項草稿（一次到位），以嚴格 JSON 回傳（不要 markdown fence、不要額外文字）。

使用者需求描述：
${input.requirement}

釐清歷史：
${historyText}

JSON schema：
{
  "title": "<一句話需求，將作為 Issue 標題，不含 [factory] 前綴>",
  "requirement": "<PRD：目標模組/檔案、做什麼、為什麼、範圍、已知問題（若無填無）、選填不變量>",
  "dod": ["<可驗證的測試/驗證方式>", "<不觸碰的高風險路徑說明>", "<測試綠燈確認方式>"],
  "targetRepo": "<若描述有提到才填，格式 owner/name>",
  "notes": ["<推測與未確認事項——凡是你從描述推測的內容必須列出>"]
}

規則：
- requirement 必須包含「目標模組/檔案、做什麼、為什麼、範圍、已知問題」等段落（已知問題若無填「無」），缺段落就無法寫出可驗證的驗收條件。
- dod 每一項都必須是「可驗證的」（有測試或明確驗證命令），不可驗證就列進 notes 讓使用者補。
- notes 是品質標示：列出所有你推測的內容與未回答的關鍵問題（例如「目標 repo 未知，帶入預設」）。`
}

// ---------------------------------------------------------------------------
// PRD 多輪釐清（ADR-031，2026-11-07）：S 流程 P0 的 S2-prd 人工步驟
// ---------------------------------------------------------------------------
//
// 與上面的工作項草稿不同：這裡是**整個系統的需求**（S 流程導入一個 repo），由
// aswf.dev 的 Worker 同步呼叫 LLM（不派 factory-run）。每一輪回傳結構化 JSON，
// 頁面把每一題畫成一張卡（選項＋其他＋預選建議答案）。
//
// grilling 規則（ADR-031 §8，取代把 grilling skill 放進 runner）：
//   1. 先在心中列出要決定的事情（決策樹），每輪只問「前提都已確定」的題目（frontier）；
//   2. 題目附建議答案，使用者回「是」＝採用建議；
//   3. 不問使用者已經回答過、或 repo 摘要裡已經寫明的事情；
//   4. 該有答案的都有了就回 done:true，不要為了湊輪數而問。

/** PRD 釐清最多幾輪（ADR-031 §7：流程設計，不是成本上限）。 */
export const PRD_CLARIFY_MAX_ROUNDS = 3
/** 每輪最多幾題。 */
export const PRD_MAX_QUESTIONS = 4

/** 已回答的一題：題目文字與使用者的回答（選項或自由文字）。 */
export interface PrdQa {
  question: string
  answer: string
}

/** PRD 的六個必要段落（與 docs/29 §9.1 的 PRD 欄位一致）。 */
export const PRD_SECTIONS = ['目標模組/檔案', '做什麼', '為什麼', '範圍', '已知問題', '驗收條件'] as const

export const PRD_SYSTEM_PROMPT = `你是 software factory 的「導入需求釐清助手」。使用者要把一個既有的 repo 導入 factory（S 流程 P0），你負責把他的初始需求釐清成一份可驗證的 PRD。

規則：
1. 你只產生問題與 PRD 草稿，不決定「要做什麼」或「優先順序」——最終決定權永遠在使用者。
2. PRD 必須包含六段：${PRD_SECTIONS.join('、')}；驗收條件必須可驗證（有測試或明確的驗證方式）。
3. 誠實標示：凡是你從需求或 repo 摘要「推測」的內容，一律標明「（推測，待確認）」。
4. 不得要求使用者提供密碼、token、私鑰或任何秘密。`

function prdContext(input: { seed: string; repoDigest: string | null; history: PrdQa[] }): string {
  const digest =
    input.repoDigest === null || input.repoDigest.trim() === ''
      ? '（無法取得 repo 摘要，只依需求文字判斷）'
      : input.repoDigest
  const history =
    input.history.length === 0
      ? '（尚無）'
      : input.history.map((h, i) => `Q${i + 1}：${h.question}\nA${i + 1}：${h.answer}`).join('\n')
  return `使用者的初始需求：
${input.seed}

repo 摘要（README 前段、最上層檔案、catalog-info.yaml；可能不完整）：
${digest}

已經問過並回答的問題：
${history}`
}

export function buildPrdClarifyPrompt(input: {
  seed: string
  repoDigest: string | null
  history: PrdQa[]
  round: number
}): string {
  return `${PRD_SYSTEM_PROMPT}

任務：進行第 ${input.round} 輪釐清（總上限 ${PRD_CLARIFY_MAX_ROUNDS} 輪）。

${prdContext(input)}

做法（grilling）：
- 先在心中列出寫出 PRD 還需要決定的事情；這一輪只問「前提都已確定」的題目，最多 ${PRD_MAX_QUESTIONS} 題。
- 每題給 2–4 個具體選項與一個建議答案（recommended 必須是 options 之一）；使用者採用建議即可。
- 不要問已經回答過、或 repo 摘要已寫明的事情。
- 如果六段（${PRD_SECTIONS.join('、')}）都已能寫出可驗證的內容，回 done:true 且 questions 為空陣列——不要為了湊輪數而問。

只輸出嚴格 JSON（不要 markdown fence、不要額外文字）：
{"done": false, "questions": [{"id": "q1", "text": "<問題>", "options": ["<選項A>", "<選項B>"], "recommended": "<選項A>"}]}`
}

export function buildPrdDraftPrompt(input: { seed: string; repoDigest: string | null; history: PrdQa[] }): string {
  return `${PRD_SYSTEM_PROMPT}

任務：依下列資訊寫出完整的 PRD（Markdown）。這份 PRD 會在使用者確認後**公開**在 GitHub Issue，所以不要放入任何秘密，也不要逐字照抄使用者的私人說明以外的內容。

${prdContext(input)}

輸出格式：只輸出 PRD 本文（Markdown，不要 code fence）。依序使用以下六個粗體段落標題（不要用 # 標題，Issue 表單不接受）：
${PRD_SECTIONS.map((section) => `**${section}**`).join('\n')}

規則：
- 「驗收條件」用條列，每一條都必須可驗證（測試、命令或可觀察的結果）。
- 「已知問題」若沒有就寫「無」。
- 推測的內容標明「（推測，待確認）」。`
}
