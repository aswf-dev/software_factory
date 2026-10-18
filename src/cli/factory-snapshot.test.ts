import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { FactorySnapshotSchema, main, snapshot } from './factory-snapshot.js'
import { parseOptions, type GraphDeps } from './factory-graph.js'
import { loadModuleSpec, loadProcessSpec, loadTemplate, validateProcess } from '../process/spec.js'

const read = (rel: string): string => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')

const PROCESS = 'processes/samples/payment-platform.yaml'
const MODULES = 'processes/samples/payment-platform.modules.yaml'
const TEMPLATE = 'processes/templates/M.yaml'

const issue = (number: number, task: string, path: string, state: 'OPEN' | 'CLOSED') => ({
  number,
  title: `#${number}`,
  body: `### 任務類型\n\n${task}\n\n### 需求描述（PRD）\n\n目標模組 / 檔案：${path}`,
  labels: [],
  state,
})

const issuesJson = JSON.stringify([
  issue(1, 'agent-add-tests', 'src/billing/invoice.ts', 'CLOSED'),
  issue(2, 'agent-fix-bug', 'src/settlement/batch.ts', 'OPEN'),
])

interface FakeDeps extends GraphDeps {
  calls: string[][]
}

function deps(files: Record<string, string>, issues = issuesJson): FakeDeps {
  const calls: string[][] = []
  return {
    calls,
    gh: (args) => {
      calls.push(args)
      if (args[0] === 'issue') return issues
      throw new Error(`unexpected gh call: ${args.join(' ')}`)
    },
    readFile: (path) => {
      const body = files[path]
      if (body === undefined) throw new Error(`unexpected readFile: ${path}`)
      return body
    },
    now: () => '2026-10-18T00:00:00Z',
  }
}

const fullFiles = {
  [PROCESS]: read(PROCESS),
  [MODULES]: read(MODULES),
  [TEMPLATE]: read(TEMPLATE),
}

const argv = (overrides: string[] = []): string[] => [
  '--repo',
  'aswf-dev/payment-platform',
  '--system',
  'aswf-dev/payment-platform',
  '--process',
  PROCESS,
  '--template',
  TEMPLATE,
  '--modules',
  MODULES,
  '--generated-at',
  '2026-10-18T00:00:00Z',
  ...overrides,
]

describe('factory-snapshot', () => {
  it('produces a versioned snapshot with graph and next actions', () => {
    const result = snapshot(parseOptions(argv()), deps(fullFiles))

    expect(FactorySnapshotSchema.safeParse(result).success).toBe(true)
    expect(result.schema_version).toBe(1)
    expect(result.system).toBe('aswf-dev/payment-platform')
    expect(result.source).toEqual({ github: 'aswf-dev/payment-platform' })
    expect(result.generated_at).toBe('2026-10-18T00:00:00Z')

    expect(result.graph.nodes.some((node) => node.id === 'issue:1')).toBe(true)
    expect(result.next).not.toBeNull()
    const actions = result.next?.actions ?? []
    expect(actions.map((action) => `${action.kind}:${action.template_step}`)).toEqual([
      'work-item:M7',
      'work-item:M7',
    ])
    expect(actions.map((action) => action.scope)).toEqual([
      'aswf-dev/payment-platform/billing',
      'aswf-dev/payment-platform/settlement',
    ])
  })

  it('aggregates next warnings into the snapshot warnings', () => {
    const result = snapshot(parseOptions(argv()), deps(fullFiles))
    expect(result.warnings.some((w) => w.includes('系統層步驟尚未完成'))).toBe(true)
  })

  it('omits `next` (null + advisory warning) when no template is given', () => {
    const options = parseOptions([
      '--repo',
      'aswf-dev/payment-platform',
      '--process',
      PROCESS,
      '--modules',
      MODULES,
    ])
    const result = snapshot(options, deps(fullFiles))

    expect(result.next).toBeNull()
    expect(result.warnings.some((w) => w.includes('未提供 --process／--template'))).toBe(true)
  })

  it('warns when the module list is missing instead of inventing actions', () => {
    const options = parseOptions([
      '--repo',
      'aswf-dev/payment-platform',
      '--process',
      PROCESS,
      '--template',
      TEMPLATE,
    ])
    const result = snapshot(options, deps(fullFiles))

    expect(result.next?.actions).toEqual([])
    expect(result.warnings.some((w) => w.includes('未提供 --modules'))).toBe(true)
  })

  it('fails loudly when the template file is invalid', () => {
    const options = parseOptions(['--repo', 'aswf-dev/payment-platform', '--process', PROCESS, '--template', 'bad.yaml'])
    expect(() => snapshot(options, deps({ [PROCESS]: fullFiles[PROCESS]!, 'bad.yaml': 'not: [valid' }))).toThrowError(
      /bad\.yaml 無效/,
    )
  })

  it('main() is a thin argv wrapper', () => {
    expect(main(argv(), deps(fullFiles)).schema_version).toBe(1)
  })

  it('fails loudly when process and template disagree', () => {
    const options = parseOptions([
      '--repo',
      'aswf-dev/payment-platform',
      '--process',
      PROCESS,
      '--template',
      'processes/templates/S.yaml',
    ])
    expect(() =>
      snapshot(options, deps({ ...fullFiles, 'processes/templates/S.yaml': read('processes/templates/S.yaml') })),
    ).toThrowError(/process 與模板不一致/)
  })

  it('is read-only: the only gh call is the issue list', () => {
    const fake = deps(fullFiles)
    snapshot(parseOptions(argv()), fake)
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]?.slice(0, 2)).toEqual(['issue', 'list'])
  })
})

describe('sample system process spec', () => {
  it('validates against the M template', () => {
    const template = loadTemplate(read(TEMPLATE))
    expect(template.ok).toBe(true)
    if (template.template === undefined) throw new Error('template missing')

    const process = loadProcessSpec(read(PROCESS))
    expect(process.ok).toBe(true)
    if (process.process === undefined) throw new Error('process missing')

    expect(validateProcess(process.process, template.template)).toEqual({ ok: true, errors: [] })
  })

  it('validates the module list (readiness carries evidence)', () => {
    expect(loadModuleSpec(read(MODULES)).ok).toBe(true)
  })
})
