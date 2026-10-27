/**
 * 階段輸入 bundle 的還原（ADR-029 §5；plan V2 Task 6，ruling R7）。
 *
 * aswf.dev（V3）把上一階段的產出與 G1／G2 確認後的 RULES.md／TRIAGE.md 以 **runner
 * 公鑰**加密成同一格式的 bundle；runner 在 agent 之前解密並還原到 `target/`。
 * 這是把外部輸入寫進 agent 工作區的唯一入口，失敗模式是「寫到白名單外」或
 * 「寫一半」——兩者都不會有第二次訊號，所以本檔釘住：
 *
 *   1. 只接受 `kind: "target"`；任何 `mechanism` 行 → 整份拒絕（R7：不依路徑分流）；
 *   2. 路徑必須是白名單（`isVerifyAllowedPath`）或 `specs/**`；絕對路徑、`..`、空路徑、
 *      NUL、經 symlink 的寫入、落在 target 外 → 整份拒絕；
 *   3. 拒絕時**不寫任何檔**（先全部驗證、再寫）；
 *   4. 合法 bundle 位元組不變地還原，已存在的檔案被覆寫；
 *   5. CLI 只印還原數量，不印路徑（run log 是公開的）。
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { Encrypter, generateX25519Identity, identityToRecipient } from 'age-encryption'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { encryptVerifyBundle } from '../src/cli/factory-verify-encrypt.js'
import { main, parseArgs, restoreVerifyInput } from '../src/cli/factory-verify-input.js'

interface Line {
  kind?: unknown
  path?: unknown
  b64?: unknown
  [extra: string]: unknown
}

const created: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

function writeFixture(root: string, rel: string, content: string | Uint8Array): void {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

/** 目錄樹快照（相對路徑 → 內容／symlink 目標），用來斷言「拒絕時什麼都沒寫」。 */
function snapshot(root: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
    const abs = join(root, childRel)
    if (entry.isSymbolicLink()) out[childRel] = `-> ${relative(root, abs)}`
    else if (entry.isDirectory()) {
      out[`${childRel}/`] = 'dir'
      Object.assign(out, snapshot(root, childRel))
    } else out[childRel] = readFileSync(abs, 'base64')
  }
  return out
}

function line(path: string, content: string | Uint8Array, kind = 'target'): Line {
  return { kind, path, b64: Buffer.from(content).toString('base64') }
}

async function encryptLines(lines: readonly (Line | string)[]): Promise<Uint8Array> {
  const text = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')
  const encrypter = new Encrypter()
  encrypter.addRecipient(recipient)
  return encrypter.encrypt(`${text}\n`)
}

let identity: string
let recipient: string

beforeAll(async () => {
  identity = await generateX25519Identity()
  recipient = await identityToRecipient(identity)
})

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

const RULES = '# RULES\n\n- R1: 餘額不得為負\n'
const TRIAGE = '# TRIAGE\n\n| id | 判定 |\n'
const BINARY = Uint8Array.from([0x00, 0xff, 0xfe, 0x80, 0x0a, 0x7f])

