/**
 * 所有 factory CLI 共用的執行外殼（Task 2–7 沿用同一模板）。
 *
 * 存在理由：CLI 是 CI 的 gate。失敗時 CI 需要一行可讀的原因，而不是 raw stack
 * trace；更重要的是**絕不可以靜默成功** —— 計分失敗必須以非 0 結束，否則
 * oversight gate 會被當成通過（docs/06 §5.1）。
 */

/** CLI 可預期的失敗（設定錯誤、輸入不合法），對使用者顯示單行訊息。 */
export class CliError extends Error {
  override readonly name = 'CliError'
}

/** 把任意 throw 值轉成給 CI 看的單行訊息。 */
export function formatCliError(err: unknown): string {
  if (err instanceof CliError) return `error: ${err.message}`
  if (isErrnoException(err) && err.code === 'ENOENT') {
    return `error: file not found: ${err.path ?? 'unknown path'}`
  }
  if (err instanceof Error) return `error: ${err.message}`
  return `error: ${String(err)}`
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException & { path?: string } {
  return err instanceof Error && 'code' in err
}

export interface CliIo {
  stdout: (text: string) => void
  stderr: (text: string) => void
}

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}

/**
 * 執行 CLI 主體並輸出 JSON，回傳 process exit code。
 *
 * 成功 → 印 JSON 到 stdout，回傳 0。
 * 失敗 → 印單行訊息到 stderr，回傳 1（永不靜默成功）。
 */
export function runCli(run: () => unknown, io: CliIo = defaultIo): number {
  try {
    io.stdout(`${JSON.stringify(run(), null, 2)}\n`)
    return 0
  } catch (err) {
    io.stderr(`${formatCliError(err)}\n`)
    return 1
  }
}
