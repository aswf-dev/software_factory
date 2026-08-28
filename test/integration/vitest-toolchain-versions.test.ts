/**
 * Vitest toolchain version-lockstep test (issue #171, docs/11 §3).
 *
 * `@vitest/coverage-v8` declares a strict peerDependency on the matching
 * `vitest` version: coverage-v8@4.1.11 peer-requires vitest@4.1.11, and
 * coverage-v8@4.1.10 peer-requires vitest@4.1.10. Because the vitest ecosystem
 * ships coverage providers in lockstep with the core framework, these two
 * devDependencies must NOT drift apart.
 *
 * When they drift (e.g. coverage-v8 bumped to 4.1.11 while vitest stays at
 * 4.1.10 — the Dependabot PR #167 failure), `npm install` / `npm ci` fails with
 * `ERESOLVE unable to resolve dependency tree`, which breaks the whole CI test
 * suite before a single test runs. This test pins that contract so the drift is
 * caught here, with a clear message, instead of an opaque npm resolver error.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '../..')
const PACKAGE_JSON = join(ROOT, 'package.json')

function readDevDependencies(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'))
  return pkg.devDependencies ?? {}
}

describe('vitest toolchain version-lockstep (issue #171)', () => {
  const devDeps = readDevDependencies()

  it('declares @vitest/coverage-v8 at the same version as vitest', () => {
    const vitest = devDeps['vitest']
    const coverageV8 = devDeps['@vitest/coverage-v8']

    expect(vitest, 'vitest devDependency must be declared in package.json').toBeTruthy()
    expect(coverageV8, '@vitest/coverage-v8 devDependency must be declared in package.json').toBeTruthy()

    // coverage-v8 peer-requires the exact matching vitest version; a mismatch
    // makes `npm ci` fail with ERESOLVE (PR #167). They must be identical, not
    // merely semver-compatible.
    expect(
      coverageV8,
      `@vitest/coverage-v8 (${coverageV8}) must be at the same version as vitest (${vitest}) — ` +
        'the coverage provider ships lockstep with vitest and peer-requires the exact match',
    ).toBe(vitest)
  })
})
