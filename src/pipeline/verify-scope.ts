/**
 * 驗證類 task 允許 agent 寫入的範圍（ADR-029 §5、§6 修訂版）。
 *
 * 兩個消費端必須用同一份 glob：
 *   - `factory-crosscheck --verify-only`：判 diff 是否越界（政策違規）；
 *   - `factory-verify-encrypt`：決定哪些 agent 改動的測試檔要進加密 bundle。
 *
 * 若各自寫一份，漂移的方向會是「crosscheck 放行的檔案沒進 bundle」（下一階段缺檔）
 * 或「bundle 帶了 crosscheck 判定越界的檔案」（把不該存在的內容送到 Worker）——
 * 兩者都不會有第二次訊號。因此值與比對語意都集中在這裡。
 *
 * 五個 glob 涵蓋各語言的測試命名慣例：JS/TS 的 `.test.` 中綴、Go 的 `_test.go`
 * 後綴、以及 Python／Java 常見的 `test` 或 `tests` 目錄。白名單是**允許清單**：
 * 未明列者一律拒絕（同 propose-skill／onboard 的立場）。
 *
 * 其中 `.test.` glob 會匹配 `src/` 下與產品碼共置的測試檔——那是刻意的：
 * 合法測試檔可能就在 src/ 下。產品碼本身（不含 `.test.` 的 src 檔）仍被拒絕。
 *
 * `dot: true`：`*` 預設不匹配以 `.` 開頭的 segment，會把 lean skill 的
 * `specs/lean/.gitignore`、`specs/lean/.lake/**` 判成越界——那兩者正是合規產出
 * （skill 會複製 `.gitignore`，`.lake/` 是建置快取且不進版控）。白名單只放寬
 * 「`.` 開頭仍屬 specs 樹」，specs 外的隱藏路徑（`.github/**` 等）照樣拒絕。
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

/** 單一路徑是否落在驗證類白名單內（dot files 允許，例如 `specs/lean/.gitignore`）。 */
export function isVerifyAllowedPath(path: string): boolean {
  return VERIFY_ALLOWED_GLOBS.some((glob) => minimatch(path, glob, { dot: true }))
}
