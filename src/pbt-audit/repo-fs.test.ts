import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LIST_LIMIT, repoFs } from './repo-fs.js'

let root: string
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'repo-fs-'))
  for (const f of ['src/a.ts', 'src/sub/b.ts', 'src/node_modules/x/c.ts', 'src/.git/HEAD', '.gitignore']) {
    mkdirSync(join(root, f, '..'), { recursive: true })
    writeFileSync(join(root, f), f)
  }
  symlinkSync('/dev/null', join(root, 'src/devnull'))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('repoFs', () => {
  it('pathKind：檔案、目錄、不存在、非一般檔案、越界路徑', () => {
    const fs = repoFs(root)
    expect(fs.pathKind('src/a.ts')).toBe('file')
    expect(fs.pathKind('src')).toBe('dir')
    expect(fs.pathKind('src/missing.ts')).toBeUndefined()
    expect(fs.pathKind('src/devnull')).toBeUndefined()
    expect(fs.pathKind('../etc')).toBeUndefined()
    expect(fs.pathKind('/etc/hosts')).toBeUndefined()
  })
  it('listFiles：遞迴、相對於 repo 根、排序、跳過 node_modules 與 .git', () => {
    expect(repoFs(root).listFiles('src')).toEqual(['src/a.ts', 'src/sub/b.ts'])
  })
  it('listFiles：不存在的目錄或越界路徑 → 空陣列', () => {
    expect(repoFs(root).listFiles('nope')).toEqual([])
    expect(repoFs(root).listFiles('..')).toEqual([])
  })
  it('listFiles：超過上限即停止', () => {
    const big = join(root, 'big')
    mkdirSync(big)
    for (let i = 0; i < 5; i++) writeFileSync(join(big, `f${i}.ts`), '')
    expect(repoFs(root, 3).listFiles('big')).toHaveLength(3)
    expect(LIST_LIMIT).toBe(5000)
  })
  it('readFile：讀檔；目錄、不存在、越界 → undefined', () => {
    const fs = repoFs(root)
    expect(fs.readFile('.gitignore')).toBe('.gitignore')
    expect(fs.readFile('src')).toBeUndefined()
    expect(fs.readFile('missing')).toBeUndefined()
    expect(fs.readFile('../x')).toBeUndefined()
  })
})
