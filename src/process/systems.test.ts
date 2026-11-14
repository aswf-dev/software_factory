import { readdirSync, readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadProcessSpec, loadTemplate, validateProcess } from './spec.js'
import { discoverSystems, snapshotFileName, type DirReader } from './systems.js'

const ROOT = process.cwd()

const realReader: DirReader = {
  readdir: (path) => readdirSync(`${ROOT}/${path}`),
  isDirectory: (path) => statSync(`${ROOT}/${path}`).isDirectory(),
}

const { systems: REAL_SYSTEMS, skipped } = discoverSystems(realReader)

describe('真實租戶系統（processes/<owner>/<repo>.yaml）', () => {
  // 2026-11-14：原本要求「至少有一個真實系統」。三個用租戶自訂模板的試點系統下架後
  // （templates/<tenant>/*.yaml 已刪除、機制只留 factory/S|M|L），processes/ 只剩
  // samples/（discovery 會跳過），真實系統數為 0。機制不強制要有系統，但只要列進來的
  // 系統，下面每一條都必須通過。
  it('沒有因名稱不合法被略過的 spec（真實系統數可以是 0）', () => {
    expect(skipped).toEqual([])
  })

  describe.each(REAL_SYSTEMS)('$system', ({ system, spec }) => {
    it('spec 的 system 等於它的路徑，且忠於它釘選的模板版本', () => {
      const loadedProcess = loadProcessSpec(readFileSync(`${ROOT}/${spec}`, 'utf8'))
      expect(loadedProcess.errors).toEqual([])
      if (loadedProcess.process === undefined) throw new Error('process 未解析')
      // 路徑就是登記：後台以路徑判斷租戶，內容不得指向別的系統。
      expect(loadedProcess.process.system).toBe(system)

      // 模板路徑由 spec 推導（與 snapshot workflow 相同規則）。
      const templatePath = `templates/${loadedProcess.process.template}.yaml`
      const loadedTemplate = loadTemplate(readFileSync(`${ROOT}/${templatePath}`, 'utf8'))
      expect(loadedTemplate.errors).toEqual([])
      if (loadedTemplate.template === undefined) throw new Error('template 未解析')

      expect(validateProcess(loadedProcess.process, loadedTemplate.template)).toEqual({ ok: true, errors: [] })
    })
  })
})

describe('discoverSystems', () => {
  const fake = (tree: Record<string, string[] | null>): DirReader => ({
    readdir: (path) => tree[path] ?? [],
    isDirectory: (path) => Array.isArray(tree[path]),
  })

  it('排除 samples、忽略非目錄與非 YAML，並依名稱排序', () => {
    const reader = fake({
      processes: ['zeta', 'samples', 'README.md', 'acme'],
      'processes/samples': ['payment-platform.yaml'],
      'processes/README.md': null,
      'processes/acme': ['web.yaml', 'api.yml', 'notes.txt'],
      'processes/zeta': ['svc.yaml'],
    })
    expect(discoverSystems(reader)).toEqual({
      systems: [
        { owner: 'acme', repo: 'api', system: 'acme/api', spec: 'processes/acme/api.yml' },
        { owner: 'acme', repo: 'web', system: 'acme/web', spec: 'processes/acme/web.yaml' },
        { owner: 'zeta', repo: 'svc', system: 'zeta/svc', spec: 'processes/zeta/svc.yaml' },
      ],
      skipped: [],
    })
  })

  it('名稱不合法的 owner／repo 會被略過並回報（不會進入 token／artifact 名稱）', () => {
    const reader = fake({
      processes: ['-bad', 'ok'],
      'processes/-bad': ['x.yaml'],
      'processes/ok': ['.hidden.yaml', 'good.yaml'],
    })
    const result = discoverSystems(reader)
    expect(result.systems.map((entry) => entry.system)).toEqual(['ok/good'])
    expect(result.skipped).toEqual(['processes/-bad/x.yaml', 'processes/ok/.hidden.yaml'])
  })

  it('快照檔名以 owner--repo 區分同名 repo', () => {
    expect(snapshotFileName({ owner: 'a', repo: 'svc' })).toBe('a--svc.json')
    expect(snapshotFileName({ owner: 'b', repo: 'svc' })).not.toBe(snapshotFileName({ owner: 'a', repo: 'svc' }))
  })
})
