/**
 * assertion-count — 從 git diff **實算**測試斷言的淨增減。
 *
 * ## 為什麼需要這支
 *
 * SR6（`src/stop-rules/stop-rules.ts`）是工廠少數幾條「安全性」等級的停手規則：
 * 「絕不允許為通過測試而弱化斷言」。但它的輸入 `assertionDelta` 由 **agent 自己
 * 填在 report.json**（`.dsh/skills/factory-workflow/SKILL.md` 的欄位說明），而
 * `factory-crosscheck` 雙向比對的是 `changedPaths`——**沒有任何東西比對這個數字**。
 *
 * 也就是說 SR6 目前站在 prompt 層的一個自報數字上。CODEOWNERS 檔首那句話正是在講
 * 這件事：「The agent's stop rules are the prompt layer, and **prompts can be
 * ignored** — this file cannot.」
 *
 * 而 `docs/25` §2.4 已經以 13 次 run 的盤點證明過：**自報紀律是模型相依的**
 * （5 筆 skillGap 全來自兩個模型，claude 家族 0/4），因此加了三道不依賴自報的補強
 * （§2.1.1）。`assertionDelta` 是同一類自報，後果卻更嚴重——它直接決定停不停手，
 * 而且它是 `.optional()`：**漏填就等於 SR6 從未存在**。這支模組是那一道缺席的補強。
 *
 * ## 刻意的設計取捨
 *
 * 1. **只比對「方向」，不比對「數值」。** 跨語言的斷言計數必然是啟發式的，數值相等
 *    比對會製造大量假陽性，重蹈 REQ id 錨定刻意留在 advisory 的那個教訓
 *    （`factory-crosscheck.ts` 的 `advisories` 說明）。方向（是否淨減少）才是 SR6
 *    的判準，也是唯一會被繞過的那一面。
 * 2. **每一處不確定都倒向「少算」。** 認不出的測試檔、剝掉的註解、漏列的框架，
 *    結果都是 delta 偏大（偏向不觸發）。寧可漏報也不要用一個猜出來的負數把誠實的
 *    run 擋下來——假陽性會訓練人忽略這個訊號，那比沒有訊號更糟。
 * 3. **不提供覆寫。** 同 `src/stop-rules` 的 no-override 立場。
 */

/**
 * 測試檔路徑樣式。
 *
 * **寧可漏認，不可誤認**：漏認一個測試檔 → 它的刪除不被計入 → delta 偏大 →
 * 不觸發（安全方向）。誤認一個非測試檔 → 可能算出假的負值 → 擋下誠實的 run。
 *
 * `(^|\/)` 錨定路徑段起點，所以 `src/latest/x.ts` 不會因為含有 `test` 而中選。
 */
export const TEST_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)tests?\//,
  /(^|\/)__tests__\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.(py|go|rb)$/,
  /_spec\.rb$/,
  /[A-Za-z0-9]Tests?\.(java|kt|cs|swift)$/,
]

/** 這個路徑是否為測試檔（只有測試檔內的斷言會被計入）。 */
export function isTestPath(path: string): boolean {
  return TEST_PATH_PATTERNS.some((re) => re.test(path))
}

/**
 * 斷言呼叫的樣式。
 *
 * 保守列舉、只收**明確是斷言**的形態。刻意**未**納入的兩類，理由相同——它們在
 * 測試檔裡有大量非斷言用途，會把雜訊帶進唯一有意義的那個符號：
 *  - `require.*`（testify）：與 Node 的 `require.resolve` 同形；`assert.*` 已涵蓋
 *    testify 的常見寫法。
 *  - `should` / `.to.be`：BDD 鏈式語法片段太常見於一般英文與變數名。
 *
 * 重複命中（例如 `assert.Equal(` 同時符合 `\bassert\b`）不影響結論：加行與減行
 * 套用**完全相同**的樣式集，重複是對稱的，而我們只用符號。
 */
