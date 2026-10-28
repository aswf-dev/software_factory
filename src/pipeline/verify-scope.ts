/**
 * 驗證類 task 允許 agent 寫入的範圍（ADR-029 §5、§6 修訂版）。
 *
 * 三個消費端必須用同一份 glob：
 *   - `factory-crosscheck --verify-only`：判 diff 是否越界（政策違規）；
 *   - `factory-verify-encrypt`：決定哪些 agent 改動的測試檔要進加密 bundle；
 *   - `factory-verify-input`：還原階段輸入時只接受同一批路徑。
 *
 * 若各自寫一份，漂移的方向會是「crosscheck 放行的檔案沒進 bundle」（下一階段缺檔）、
 * 「bundle 帶了 crosscheck 判定越界的檔案」（把不該存在的內容送到 Worker），或
 * 「還原寫進 crosscheck 不認得的位置」——三者都不會有第二次訊號。因此值與比對
 * 語意都集中在這裡。
 *
 * 五個 glob 涵蓋各語言的測試命名慣例：JS/TS 的 `.test.` 中綴、Go 的 `_test.go`
 * 後綴、以及 Python／Java 常見的 `test` 或 `tests` 目錄。白名單是**允許清單**：
 * 未明列者一律拒絕（同 propose-skill／onboard 的立場）。
 *
 * 其中 `.test.` glob 會匹配 `src/` 下與產品碼共置的測試檔——那是刻意的：
 * 合法測試檔可能就在 src/ 下。產品碼本身（不含 `.test.` 的 src 檔）仍被拒絕。
 *
 * **dot segment 只在 `specs/**` 內放寬**（C1，final whole-branch review）：
 * `*`／`**` 預設不匹配以 `.` 開頭的 segment，若不對 `specs/**` 開 `dot`，lean skill
 * 的 `specs/lean/.gitignore`、`specs/lean/.lake/**` 會被判越界——那兩者正是合規產出
 * （skill 會複製 `.gitignore`，`.lake/` 是建置快取且不進版控）。
 *
 * 但把 `dot: true` 套用到全部五個 glob 會打開一個更嚴重的破口：
 * `.github/workflows/evil.test.yml`、`.github/tests/x.ts`、`.github/test/x.ts`、
 * `.github/factory/foo_test.go` 全都符合測試檔 glob 的字面形狀，於是驗證 agent
 * 可以直接改寫 CI 設定與工作流程（C1）。因此：
 *   1. `specs/**` 以外，任何含 `.` 開頭 segment 的路徑一律拒絕；
 *   2. 任何含 `.github` segment 的路徑一律拒絕（即使落在 specs 樹內，那是機制資產）。
 *
 * 註：`agent-pbt-audit` 的 `pbt-outside-audit` 仍獨立生效——驗證類也不得產出
 * `.pbt.test.*`（PBT 只能由稽核工單產生，ADR-019 §2）。
 */
import { minimatch } from 'minimatch'

export const VERIFY_ALLOWED_GLOBS = [
  'specs/**',
  '**/*.test.*',
  '**/*_test.go',
  '**/tests/**',
  '**/test/**',
] as const

/** specs 樹（唯一放寬 dot segment 的範圍）。 */
const SPECS_GLOB = 'specs/**'

/** 路徑是否位於 `specs/` 樹內（含根目錄本身）。 */
function isUnderSpecs(path: string): boolean {
  return path === 'specs' || path.startsWith('specs/')
}

/**
 * 單一路徑是否落在驗證類白名單內。
 *
 * `specs/**` 以 `dot: true` 比對（`.gitignore`、`.lake/`）；其餘 glob 維持預設
 * `dot: false`，且在比對前先拒絕 specs 外的 dot segment 與任何 `.github` segment
 * ——不要依賴 minimatch 的 dot 語意去擋 CI 設定改寫（C1）。
 */
export function isVerifyAllowedPath(path: string): boolean {
  const segments = path.split('/')
  // CI 設定是機制資產：不論 glob 形狀、不論在哪棵樹，`.github` segment 一律拒絕。
  if (segments.some((segment) => segment === '.github')) return false
  // dot segment 只在 specs 樹內放寬；specs 外的 `.test.` 形狀不得因此過關。
  if (!isUnderSpecs(path) && segments.some((segment) => segment.startsWith('.'))) return false
  return VERIFY_ALLOWED_GLOBS.some((glob) =>
    minimatch(path, glob, glob === SPECS_GLOB ? { dot: true } : {}),
  )
}