describe('restoreVerifyInput：合法 bundle 位元組不變地還原', () => {
  it('還原 RULES.md／TRIAGE.md／specs dot file／二進位 specs／測試檔，回傳排序後路徑', async () => {
    const target = tempDir('verify-input-target-')
    const bundle = await encryptLines([
      line('specs/quint/RULES.md', RULES),
      line('specs/quint/TRIAGE.md', TRIAGE),
      line('specs/lean/.gitignore', '.lake/\n'),
      line('specs/quint/trace.itf.bin', BINARY),
      line('test/ledger.test.ts', 'it("x", () => {})\n'),
      line('pkg/ledger/ledger_test.go', 'package ledger\n'),
    ])

    const result = await restoreVerifyInput({ bundle, identity, targetDir: target })

    expect(result.restored).toEqual([
      'pkg/ledger/ledger_test.go',
      'specs/lean/.gitignore',
      'specs/quint/RULES.md',
      'specs/quint/TRIAGE.md',
      'specs/quint/trace.itf.bin',
      'test/ledger.test.ts',
    ])
    expect(readFileSync(join(target, 'specs/quint/RULES.md'), 'utf8')).toBe(RULES)
    expect(readFileSync(join(target, 'specs/quint/TRIAGE.md'), 'utf8')).toBe(TRIAGE)
    expect(readFileSync(join(target, 'specs/lean/.gitignore'), 'utf8')).toBe('.lake/\n')
    expect(new Uint8Array(readFileSync(join(target, 'specs/quint/trace.itf.bin')))).toEqual(BINARY)
    expect(readFileSync(join(target, 'test/ledger.test.ts'), 'utf8')).toBe('it("x", () => {})\n')
  })

  it('已存在的檔案以 bundle 內容覆寫；bundle 外的既有檔案不動', async () => {
    const target = tempDir('verify-input-target-')
    writeFixture(target, 'specs/quint/RULES.md', 'stale rules from the previous run')
    writeFixture(target, 'specs/quint/model.qnt', 'module Keep {}')
    writeFixture(target, 'src/app.ts', 'export const x = 1')
    const bundle = await encryptLines([line('specs/quint/RULES.md', RULES)])

    await restoreVerifyInput({ bundle, identity, targetDir: target })

    expect(readFileSync(join(target, 'specs/quint/RULES.md'), 'utf8')).toBe(RULES)
    expect(readFileSync(join(target, 'specs/quint/model.qnt'), 'utf8')).toBe('module Keep {}')
    expect(readFileSync(join(target, 'src/app.ts'), 'utf8')).toBe('export const x = 1')
  })

  it('與 factory-verify-encrypt 往返：上一階段的 target 行可原樣還原到新的 target', async () => {
    const previous = tempDir('verify-input-prev-')
    writeFixture(previous, 'specs/quint/RULES.md', RULES)
    writeFixture(previous, 'specs/lean/.gitignore', '.lake/\n')
    writeFixture(previous, 'test/rules.test.ts', 'test body')
    const outFile = join(tempDir('verify-input-out-'), 'bundle.age')
    const encrypted = await encryptVerifyBundle({ targetDir: previous, outFile, recipient })
    const next = tempDir('verify-input-next-')

    const result = await restoreVerifyInput({ bundle: readFileSync(outFile), identity, targetDir: next })

    expect(result.restored).toEqual(encrypted.files)
    for (const rel of encrypted.files) {
      expect(readFileSync(join(next, rel)).equals(readFileSync(join(previous, rel))), rel).toBe(true)
    }
  })

  it('空 bundle（沒有任何行）→ 還原 0 個檔案', async () => {
    const target = tempDir('verify-input-target-')
    const encrypter = new Encrypter()
    encrypter.addRecipient(recipient)
    const bundle = await encrypter.encrypt('')

    await expect(restoreVerifyInput({ bundle, identity, targetDir: target })).resolves.toEqual({ restored: [] })
  })

  it('target 內的既有目錄（非 symlink）照常寫入', async () => {
    const target = tempDir('verify-input-target-')
    mkdirSync(join(target, 'specs/quint'), { recursive: true })
    const bundle = await encryptLines([line('specs/quint/RULES.md', RULES)])

    await restoreVerifyInput({ bundle, identity, targetDir: target })

    expect(lstatSync(join(target, 'specs/quint')).isDirectory()).toBe(true)
    expect(readFileSync(join(target, 'specs/quint/RULES.md'), 'utf8')).toBe(RULES)
  })
})

