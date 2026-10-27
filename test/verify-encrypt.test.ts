/**
 * 驗證模式 artifact 加密（ADR-029 §5；plan Task 3 擴大版）。
 *
 * 驗證類 run 的內容（agent stdout、specs、測試檔）在公開 runner 上以 age
 * 公鑰加密後才上傳；只有持有私鑰的 Worker 解得開。這支 CLI 的失敗模式是
 * 「密文外洩」或「下一階段缺檔」，兩者都不會有第二次訊號，故以測試釘住：
 *
 *   1. 加解密往返後 path 集合與位元組完全一致（含非 UTF-8 與含空白檔名）；
 *   2. 範圍：run／specs（含 dot files、排除 .lake/build）＋ agent 改動的測試檔；
 *   3. 公鑰缺漏或不合法時拋錯且不產生任何輸出檔（fail closed）；
 *   4. 機制 JSON（issue／crosscheck／model…）只以 `mechanism/<name>` 進密文，
 *      不再以明文 artifact 上傳；
 *   5. 根目錄（specs、.factory/run）是 symlink 或解析到 target 外 → 拋錯。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Decrypter, generateX25519Identity, identityToRecipient } from 'age-encryption'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  MECHANISM_PREFIX,
  VERIFY_MECHANISM_FILES,
  encryptVerifyBundle,
  main,
  parseArgs,
} from '../src/cli/factory-verify-encrypt.js'
import { isVerifyAllowedPath } from '../src/pipeline/verify-scope.js'

interface BundleLine {
  path: string
  b64: string
}

const created: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

function makeTarget(): string {
  return tempDir('factory-verify-target-')
}

function writeFixture(target: string, rel: string, content: string | Uint8Array): void {
  const abs = join(target, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

function git(target: string, ...args: string[]): string {
  return execFileSync('git', ['-C', target, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function commitAll(target: string, message: string): void {
  git(target, 'add', '-A')
  git(target, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', message)
}

async function decryptBundle(file: string, identity: string): Promise<BundleLine[]> {
  const decrypter = new Decrypter()
  decrypter.addIdentity(identity)
  const text = await decrypter.decrypt(readFileSync(file), 'text')
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as BundleLine)
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
  // 若某測試在 cleanup 前就讓 worker 失敗，仍不留下大型暫存目錄。
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

describe('encryptVerifyBundle：age 往返與 bundle 範圍', () => {
  it('路徑集合等於允許範圍，解密後非 UTF-8／含空白檔名的位元組完全一致', async () => {
    const target = makeTarget()
    const outDir = tempDir('factory-verify-out-')
    const outFile = join(outDir, 'verify-bundle.age')

    const binary = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x81, 0x0a, 0x7f])
    writeFixture(target, '.factory/run/report.json', '{"ok":true,"note":"café"}\n')
    writeFixture(target, '.factory/run/stdout.txt', 'agent stdout\n')
    writeFixture(target, '.factory/run/raw.bin', binary)
    writeFixture(target, '.factory/run/gh-token', 'github_pat_SECRET')
    writeFixture(target, '.factory/verify-mode.json', '{"verify":true}')
    writeFixture(target, 'specs/quint/model.qnt', 'module M {}')
    writeFixture(target, 'specs/lean/.gitignore', '.lake/\n')
    writeFixture(target, 'specs/lean/with space.lean', 'theorem x : True := by trivial\n')
    writeFixture(target, 'specs/lean/.lake/build/cache.olean', 'build cache')
    writeFixture(target, 'specs/lean/.lake/packages/Core/x.lean', 'package Core')
    writeFixture(target, 'test/verify.test.ts', 'it("x", () => {})')
    writeFixture(target, 'pkg/service/foo_test.go', 'package service')
    writeFixture(target, 'src/app.ts', 'export const answer = 42')
    writeFixture(target, 'docs/guide.md', '# guide')
    // 目錄 symlink 不得被跟隨（可能指向 target 外的敏感路徑）
    symlinkSync('/etc/passwd', join(target, 'specs/lean/outside-link'))

    const result = await encryptVerifyBundle({ targetDir: target, outFile, recipient })

    const expected = [
      '.factory/run/raw.bin',
      '.factory/run/report.json',
      '.factory/run/stdout.txt',
      'pkg/service/foo_test.go',
      'specs/lean/.gitignore',
      'specs/lean/.lake/packages/Core/x.lean',
      'specs/lean/with space.lean',
      'specs/quint/model.qnt',
      'test/verify.test.ts',
    ]
    expect(result.files).toEqual(expected)

    const lines = await decryptBundle(outFile, identity)
    expect(lines.map((line) => line.path)).toEqual(expected)
    for (const line of lines) {
      expect(line.b64).toBe(readFileSync(join(target, line.path)).toString('base64'))
    }
    expect(Buffer.from(lines.find((l) => l.path === '.factory/run/raw.bin')?.b64 ?? '', 'base64')).toEqual(binary)
    // 沒有明文側檔：輸出目錄只有密文。
    expect(readdirSync(outDir)).toEqual(['verify-bundle.age'])
  })

  it('.lake/build 下的檔案一律排除，但 .lake 的其他內容照常打包', async () => {
    const target = makeTarget()
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')
    writeFixture(target, 'specs/lean/.lake/build/one.olean', 'olean')
    writeFixture(target, 'specs/lean/.lake/build/nested/two.ilean', 'ilean')
    writeFixture(target, 'specs/lean/.lake/packages/Core.lean', 'core')
    writeFixture(target, 'specs/other/.lake/build/three.txt', 'three')

    const result = await encryptVerifyBundle({ targetDir: target, outFile, recipient })

    expect(result.files).toEqual(['specs/lean/.lake/packages/Core.lean'])
  })

  it('白名單外的檔案（src／docs／.github／.factory 非 run）不進 bundle', async () => {
    const target = makeTarget()
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')
    writeFixture(target, 'src/app.ts', 'export const x = 1')
    writeFixture(target, 'src/app.test.ts', 'test file under src')
    writeFixture(target, 'docs/guide.md', '# guide')
    writeFixture(target, '.github/workflows/ci.yml', 'name: ci')
    writeFixture(target, '.factory/model.json', '{"model":"x"}')

    const result = await encryptVerifyBundle({ targetDir: target, outFile, recipient })

    expect(result.files).toEqual(['src/app.test.ts'])
  })

  it('target/.factory/run 不存在時仍可打包 specs（不因缺目錄而丟掉整包）', async () => {
    const target = makeTarget()
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')
    writeFixture(target, 'specs/quint/model.qnt', 'module M {}')

    const result = await encryptVerifyBundle({ targetDir: target, outFile, recipient })

    expect(result.files).toEqual(['specs/quint/model.qnt'])
  })

  it('specs 與 .factory/run 都不存在（agent 失敗前）→ 兩個根都略過，仍產出 bundle', async () => {
    const target = makeTarget()
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')
    writeFixture(target, 'test/only.test.ts', 'only test')

    const result = await encryptVerifyBundle({ targetDir: target, outFile, recipient })

    expect(result.files).toEqual(['test/only.test.ts'])
    expect(existsSync(outFile)).toBe(true)
  })

  it('根目錄的錯誤只有 ENOENT 會略過：.factory 是檔案（ENOTDIR）→ 往外拋、不寫檔', async () => {
    const target = makeTarget()
    writeFixture(target, '.factory', 'a file where the run dir parent should be')
    writeFixture(target, 'specs/quint/model.qnt', 'module M {}')
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')

    await expect(encryptVerifyBundle({ targetDir: target, outFile, recipient })).rejects.toThrow(/ENOTDIR/)
    expect(existsSync(outFile)).toBe(false)
  })
})

describe('encryptVerifyBundle：根目錄不得是 symlink 或解析到 target 外（ADR-029 §5）', () => {
  it('specs 是指向 target 外的 symlink → 拋錯、不寫檔（不跟隨到 target 外打包）', async () => {
    const target = makeTarget()
    const outside = tempDir('factory-verify-outside-')
    writeFixture(outside, 'secret.lean', 'outside content')
    symlinkSync(outside, join(target, 'specs'))
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')

    await expect(encryptVerifyBundle({ targetDir: target, outFile, recipient })).rejects.toThrow(/specs.*symlink/)
    expect(existsSync(outFile)).toBe(false)
  })

  it('specs 是指向 target 內的 symlink → 一樣拋錯（根本身不得是 symlink）', async () => {
    const target = makeTarget()
    writeFixture(target, 'elsewhere/model.qnt', 'module M {}')
    symlinkSync(join(target, 'elsewhere'), join(target, 'specs'))
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')

    await expect(encryptVerifyBundle({ targetDir: target, outFile, recipient })).rejects.toThrow(/specs.*symlink/)
  })

  it('.factory/run 是 symlink → 拋錯', async () => {
    const target = makeTarget()
    const outside = tempDir('factory-verify-outside-')
    writeFixture(outside, 'stdout.txt', 'outside stdout')
    mkdirSync(join(target, '.factory'))
    symlinkSync(outside, join(target, '.factory/run'))
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')

    await expect(encryptVerifyBundle({ targetDir: target, outFile, recipient })).rejects.toThrow(/\.factory\/run.*symlink/)
    expect(existsSync(outFile)).toBe(false)
  })

  it('.factory 是 symlink、使 .factory/run 解析到 target 外 → 拋錯', async () => {
    const target = makeTarget()
    const outside = tempDir('factory-verify-outside-')
    writeFixture(outside, 'run/stdout.txt', 'outside stdout')
    symlinkSync(outside, join(target, '.factory'))
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')

    await expect(encryptVerifyBundle({ targetDir: target, outFile, recipient })).rejects.toThrow(/\.factory\/run.*target 外/)
    expect(existsSync(outFile)).toBe(false)
  })
})

describe('encryptVerifyBundle：機制 JSON 只以密文進 bundle（mechanism/<name>）', () => {
  function makeMechanismDir(): string {
    const dir = tempDir('factory-verify-mech-')
    writeFixture(dir, 'issue.json', '{"body":"target issue body"}')
    writeFixture(dir, 'crosscheck.json', '{"ok":true,"actualFiles":["specs/a.qnt"]}')
    writeFixture(dir, 'crosscheck.err', 'stderr line')
    writeFixture(dir, 'model.json', '{"tier":"standard"}')
    writeFixture(dir, 'verify-mode.json', '{"verify":true}')
    // 清單外的檔案一律不進 bundle（scoreboard-event 驗證模式根本不產生；steps／session-diag 走明文）
    writeFixture(dir, 'scoreboard-event.json', '{"skill_gap":"free text"}')
    writeFixture(dir, 'steps.json', '{"agent":"success"}')
    writeFixture(dir, 'pr-bodies.json', '[]')
    writeFixture(dir, 'verify-bundle.age', 'previous ciphertext')
    return dir
  }

  it('清單內存在的機制檔以 mechanism/<name> 打包、位元組不變；缺的（judge.json）略過', async () => {
    const target = makeTarget()
    writeFixture(target, 'specs/quint/model.qnt', 'module M {}')
    const mechanismDir = makeMechanismDir()
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')

    const result = await encryptVerifyBundle({ targetDir: target, outFile, recipient, mechanismDir })

    const expectedMechanism = [
      'mechanism/crosscheck.err',
      'mechanism/crosscheck.json',
      'mechanism/issue.json',
      'mechanism/model.json',
      'mechanism/verify-mode.json',
    ]
    expect(result.files).toEqual(['specs/quint/model.qnt'])
    expect(result.mechanism).toEqual(expectedMechanism)
    const lines = await decryptBundle(outFile, identity)
    expect(lines.map((l) => l.path)).toEqual(['specs/quint/model.qnt', ...expectedMechanism])
    for (const line of lines.filter((l) => l.path.startsWith(MECHANISM_PREFIX))) {
      const name = line.path.slice(MECHANISM_PREFIX.length)
      expect(line.b64).toBe(readFileSync(join(mechanismDir, name)).toString('base64'))
    }
  })

  it('未指定 mechanismDir → 不帶任何機制檔（mechanism 為空）', async () => {
    const target = makeTarget()
    writeFixture(target, 'specs/quint/model.qnt', 'module M {}')
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')

    const result = await encryptVerifyBundle({ targetDir: target, outFile, recipient })

    expect(result.mechanism).toEqual([])
  })

  it('機制檔是 symlink → 拋錯、不寫檔（不把 runner 上任意檔案打包）', async () => {
    const target = makeTarget()
    const mechanismDir = tempDir('factory-verify-mech-')
    symlinkSync('/etc/passwd', join(mechanismDir, 'issue.json'))
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')

    await expect(encryptVerifyBundle({ targetDir: target, outFile, recipient, mechanismDir })).rejects.toThrow(
      /issue\.json/,
    )
    expect(existsSync(outFile)).toBe(false)
  })

  it('mechanism/<name> 永遠不會是 target 的 bundle 路徑（解包端可依路徑分辨來源）', async () => {
    expect(VERIFY_MECHANISM_FILES).toEqual([
      'crosscheck.err',
      'crosscheck.json',
      'issue.json',
      'judge.json',
      'model.json',
      'verify-mode.json',
    ])
    for (const name of VERIFY_MECHANISM_FILES) {
      expect(isVerifyAllowedPath(`${MECHANISM_PREFIX}${name}`), name).toBe(false)
    }
    // 端到端：target 裡同名的檔案不會以 target 路徑進 bundle
    const target = makeTarget()
    writeFixture(target, 'mechanism/issue.json', 'planted by agent')
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')
    const result = await encryptVerifyBundle({ targetDir: target, outFile, recipient })
    expect(result.files).toEqual([])
  })
})

describe('encryptVerifyBundle：fail closed', () => {
  for (const bad of ['', '   ', 'not-an-age-key', 'AGE1EXAMPLE']) {
    it(`recipient=${JSON.stringify(bad)} → 拋錯且不寫任何檔案（含父目錄）`, async () => {
      const target = makeTarget()
      writeFixture(target, 'specs/quint/model.qnt', 'module M {}')
      const outDir = join(tempDir('factory-verify-out-'), 'nested')
      const outFile = join(outDir, 'bundle.age')

      await expect(encryptVerifyBundle({ targetDir: target, outFile, recipient: bad })).rejects.toThrow(/recipient/)
      await expect(encryptVerifyBundle({ targetDir: target, outFile, recipient: bad })).rejects.toThrow(/ADR-029 §5，/)
      expect(existsSync(outFile)).toBe(false)
      expect(existsSync(outDir)).toBe(false)
    })
  }

  it('以 age1 開頭但不合法的 recipient → age 套件拋錯，仍不寫檔', async () => {
    const target = makeTarget()
    writeFixture(target, 'specs/quint/model.qnt', 'module M {}')
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')

    await expect(encryptVerifyBundle({ targetDir: target, outFile, recipient: 'age1notavalidkey' })).rejects.toThrow()
    expect(existsSync(outFile)).toBe(false)
  })

  it('targetDir 不存在或不是目錄 → 明確錯誤（不得靜默產出空 bundle）', async () => {
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')
    await expect(
      encryptVerifyBundle({ targetDir: join(tmpdir(), 'factory-missing-target'), outFile, recipient }),
    ).rejects.toThrow(/target/)

    const fileAsTarget = join(tempDir('factory-verify-file-'), 'not-a-dir')
    writeFileSync(fileAsTarget, 'x')
    await expect(encryptVerifyBundle({ targetDir: fileAsTarget, outFile, recipient })).rejects.toThrow(/target/)
    expect(existsSync(outFile)).toBe(false)
  })

  it('specs 不是目錄時往外拋（打包不完整不得靜默通過）', async () => {
    const target = makeTarget()
    writeFixture(target, 'specs', 'this is a file, not a directory')
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')

    await expect(encryptVerifyBundle({ targetDir: target, outFile, recipient })).rejects.toThrow(/ENOTDIR|not a directory/)
    expect(existsSync(outFile)).toBe(false)
  })
})

describe('encryptVerifyBundle：只打包 agent 改動的測試檔（git 事實）', () => {
  it('以 origin/<base> 為基準：未改動的既有測試檔不進 bundle，修改與新增的才進', async () => {
    const target = makeTarget()
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')
    git(target, 'init', '-q', '-b', 'main')
    writeFixture(target, 'test/existing.test.ts', 'old body')
    writeFixture(target, 'src/app.test.ts', 'old body in src')
    writeFixture(target, 'src/app.ts', 'export const x = 1')
    commitAll(target, 'base')
    const baseTip = git(target, 'rev-parse', 'HEAD').trim()
    git(target, 'update-ref', 'refs/remotes/origin/main', baseTip)
    writeFixture(target, '.factory/run/base-branch', 'main')
    writeFixture(target, '.factory/run/report.json', '{"ok":true}')
    writeFixture(target, 'test/existing.test.ts', 'new body')
    writeFixture(target, 'tests/new_test.go', 'package tests')
    writeFixture(target, 'specs/lean/RULES.md', 'rules')
    // 未追蹤的 symlink 即使符合測試 glob 也不得被跟隨（可能指向 target 外）。
    symlinkSync('/etc/passwd', join(target, 'test/escape.test.ts'))

    const result = await encryptVerifyBundle({ targetDir: target, outFile, recipient })

    expect(result.files).toEqual([
      '.factory/run/base-branch',
      '.factory/run/report.json',
      'specs/lean/RULES.md',
      'test/existing.test.ts',
      'tests/new_test.go',
    ])
  })

  it('沒有 base-branch 檔時以 HEAD 的 diff＋untracked 判斷', async () => {
    const target = makeTarget()
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')
    git(target, 'init', '-q', '-b', 'main')
    writeFixture(target, 'test/existing.test.ts', 'old body')
    commitAll(target, 'base')
    writeFixture(target, 'test/existing.test.ts', 'new body')
    writeFixture(target, 'pkg/added_test.go', 'package pkg')

    const result = await encryptVerifyBundle({ targetDir: target, outFile, recipient })

    expect(result.files).toEqual(['pkg/added_test.go', 'test/existing.test.ts'])
  })

  it('沒有 origin remote-tracking ref 時退回本地 base 分支', async () => {
    const target = makeTarget()
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')
    git(target, 'init', '-q', '-b', 'main')
    writeFixture(target, 'test/existing.test.ts', 'old body')
    commitAll(target, 'base')
    writeFixture(target, '.factory/run/base-branch', 'main')
    writeFixture(target, 'test/existing.test.ts', 'new body')

    const result = await encryptVerifyBundle({ targetDir: target, outFile, recipient })

    expect(result.files).toEqual(['.factory/run/base-branch', 'test/existing.test.ts'])
  })

  it('base-branch 檔是空字串時視為未設定，退回 HEAD', async () => {
    const target = makeTarget()
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')
    git(target, 'init', '-q', '-b', 'main')
    writeFixture(target, 'test/existing.test.ts', 'old body')
    commitAll(target, 'base')
    writeFixture(target, '.factory/run/base-branch', '')
    writeFixture(target, 'test/existing.test.ts', 'new body')

    const result = await encryptVerifyBundle({ targetDir: target, outFile, recipient })

    expect(result.files).toEqual(['.factory/run/base-branch', 'test/existing.test.ts'])
  })

  it('base-branch 檔指向不存在的 ref 時退回 HEAD（不得整包漏掉修改）', async () => {
    const target = makeTarget()
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')
    git(target, 'init', '-q', '-b', 'main')
    writeFixture(target, 'test/existing.test.ts', 'old body')
    commitAll(target, 'base')
    writeFixture(target, '.factory/run/base-branch', 'does-not-exist')
    writeFixture(target, 'test/existing.test.ts', 'new body')

    const result = await encryptVerifyBundle({ targetDir: target, outFile, recipient })

    expect(result.files).toEqual(['.factory/run/base-branch', 'test/existing.test.ts'])
  })

  it('空 git repo（尚無 commit）→ 退回掃描白名單檔案，新測試檔照樣進 bundle', async () => {
    const target = makeTarget()
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')
    git(target, 'init', '-q', '-b', 'main')
    writeFixture(target, 'test/new.test.ts', 'brand new')

    const result = await encryptVerifyBundle({ targetDir: target, outFile, recipient })

    expect(result.files).toEqual(['test/new.test.ts'])
  })
})

describe('CLI：parseArgs／main', () => {
  it('旗標任意順序皆可，值正確映射', () => {
    expect(
      parseArgs(['--out', '/tmp/x.age', '--recipient', 'age1abc', '--target', 'target']),
    ).toEqual({ targetDir: 'target', outFile: '/tmp/x.age', recipient: 'age1abc' })
  })

  it('--mechanism-dir 選填：有給才映射', () => {
    expect(
      parseArgs(['--target', 't', '--out', '/tmp/x.age', '--recipient', 'age1abc', '--mechanism-dir', '.factory']),
    ).toEqual({ targetDir: 't', outFile: '/tmp/x.age', recipient: 'age1abc', mechanismDir: '.factory' })
    expect(() =>
      parseArgs(['--target', 't', '--out', '/tmp/x.age', '--recipient', 'age1abc', '--mechanism-dir', ' ']),
    ).toThrow(/mechanism-dir/)
  })

  it('未知旗標、缺值 → CliError（不吞掉打錯的旗標）', () => {
    expect(() => parseArgs(['--target', 'target', '--out', '/tmp/x.age', '--recipient', 'age1x', '--dry-run'])).toThrow(
      /unknown argument/,
    )
    expect(() => parseArgs(['--target', 'target', '--out', '/tmp/x.age', '--recipient'])).toThrow(/recipient/)
    expect(() => parseArgs(['--target', '--out', '/tmp/x.age', '--recipient', 'age1x'])).toThrow(/target/)
    expect(() => parseArgs(['--out', '/tmp/x.age', '--recipient', 'age1x'])).toThrow(/target/)
    expect(() => parseArgs(['--target', 'target', '--recipient', 'age1x'])).toThrow(/out/)
    expect(() => parseArgs(['--target', 'target', '--out', '/tmp/x.age'])).toThrow(/recipient/)
  })

  it('空白的 target／out → CliError；空 recipient 留給加密層 fail closed', () => {
    expect(() => parseArgs(['--target', '', '--out', '/tmp/x.age', '--recipient', 'age1x'])).toThrow(/target/)
    expect(() => parseArgs(['--target', 'target', '--out', '  ', '--recipient', 'age1x'])).toThrow(/out/)
    expect(parseArgs(['--target', 'target', '--out', '/tmp/x.age', '--recipient', ''])).toEqual({
      targetDir: 'target',
      outFile: '/tmp/x.age',
      recipient: '',
    })
  })

  it('main 把 CLI 參數接到 encryptVerifyBundle', async () => {
    const target = makeTarget()
    writeFixture(target, 'specs/quint/model.qnt', 'module M {}')
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')

    await expect(main(['--target', target, '--out', outFile, '--recipient', recipient])).resolves.toEqual({
      files: ['specs/quint/model.qnt'],
      mechanism: [],
    })
    expect(existsSync(outFile)).toBe(true)
    // 空 recipient：main 也必須失敗（workflow 缺 secret 時 shell 會先擋，這裡是第二道）
    await expect(main(['--target', target, '--out', outFile, '--recipient', ''])).rejects.toThrow(/recipient/)
  })
})