export const ASSERTION_PATTERNS: readonly RegExp[] = [
  /\bexpect\s*\(/g, // Jest / Vitest / Chai
  /\bassert\b/g, // Python / Java / JS / C / testify 的 assert.*
  /\bassert_(?:eq|ne)!/g, // Rust 巨集（`_` 是 word char，\bassert\b 不會命中）
  /\bXCTAssert\w*\s*\(/g, // XCTest
  /\bt\.(?:Error|Errorf|Fatal|Fatalf)\s*\(/g, // Go testing
]

/**
 * 剝除行註解，避免「刪掉一行含 assert 字樣的註解」被算成刪掉一條斷言。
 *
 * 只處理行註解：區塊註解跨行，以行為單位剝除必然失準。以 `*` 開頭的行（block
 * comment 的中間行）整行捨棄。
 *
 * `//` 也會切掉 URL 的 scheme 分隔（`https://…`），那會讓該行少算——同樣是安全方向。
 */
export function stripComments(line: string): string {
  const trimmed = line.trim()
  if (trimmed.startsWith('*') || trimmed.startsWith('/*')) return ''
  let cut = line.length
  for (const marker of ['//', '#']) {
    const at = line.indexOf(marker)
    if (at >= 0 && at < cut) cut = at
  }
  return line.slice(0, cut)
}

/** 單行中的斷言出現次數。 */
export function countAssertions(line: string): number {
  const code = stripComments(line)
  if (code === '') return 0
  let n = 0
  for (const re of ASSERTION_PATTERNS) {
    for (const _m of code.matchAll(re)) n++
  }
  return n
}

export interface AssertionDiffCount {
  /** 測試檔加行中的斷言數。 */
  added: number
  /** 測試檔減行中的斷言數。 */
  removed: number
  /** `added - removed`；負數即「斷言淨減少」，SR6 的判準。 */
  delta: number
}

/** 檔案標頭的路徑（`--- a/x` / `+++ b/x`），`/dev/null` 回傳 null。 */
function headerPath(line: string): string | null {
  const raw = line.slice(4).trim()
  if (raw === '/dev/null') return null
  // git 的 `a/` `b/` 前綴；`--no-prefix` 的輸出則沒有，兩種都收。
  return raw.replace(/^[ab]\//, '')
}

/**
 * 從 unified diff 文字實算測試檔的斷言淨增減。
 *
 * 新增檔的 `--- /dev/null` 與刪除檔的 `+++ /dev/null` 都會出現，因此當前檔案取
 * 「新路徑優先、否則舊路徑」——刪掉一整個測試檔時，它的斷言仍必須被計入減項，
 * 否則「刪光測試」會是這支模組看不見的那個洞。
 *
 * **`---`／`+++` 只在 hunk 之外才是檔案標頭。** 一條被刪掉的 SQL 註解 `-- x`
 * 在 diff 裡長成 `--- x`，與標頭同形；若無條件當標頭解析，那一行不但不被計數，
 * 還會把當前檔案改成 `x` 而讓其後整段失準。`@@` 進入 hunk、`diff --git` 開啟
 * 新檔並重置狀態，兩者夾出標頭唯一可能出現的區間。
 */
export function countAssertionDelta(diffText: string): AssertionDiffCount {
  let added = 0
  let removed = 0
  let oldPath: string | null = null
  let newPath: string | null = null
  let inTestFile = false
  let inHunk = false

  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      oldPath = null
      newPath = null
      inTestFile = false
      inHunk = false
      continue
    }
    if (line.startsWith('@@')) {
      inHunk = true
      continue
    }
    if (!inHunk && line.startsWith('--- ')) {
      oldPath = headerPath(line)
      continue
    }
    if (!inHunk && line.startsWith('+++ ')) {
      newPath = headerPath(line)
      const current = newPath ?? oldPath
      inTestFile = current !== null && isTestPath(current)
      continue
    }
    if (!inTestFile) continue
    if (line.startsWith('+')) added += countAssertions(line.slice(1))
    else if (line.startsWith('-')) removed += countAssertions(line.slice(1))
  }

  return { added, removed, delta: added - removed }
}
