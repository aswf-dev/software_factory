import { describe, expect, it } from 'vitest'
import { runCli, type CliIo } from './run-cli.js'

/**
 * Mutation-strength tests for `runCli` 的「成功輸出格式」契約（docs/06 §5.1；
 * src/cli 為 CI gate，src/cli/** 需 100% branch 覆蓋 —— 見 vitest.config.ts）。
 *
 * 這些測試補上 `run-cli.test.ts` 未釘住的輸出格式契約。既有套件一律用
 * `JSON.parse(io.out.join(''))` 驗證 stdout，而 JSON.parse 會忽略縮排與行尾
 * 換行 —— 因此「成功輸出必須是 `JSON.stringify(run(), null, 2)` + 行尾換行」
 * 這條由 docs 明訂的格式（`docs/02`、phase1 plan §Task2: `JSON.stringify(main(...),
 * null, 2) + '\n'`）在既有套件下完全未覆蓋。對統一外殼 `runCli`（Task 2–7 共用）
 * 來說，輸出格式就是 CI 判讀結果的介面契約。
 *
 * 每個 block 記錄一個對 `run-cli.ts` 成功輸出格式的具體變異，並斷言該變異會
 * 破壞的行為。Mutation log（以手工編輯 src/cli/run-cli.ts 之後重跑 `npx vitest
 * run src/cli/run-cli-output-mutation.test.ts`、再還原的方式驗證）：
 *
 *  | ID | Mutation                                  | Before | After  |
 *  |----|-------------------------------------------|--------|--------|
 *  | M1 | `JSON.stringify(run(), null, 2)` → 拔縮排 | GREEN  | RED    |
 *  | M2 | 省略成功輸出的行尾 `\n`                    | GREEN  | RED    |
 *  | M3 | 縮排 `2` → `4`（或改為 tab）               | GREEN  | RED    |
 *
 * "Before" = 既有套件（含 run-cli.test.ts）；"After" = 加上本檔。
 * M1–M3 由 GREEN→RED 是本檔新增的價值：既有套件對這三種輸出格式變異全部存活
 * （全綠），因為 JSON.parse 寬鬆地容忍縮排/換行差異。補釘後這類回歸在 CI gate
 * （src/cli/** 100% branch）就會被攔下。
 */

/** 產生 runCli 在成功路徑下預期寫入 stdout 的完整字串（含縮排與行尾換行）。 */
function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function captureIo(): CliIo & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { out, err, stdout: (t) => out.push(t), stderr: (t) => err.push(t) }
}

describe('M1 變異：成功輸出被壓成單行（拔掉 null, 2 縮排）', () => {
  /**
   * 真實語意：docs 明訂成功輸出為 `JSON.stringify(main(...), null, 2) + '\n'`。
   * 一旦縮排被拔掉，輸出變成 `{"score":{"total":3}}\n` —— JSON.parse 仍可解析，
   * 所以既有套件毫不察覺。本 block 用逐字比較釘住縮排格式。
   */
  it('成功輸出保留可讀的 2-space 縮排（逐字比較）', () => {
    const io = captureIo()
    runCli(() => ({ score: { total: 3 } }), io)
    expect(io.out.join('')).toBe(prettyJson({ score: { total: 3 } }))
  })

  it('輸出是多行的漂亮列印，而非整顆 object 全擠在單行', () => {
    const io = captureIo()
    runCli(() => ({ score: { total: 3 } }), io)
    // 縮排被移除後，整顆 object 落在 text 的第一行，沒有 inner newline（行數 < 3）。
    expect(io.out.join('').split('\n').length).toBeGreaterThan(3)
  })
})

describe('M2 變異：成功輸出少了行尾 \n', () => {
  /** 行尾換行是 CLI 行式輸出的介面契約（shell 命令替換、tail/相鄰工具依賴）。 */
  it('成功輸出以 \n 結束', () => {
    const io = captureIo()
    runCli(() => ({ ok: true }), io)
    expect(io.out.join('')).toBe(prettyJson({ ok: true }))
  })

  it('成功輸出的 text 唯一一次 write 即包含完整 JSON 與行尾換行', () => {
    const io = captureIo()
    runCli(() => ({ ok: true }), io)
    expect(io.out.length).toBe(1)
    expect(io.out[0]?.endsWith('\n')).toBe(true)
  })
})

describe('M3 變異：縮排單位被改大的變異（2 → 4 空間）', () => {
  /**
   * 縮排數量是 docs/02 定義的格式一部分（2 個 space）。改成 4 個 space 後
   * text 仍是「漂亮列印 + 換行」，但縮排寬度不符契約 —— 既有套件以
   * JSON.parse 驗證，對縮排數量同樣無感。
   */
  it('成功輸出使用 2 個 space 縮排（逐字驗證）', () => {
    const io = captureIo()
    runCli(() => ({ score: { total: 3 } }), io)
    expect(io.out.join('')).toBe(prettyJson({ score: { total: 3 } }))
  })

  it('內層物件縮排為 4 格（2 格 × 2 層），符合逐字格式', () => {
    const io = captureIo()
    runCli(() => ({ score: { total: 3 } }), io)
    expect(io.out.join('')).toContain('\n    "total": 3')
  })
})
