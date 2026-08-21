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
2. 產出必須符合 .github/ISSUE_TEMPLATE/factory-work-item.yml 的欄位要求：任務類型、需求描述（PRD，含目標模組/檔案、做什麼、為什麼、範圍四段）、驗收標準（DoD，必須可驗證）。
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
  "requirement": "<PRD 四段：目標模組/檔案、做什麼、為什麼、範圍>",
  "dod": ["<可驗證的測試/驗證方式>", "<不觸碰的高風險路徑說明>", "<測試綠燈確認方式>"],
  "targetRepo": "<若描述有提到才填，格式 owner/name>",
  "notes": ["<推測與未確認事項——凡是你從描述推測的內容必須列出>"]
}

規則：
- requirement 必須包含「目標模組/檔案、做什麼、為什麼、範圍」四段，缺一段就無法寫出可驗證的驗收條件。
- dod 每一項都必須是「可驗證的」（有測試或明確驗證命令），不可驗證就列進 notes 讓使用者補。
- notes 是品質標示：列出所有你推測的內容與未回答的關鍵問題（例如「目標 repo 未知，帶入預設」）。`
}
