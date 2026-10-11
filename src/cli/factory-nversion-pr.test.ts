/**
 * factory-nversion-pr 單元測試（src/cli/** 100% branch 閘門）。
 * 回歸來源：fubon-tradingbot#721——#722/#723 標題不一致、看不出是 A/B 配對。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CliError } from './run-cli.js'
import {
  SIBLING_BLOCK_END,
  SIBLING_BLOCK_START,
  layerTag,
  main,
  normalizedTitle,
  parseArgs,
  siblingBlock,
  stripFactoryTag,
  upsertSiblingBlock,
} from './factory-nversion-pr.js'

const ISSUE_TITLE = '[factory] 盤點 .env.example 與程式實際讀取的環境變數落差'

describe('標題正規化', () => {
  it('stripFactoryTag：去掉開頭（可重複、大小寫不拘）的 [factory]，其餘保留', () => {
    expect(stripFactoryTag(ISSUE_TITLE)).toBe('盤點 .env.example 與程式實際讀取的環境變數落差')
    expect(stripFactoryTag(' [Factory][factory] x [factory]')).toBe('x [factory]')
    expect(stripFactoryTag('沒有標記')).toBe('沒有標記')
  })

  it('layerTag：只認本 Issue＋本變體前綴、且符合 <nn>-<layer>', () => {
    expect(layerTag('factory/721-a-01-docs', 721, 'a')).toBe('01-docs')
    expect(layerTag('factory/721-b-02-impl', 721, 'b')).toBe('02-impl')
    expect(layerTag('factory/721-b-01-docs', 721, 'a')).toBeUndefined()
    expect(layerTag('factory/721-a-docs', 721, 'a')).toBeUndefined()
  })

  it('#721 重現：兩個變體得到只差變體代號的標題', () => {
    const a = normalizedTitle({ issueNumber: 721, variant: 'a', issueTitle: ISSUE_TITLE, branch: 'factory/721-a-01-docs' })
    const b = normalizedTitle({ issueNumber: 721, variant: 'b', issueTitle: ISSUE_TITLE, branch: 'factory/721-b-01-docs' })
    expect(a).toBe('[factory][721][a][01-docs] 盤點 .env.example 與程式實際讀取的環境變數落差')
    expect(b).toBe('[factory][721][b][01-docs] 盤點 .env.example 與程式實際讀取的環境變數落差')
  })

  it('分支不符格式 → 不帶層級；工單標題只有標記 → 以 #編號 當主旨', () => {
    expect(normalizedTitle({ issueNumber: 9, variant: 'b', issueTitle: '[factory]', branch: 'feature/x' })).toBe(
      '[factory][9][b] #9',
    )
  })
})

describe('互指區塊', () => {
  it('有另一變體 PR → 列出編號並提示勝者合併、敗者關閉', () => {
    const block = siblingBlock({ issueNumber: 721, variant: 'a', siblingPrs: [723] })
    expect(block.startsWith(SIBLING_BLOCK_START)).toBe(true)
    expect(block.endsWith(SIBLING_BLOCK_END)).toBe(true)
    expect(block).toContain('變體 a')
    expect(block).toContain('另一變體（b）的交付：#723')
    expect(block).toContain('勝者合併、敗者關閉')
  })

  it('變體 b 的另一變體是 a；多個 PR（stacked）以頓號串接', () => {
    expect(siblingBlock({ issueNumber: 5, variant: 'b', siblingPrs: [10, 11] })).toContain('另一變體（a）的交付：#10、#11')
  })

  it('另一變體沒有 PR → 明講無可比對的交付', () => {
    expect(siblingBlock({ issueNumber: 5, variant: 'a', siblingPrs: [] })).toContain('另一變體（b）未產生 PR')
  })

  it('upsert：無區塊時插在最上方；已有區塊時原地取代、不疊加（重跑冪等）', () => {
    const b1 = siblingBlock({ issueNumber: 5, variant: 'a', siblingPrs: [] })
    const b2 = siblingBlock({ issueNumber: 5, variant: 'a', siblingPrs: [8] })
    const once = upsertSiblingBlock('原內文\nCloses #5\n', b1)
    expect(once).toBe(`${b1}\n\n原內文\nCloses #5`)
    const twice = upsertSiblingBlock(once, b2)
    expect(twice).toBe(`${b2}\n\n原內文\nCloses #5`)
    expect(twice.split(SIBLING_BLOCK_START)).toHaveLength(2)
    expect(upsertSiblingBlock(twice, b2)).toBe(twice)
  })

  it('upsert：空內文 → 只有區塊；只有開頭標記（殘缺）→ 視為無區塊，插在最上方', () => {
    const b = siblingBlock({ issueNumber: 5, variant: 'a', siblingPrs: [8] })
    expect(upsertSiblingBlock('  \n', b)).toBe(b)
    const broken = `${SIBLING_BLOCK_START}\n殘缺`
    expect(upsertSiblingBlock(broken, b)).toBe(`${b}\n\n${broken}`)
  })
})

describe('參數解析', () => {
  it('title 子命令', () => {
    expect(parseArgs(['title', '--issue-number', '721', '--variant', 'a', '--issue-title', 'T', '--branch', 'B'])).toEqual({
      command: 'title',
      issueNumber: 721,
      variant: 'a',
      issueTitle: 'T',
      branch: 'B',
    })
  })

  it('body 子命令：--sibling-prs 可為空字串、可為逗號清單', () => {
    const base = ['body', '--issue-number', '5', '--variant', 'b', '--body-file', 'f.md', '--sibling-prs']
    expect(parseArgs([...base, ''])).toMatchObject({ command: 'body', siblingPrs: [] })
    expect(parseArgs([...base, '10, 11,'])).toMatchObject({ siblingPrs: [10, 11] })
  })

  it.each([
    [[], /title 或 body/],
    [['merge'], /title 或 body/],
    [['title', '--sibling-prs', '1'], /不認得參數/],
    [['title', '--variant'], /需要一個值/],
    [['title', '--variant', '--branch'], /需要一個值/],
    [['title', '--variant', 'a'], /缺少必填參數 --issue-number/],
    [['title', '--issue-number', '0', '--variant', 'a', '--issue-title', 'T', '--branch', 'B'], /正整數/],
    [['title', '--issue-number', '7', '--variant', 'c', '--issue-title', 'T', '--branch', 'B'], /a 或 b/],
    [['body', '--issue-number', '7', '--variant', 'a', '--body-file', 'f', '--sibling-prs', '12,x'], /正整數/],
  ])('拒收 %j', (argv, msg) => {
    expect(() => parseArgs(argv as string[])).toThrow(CliError)
    expect(() => parseArgs(argv as string[])).toThrow(msg)
  })
})

describe('main', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'nversion-pr-'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('title → { title }', () => {
    expect(
      main(['title', '--issue-number', '721', '--variant', 'b', '--issue-title', ISSUE_TITLE, '--branch', 'factory/721-b-01-docs']),
    ).toEqual({ title: '[factory][721][b][01-docs] 盤點 .env.example 與程式實際讀取的環境變數落差' })
  })

  it('body → 讀檔、插入互指區塊後回傳 { body }', () => {
    const f = join(dir, 'body.md')
    writeFileSync(f, '## 摘要\nCloses #721\n')
    const out = main(['body', '--issue-number', '721', '--variant', 'a', '--sibling-prs', '723', '--body-file', f])
    expect('body' in out && out.body).toContain('#723')
    expect('body' in out && out.body.endsWith('Closes #721')).toBe(true)
  })
})