describe('restoreVerifyInput：整份拒絕（fail closed，不寫任何檔）', () => {
  /** 一份合法的開頭行：證明拒絕發生在任何寫入之前（不是「寫到壞行才停」）。 */
  const GOOD = line('specs/quint/RULES.md', RULES)

  async function expectRejected(
    bad: readonly (Line | string)[],
    message: RegExp,
    prepare?: (target: string) => void,
  ): Promise<string> {
    const target = tempDir('verify-input-target-')
    writeFixture(target, 'specs/quint/TRIAGE.md', 'existing triage')
    prepare?.(target)
    const before = snapshot(target)
    const bundle = await encryptLines([GOOD, ...bad])

    await expect(restoreVerifyInput({ bundle, identity, targetDir: target })).rejects.toThrow(message)

    expect(snapshot(target)).toEqual(before)
    expect(existsSync(join(target, 'specs/quint/RULES.md'))).toBe(false)
    return target
  }

  it('含 mechanism 行（即使檔名看似無害）→ 拒絕（R7：還原端只收 target）', async () => {
    await expectRejected([line('issue.json', '{"body":"x"}', 'mechanism')], /mechanism/)
  })

  it('kind 缺漏或不是 target／mechanism → 拒絕', async () => {
    await expectRejected([{ path: 'specs/a.qnt', b64: '' }], /kind/)
    await expectRejected([line('specs/a.qnt', 'x', 'TARGET')], /kind/)
  })

  it('`../x` → 拒絕', async () => {
    await expectRejected([line('../x', 'escape')], /\.\./)
  })

  it('specs 內夾 `..` 的路徑（specs/../../x）→ 拒絕', async () => {
    await expectRejected([line('specs/../../outside.txt', 'escape')], /\.\./)
  })

  it('絕對路徑 `/etc/passwd` → 拒絕', async () => {
    await expectRejected([line('/etc/passwd', 'root::0:0')], /絕對路徑/)
  })

  it('白名單外的 `src/app.ts` → 拒絕', async () => {
    await expectRejected([line('src/app.ts', 'export const pwned = true')], /白名單/)
  })

  it('白名單外的 `.github/workflows/ci.yml` 與 `package.json` → 拒絕', async () => {
    await expectRejected([line('.github/workflows/ci.yml', 'on: push')], /白名單/)
    await expectRejected([line('package.json', '{}')], /白名單/)
  })

  it('符合測試 glob 但落在 `.git`／`.factory` 下 → 拒絕（版本庫與 run 目錄不可由輸入寫入）', async () => {
    await expectRejected([line('.git/test/x', 'x')], /\.git/)
    await expectRejected([line('specs/.git/config', '[core]')], /\.git/)
    await expectRejected([line('.factory/run/test/x', 'x')], /\.factory/)
  })

  it('空路徑、NUL、反斜線、空 segment（a//b）、`.` segment → 拒絕', async () => {
    await expectRejected([line('', 'x')], /path/)
    await expectRejected([line('specs/a\u0000.qnt', 'x')], /NUL/)
    await expectRejected([line('specs\\..\\x', 'x')], /反斜線/)
    await expectRejected([line('specs//a.qnt', 'x')], /segment/)
    await expectRejected([line('specs/./a.qnt', 'x')], /segment/)
    await expectRejected([line('specs/quint/', 'x')], /segment/)
  })

  it('經 target 內的 symlink 目錄寫入 → 拒絕（即使 symlink 指向 target 內）', async () => {
    await expectRejected([line('specs/link/RULES.md', 'via link')], /symlink/, (target) => {
      mkdirSync(join(target, 'real'), { recursive: true })
      symlinkSync(join(target, 'real'), join(target, 'specs/link'))
    })
  })

  it('specs 本身是指向 target 外的 symlink → 拒絕，target 外不被寫入', async () => {
    const outside = tempDir('verify-input-outside-')
    const target = tempDir('verify-input-target-')
    symlinkSync(outside, join(target, 'specs'))
    const bundle = await encryptLines([line('specs/quint/RULES.md', RULES)])

    await expect(restoreVerifyInput({ bundle, identity, targetDir: target })).rejects.toThrow(/symlink/)

    expect(readdirSync(outside)).toEqual([])
  })

  it('目標檔本身是 symlink（指向 target 外）→ 拒絕，不經 symlink 覆寫', async () => {
    const outside = tempDir('verify-input-outside-')
    writeFixture(outside, 'victim.txt', 'do not touch')
    await expectRejected([line('specs/quint/victim.md', 'overwrite')], /symlink/, (target) => {
      mkdirSync(join(target, 'specs/quint'), { recursive: true })
      symlinkSync(join(outside, 'victim.txt'), join(target, 'specs/quint/victim.md'))
    })
    expect(readFileSync(join(outside, 'victim.txt'), 'utf8')).toBe('do not touch')
  })

  it('目標路徑是既有目錄、或上層 segment 是既有檔案 → 拒絕（不寫一半）', async () => {
    await expectRejected([line('specs/dir', 'x')], /不是一般檔案/, (target) => {
      mkdirSync(join(target, 'specs/dir'), { recursive: true })
    })
    await expectRejected([line('specs/quint/TRIAGE.md/inner.md', 'x')], /不是目錄/)
  })

  it('重複路徑、或一個路徑是另一個的上層 → 拒絕（結果不確定）', async () => {
    await expectRejected([line('specs/quint/RULES.md', 'second copy')], /重複/)
    await expectRejected([line('specs/a', 'file'), line('specs/a/b.qnt', 'nested')], /上層/)
  })

  it('非 JSON 行、不是物件、b64 不合法 → 拒絕', async () => {
    await expectRejected(['not json'], /JSON/)
    await expectRejected(['["specs/a.qnt"]'], /物件/)
    await expectRejected([{ kind: 'target', path: 'specs/a.qnt', b64: '***' }], /b64/)
    await expectRejected([{ kind: 'target', path: 'specs/a.qnt' }], /b64/)
    await expectRejected([{ kind: 'target', path: 42, b64: '' }], /path/)
  })

  it('私鑰不對或密文損毀 → 拒絕、不寫檔', async () => {
    const target = tempDir('verify-input-target-')
    const bundle = await encryptLines([GOOD])
    const otherIdentity = await generateX25519Identity()

    await expect(restoreVerifyInput({ bundle, identity: otherIdentity, targetDir: target })).rejects.toThrow(/解密/)
    const corrupted = Uint8Array.from(bundle)
    corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1] ?? 0) ^ 0xff
    await expect(restoreVerifyInput({ bundle: corrupted, identity, targetDir: target })).rejects.toThrow(/解密/)
    expect(readdirSync(target)).toEqual([])
  })

  it('identity 空白或不是 AGE-SECRET-KEY-1… → 拒絕（缺 secret 時 fail closed）', async () => {
    const target = tempDir('verify-input-target-')
    const bundle = await encryptLines([GOOD])
    for (const bad of ['', '   ', 'age1notaprivatekey']) {
      await expect(restoreVerifyInput({ bundle, identity: bad, targetDir: target })).rejects.toThrow(/identity/)
    }
    expect(readdirSync(target)).toEqual([])
  })

  it('targetDir 不存在或不是目錄 → 拒絕', async () => {
    const bundle = await encryptLines([GOOD])
    await expect(
      restoreVerifyInput({ bundle, identity, targetDir: join(tmpdir(), 'verify-input-missing-target') }),
    ).rejects.toThrow(/target/)
    const file = join(tempDir('verify-input-file-'), 'not-a-dir')
    writeFileSync(file, 'x')
    await expect(restoreVerifyInput({ bundle, identity, targetDir: file })).rejects.toThrow(/target/)
  })
})

