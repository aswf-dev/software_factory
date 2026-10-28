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
 *   4. 機制 JSON（issue／crosscheck／model…）只以 `kind: "mechanism"`＋裸檔名進密文，
 *      不再以明文 artifact 上傳；每行以 `kind` 標明來源（ruling R7），不靠路徑前綴；
 *   5. 根目錄（specs、.factory/run）是 symlink 或解析到 target 外 → 拋錯。
 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Decrypter, generateX25519Identity, identityToRecipient } from 'age-encryption'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import * as encryptModule from '../src/cli/factory-verify-encrypt.js'
import { VERIFY_MECHANISM_FILES, encryptVerifyBundle, main, parseArgs } from '../src/cli/factory-verify-encrypt.js'
import { CliError, formatCliError } from '../src/cli/run-cli.js'
import { isVerifyAllowedPath } from '../src/pipeline/verify-scope.js'

interface BundleLine {
  kind: 'target' | 'mechanism'
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
    // 每一行都帶 kind（ruling R7）；沒有 mechanismDir 時全是 target，且欄位只有這三個
    for (const line of lines) expect(Object.keys(line).sort()).toEqual(['b64', 'kind', 'path'])
    expect(new Set(lines.map((line) => line.kind))).toEqual(new Set(['target']))
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

  it('C1：specs/.github/** 不進 bundle（.github segment 一律拒絕），其餘 specs 照常', async () => {
    const target = makeTarget()
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')
    writeFixture(target, 'specs/.github/workflows/x.test.yml', 'on: push')
    writeFixture(target, 'specs/quint/model.qnt', 'module M {}')

    const result = await encryptVerifyBundle({ targetDir: target, outFile, recipient })

    expect(result.files).toEqual(['specs/quint/model.qnt'])
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

describe('encryptVerifyBundle：機制 JSON 只以密文進 bundle（kind: mechanism、裸檔名）', () => {
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

  it('清單內存在的機制檔以 kind=mechanism＋裸檔名打包、位元組不變；缺的（judge.json）略過', async () => {
    const target = makeTarget()
    writeFixture(target, 'specs/quint/model.qnt', 'module M {}')
    const mechanismDir = makeMechanismDir()
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')

    const result = await encryptVerifyBundle({ targetDir: target, outFile, recipient, mechanismDir })

    const expectedMechanism = ['crosscheck.err', 'crosscheck.json', 'issue.json', 'model.json', 'verify-mode.json']
    expect(result.files).toEqual(['specs/quint/model.qnt'])
    expect(result.mechanism).toEqual(expectedMechanism)
    const lines = await decryptBundle(outFile, identity)
    expect(lines.map((l) => [l.kind, l.path])).toEqual([
      ['target', 'specs/quint/model.qnt'],
      ...expectedMechanism.map((name) => ['mechanism', name]),
    ])
    for (const line of lines.filter((l) => l.kind === 'mechanism')) {
      expect(line.b64).toBe(readFileSync(join(mechanismDir, line.path)).toString('base64'))
    }
    // 往返：target 行解回原位元組
    const targetLine = lines.find((l) => l.kind === 'target')
    expect(Buffer.from(targetLine?.b64 ?? '', 'base64').toString('utf8')).toBe('module M {}')
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

  it('來源只由 kind 決定：不匯出路徑前綴慣例，target 內同名檔案仍是 kind=target（R7）', async () => {
    // 前綴慣例一旦匯出，就會有消費端「依路徑前綴分流」——ruling R7 要求只看 kind。
    expect(Object.keys(encryptModule)).not.toContain('MECHANISM_PREFIX')
    expect(VERIFY_MECHANISM_FILES).toEqual([
      'crosscheck.err',
      'crosscheck.json',
      'issue.json',
      'judge.json',
      'model.json',
      'verify-mode.json',
    ])
    // 機制檔名本身不是 target 的白名單路徑（不會與 target 行重名而誤導讀者）
    for (const name of VERIFY_MECHANISM_FILES) expect(isVerifyAllowedPath(name), name).toBe(false)
    // 端到端：agent 在 specs 下種一個同名檔案，它仍是 kind=target 的 specs 路徑；
    // 真正的機制檔只以 kind=mechanism 出現。
    const target = makeTarget()
    writeFixture(target, 'specs/issue.json', 'planted by agent')
    writeFixture(target, 'mechanism/issue.json', 'planted by agent')
    const mechanismDir = tempDir('factory-verify-mech-')
    writeFixture(mechanismDir, 'issue.json', '{"body":"real"}')
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')
    const result = await encryptVerifyBundle({ targetDir: target, outFile, recipient, mechanismDir })
    expect(result.files).toEqual(['specs/issue.json'])
    expect(result.mechanism).toEqual(['issue.json'])
    const lines = await decryptBundle(outFile, identity)
    expect(lines.map((l) => [l.kind, l.path])).toEqual([
      ['target', 'specs/issue.json'],
      ['mechanism', 'issue.json'],
    ])
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

describe('I7：檔案系統錯誤只帶相對路徑與 errno（公開 log 不得出現絕對 target 路徑）', () => {
  const isRoot = process.getuid?.() === 0

  /** 執行加密並要求以 CliError 失敗。 */
  async function failureOf(target: string, outFile: string): Promise<Error> {
    const error = await encryptVerifyBundle({ targetDir: target, outFile, recipient }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CliError)
    return error as Error
  }

  it('無法列舉的 specs 子目錄 → 訊息含相對路徑與 EACCES，不含絕對 target 路徑', async () => {
    // root 不受目錄權限限制，這個情境無法重現（CI 與本機都以一般使用者執行）。
    if (isRoot) return
    const target = makeTarget()
    writeFixture(target, 'specs/locked/secret.lean', 'secret')
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')
    chmodSync(join(target, 'specs/locked'), 0o000)
    try {
      const error = await failureOf(target, outFile)
      expect(error.message).toContain('specs/locked')
      expect(error.message).toMatch(/EACCES/)
      expect(error.message).not.toContain(target)
      expect(formatCliError(error)).not.toContain(target)
    } finally {
      chmodSync(join(target, 'specs/locked'), 0o700)
    }
    expect(existsSync(outFile)).toBe(false)
  })

  it('列出後才發現不可讀的檔案（readFile EACCES）→ 只帶相對路徑與 errno', async () => {
    if (isRoot) return
    const target = makeTarget()
    writeFixture(target, 'specs/lean/RULES.md', 'private rules')
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')
    chmodSync(join(target, 'specs/lean/RULES.md'), 0o000)
    try {
      const error = await failureOf(target, outFile)
      expect(error.message).toContain('specs/lean/RULES.md')
      expect(error.message).toMatch(/EACCES/)
      expect(error.message).not.toContain(target)
      expect(formatCliError(error)).not.toContain(target)
    } finally {
      chmodSync(join(target, 'specs/lean/RULES.md'), 0o600)
    }
    expect(existsSync(outFile)).toBe(false)
  })

  it('同樣的檔案可讀時照常打包（既有的 happy path 不變）', async () => {
    const target = makeTarget()
    writeFixture(target, 'specs/lean/RULES.md', 'private rules')
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')

    const result = await encryptVerifyBundle({ targetDir: target, outFile, recipient })

    expect(result.files).toEqual(['specs/lean/RULES.md'])
    const lines = await decryptBundle(outFile, identity)
    expect(lines.map((line) => [line.kind, line.path, Buffer.from(line.b64, 'base64').toString('utf8')])).toEqual([
      ['target', 'specs/lean/RULES.md', 'private rules'],
    ])
  })

  it('初始化錯誤（target 不存在／不是目錄）也不轉述傳入的絕對路徑', async () => {
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')
    const missing = join(tmpdir(), `factory-missing-target-${process.pid}`)
    const missingError = await encryptVerifyBundle({ targetDir: missing, outFile, recipient }).catch(
      (e: unknown) => e,
    )
    expect(missingError).toBeInstanceOf(CliError)
    expect((missingError as Error).message).not.toContain(missing)

    const fileAsTarget = join(tempDir('factory-verify-file-'), 'not-a-dir')
    writeFileSync(fileAsTarget, 'x')
    const fileError = await encryptVerifyBundle({ targetDir: fileAsTarget, outFile, recipient }).catch(
      (e: unknown) => e,
    )
    expect(fileError).toBeInstanceOf(CliError)
    expect((fileError as Error).message).not.toContain(fileAsTarget)
    expect(existsSync(outFile)).toBe(false)
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

/**
 * C2（final whole-branch review）：bundle 的「agent 改動」必須以 agent 啟動前的
 * 不可變 commit 為基準。`origin/<base>` 仍可能被 agent 的本地 commit 推進嗎？不會，
 * 但本地 base 分支會——encrypt 原本只找 origin／本地分支名，兩者都可能不存在於
 * 驗證模式的 checkout（agent 在本地 commit 後 `HEAD` 前進，diff 就變空）。
 * 修法（R19）：workflow 傳入 agent 前的 HEAD（`--base-sha`）。
 */
describe('encryptVerifyBundle：不可變 diff 基準 --base-sha（R19／C2）', () => {
  it('以 agent 啟動前的 commit 為基準：已 commit 的測試檔仍進 bundle；不傳時重現空 diff', async () => {
    const target = makeTarget()
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')
    git(target, 'init', '-q', '-b', 'main')
    writeFixture(target, 'test/baseline.test.ts', 'old body')
    commitAll(target, 'base')
    const preAgent = git(target, 'rev-parse', 'HEAD').trim()
    // agent 在 base 分支上本地 commit（R2 允許），HEAD 因此前進
    writeFixture(target, 'test/committed.test.ts', 'new body')
    commitAll(target, 'agent commit on base branch')

    const withSha = await encryptVerifyBundle({ targetDir: target, outFile, recipient, baseSha: preAgent })
    expect(withSha.files).toEqual(['test/committed.test.ts'])

    const withoutSha = await encryptVerifyBundle({
      targetDir: target,
      outFile: join(tempDir('factory-verify-out-'), 'bundle.age'),
      recipient,
    })
    expect(withoutSha.files).toEqual([])
  })

  it('baseSha 不是 40-hex → CliError，且不寫任何輸出檔（fail closed）', async () => {
    const target = makeTarget()
    writeFixture(target, 'test/committed.test.ts', 'new body')
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')

    await expect(encryptVerifyBundle({ targetDir: target, outFile, recipient, baseSha: 'abc123' })).rejects.toThrow(
      /40-hex/,
    )
    expect(existsSync(outFile)).toBe(false)
  })

  it('baseSha 解析不到 commit → CliError，且不寫任何輸出檔', async () => {
    const target = makeTarget()
    git(target, 'init', '-q', '-b', 'main')
    writeFixture(target, 'test/baseline.test.ts', 'old body')
    commitAll(target, 'base')
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')

    await expect(
      encryptVerifyBundle({ targetDir: target, outFile, recipient, baseSha: 'f'.repeat(40) }),
    ).rejects.toThrow(/base-sha/)
    expect(existsSync(outFile)).toBe(false)
  })

  it('非 git 工作區帶 baseSha → fail closed（不得默默退回掃描全部白名單）', async () => {
    const target = makeTarget()
    writeFixture(target, 'test/committed.test.ts', 'new body')
    const outFile = join(tempDir('factory-verify-out-'), 'bundle.age')

    await expect(
      encryptVerifyBundle({ targetDir: target, outFile, recipient, baseSha: 'a'.repeat(40) }),
    ).rejects.toThrow(/base-sha/)
    expect(existsSync(outFile)).toBe(false)
  })

  it('parseArgs：--base-sha 選填、需有值；main 接到 encryptVerifyBundle', async () => {
    expect(
      parseArgs(['--target', 't', '--out', '/tmp/x.age', '--recipient', 'age1abc', '--base-sha', 'A'.repeat(40)]),
    ).toMatchObject({ baseSha: 'a'.repeat(40) })
    expect(parseArgs(['--target', 't', '--out', '/tmp/x.age', '--recipient', 'age1abc']).baseSha).toBeUndefined()
    expect(() =>
      parseArgs(['--target', 't', '--out', '/tmp/x.age', '--recipient', 'age1abc', '--base-sha', '--target', 't']),
    ).toThrow(/base-sha/)
  })
})
