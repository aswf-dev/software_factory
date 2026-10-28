import { describe, expect, it } from 'vitest'
import { CliError, formatCliError, runCli, runCliAsync, type CliIo } from './run-cli.js'

function captureIo(): CliIo & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { out, err, stdout: (t) => out.push(t), stderr: (t) => err.push(t) }
}

describe('formatCliError', () => {
  it('CliError → 單行 error 訊息，不含 stack', () => {
    expect(formatCliError(new CliError('bad flag'))).toBe('error: bad flag')
  })

  it('ENOENT → 指出缺少的檔案路徑，而非 raw stack trace', () => {
    const err = Object.assign(new Error('ENOENT: no such file'), {
      code: 'ENOENT',
      path: '/tmp/missing.yaml',
    })
    expect(formatCliError(err)).toBe('error: file not found: /tmp/missing.yaml')
  })

  it('ENOENT 缺 path 欄位時仍給出可讀訊息', () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    expect(formatCliError(err)).toBe('error: file not found: unknown path')
  })

  it('其他 Error（如 YAML 解析失敗）保留原訊息', () => {
    expect(formatCliError(new TypeError('boom'))).toBe('error: boom')
  })

  it('非 Error 的 throw 值也能轉成訊息', () => {
    expect(formatCliError('plain string')).toBe('error: plain string')
  })

  it('帶 code 但非 ENOENT 的錯誤走一般 Error 路徑', () => {
    const err = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    expect(formatCliError(err)).toBe('error: permission denied')
  })
})

describe('runCli', () => {
  it('成功時輸出 JSON 到 stdout 並回傳 exit code 0', () => {
    const io = captureIo()
    const code = runCli(() => ({ score: { total: 3 } }), io)
    expect(code).toBe(0)
    expect(io.err).toEqual([])
    expect(JSON.parse(io.out.join(''))).toEqual({ score: { total: 3 } })
  })

  it('失敗時回傳 exit code 1 —— 絕不可靜默成功', () => {
    // 這是最關鍵的一條：CLI 是 CI gate，計分失敗若以 0 結束，
    // oversight 檢查會被誤判為通過。
    const io = captureIo()
    const code = runCli(() => {
      throw new CliError('--catalog requires a path argument')
    }, io)
    expect(code).toBe(1)
    expect(io.out).toEqual([])
    expect(io.err.join('')).toBe('error: --catalog requires a path argument\n')
  })

  it('預設 io 走 process.stdout（不指定 io 時可執行）', () => {
    const written: string[] = []
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      expect(runCli(() => ({ ok: true }))).toBe(0)
    } finally {
      process.stdout.write = original
    }
    expect(JSON.parse(written.join(''))).toEqual({ ok: true })
  })

  it('預設 io 的錯誤輸出走 process.stderr', () => {
    const written: string[] = []
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      expect(
        runCli(() => {
          throw new CliError('boom')
        }),
      ).toBe(1)
    } finally {
      process.stderr.write = original
    }
    expect(written.join('')).toBe('error: boom\n')
  })
})

describe('runCliAsync', () => {
  it('等待 async 主體後才輸出 JSON（不得把 Promise 印成 {} 並 exit 0）', async () => {
    const io = captureIo()
    const code = await runCliAsync(async () => {
      await Promise.resolve()
      return { files: ['specs/a.qnt'] }
    }, io)
    expect(code).toBe(0)
    expect(io.err).toEqual([])
    expect(JSON.parse(io.out.join(''))).toEqual({ files: ['specs/a.qnt'] })
  })

  it('async 主體 reject → exit code 1 且只印單行錯誤', async () => {
    const io = captureIo()
    const code = await runCliAsync(async () => {
      throw new CliError('recipient 不合法')
    }, io)
    expect(code).toBe(1)
    expect(io.out).toEqual([])
    expect(io.err.join('')).toBe('error: recipient 不合法\n')
  })

  it('預設 io 可用（成功走 process.stdout、失敗走 process.stderr）', async () => {
    const out: string[] = []
    const err: string[] = []
    const originalOut = process.stdout.write.bind(process.stdout)
    const originalErr = process.stderr.write.bind(process.stderr)
    process.stdout.write = ((chunk: string) => {
      out.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    process.stderr.write = ((chunk: string) => {
      err.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      expect(await runCliAsync(async () => ({ ok: true }))).toBe(0)
      expect(
        await runCliAsync(async () => {
          throw new CliError('boom')
        }),
      ).toBe(1)
    } finally {
      process.stdout.write = originalOut
      process.stderr.write = originalErr
    }
    expect(JSON.parse(out.join(''))).toEqual({ ok: true })
    expect(err.join('')).toBe('error: boom\n')
  })
})