describe('CLI：parseArgs／main（只印數量）', () => {
  it('--bundle／--identity-env／--target 映射', () => {
    expect(parseArgs(['--target', 'target', '--bundle', 'b.age', '--identity-env', 'VERIFY_RUNNER_AGE_IDENTITY'])).toEqual({
      bundleFile: 'b.age',
      identityEnv: 'VERIFY_RUNNER_AGE_IDENTITY',
      targetDir: 'target',
    })
  })

  it('缺旗標、缺值、空值、未知旗標 → CliError', () => {
    expect(() => parseArgs(['--identity-env', 'X', '--target', 't'])).toThrow(/--bundle/)
    expect(() => parseArgs(['--bundle', 'b', '--target', 't'])).toThrow(/--identity-env/)
    expect(() => parseArgs(['--bundle', 'b', '--identity-env', 'X'])).toThrow(/--target/)
    expect(() => parseArgs(['--bundle', '--target', 't'])).toThrow(/requires a value/)
    expect(() => parseArgs(['--bundle', ' ', '--identity-env', 'X', '--target', 't'])).toThrow(/must not be empty/)
    expect(() => parseArgs(['--bundle', 'b', '--identity-env', 'X', '--target', 't', '--force', 'y'])).toThrow(
      /unknown argument/,
    )
  })

  it('main 從具名 env 讀私鑰、只回傳還原數量（不回傳路徑，run log 公開）', async () => {
    const target = tempDir('verify-input-target-')
    const bundleFile = join(tempDir('verify-input-bundle-'), 'input.age')
    writeFileSync(bundleFile, await encryptLines([line('specs/quint/RULES.md', RULES), line('specs/quint/TRIAGE.md', TRIAGE)]))

    const result = await main(['--bundle', bundleFile, '--identity-env', 'TEST_RUNNER_IDENTITY', '--target', target], {
      TEST_RUNNER_IDENTITY: identity,
    })

    expect(result).toEqual({ restored: 2 })
    expect(JSON.stringify(result)).not.toContain('RULES')
    expect(readFileSync(join(target, 'specs/quint/RULES.md'), 'utf8')).toBe(RULES)
  })

  it('main：具名 env 未設定或空白 → 拒絕（fail closed），不寫檔', async () => {
    const target = tempDir('verify-input-target-')
    const bundleFile = join(tempDir('verify-input-bundle-'), 'input.age')
    writeFileSync(bundleFile, await encryptLines([line('specs/quint/RULES.md', RULES)]))
    const argv = ['--bundle', bundleFile, '--identity-env', 'TEST_RUNNER_IDENTITY', '--target', target]

    await expect(main(argv, {})).rejects.toThrow(/TEST_RUNNER_IDENTITY/)
    await expect(main(argv, { TEST_RUNNER_IDENTITY: '  ' })).rejects.toThrow(/TEST_RUNNER_IDENTITY/)
    expect(readdirSync(target)).toEqual([])
  })
})
