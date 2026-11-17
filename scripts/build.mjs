#!/usr/bin/env node
/**
 * Build the package's Node entry points (doc/plugin.md §9).
 *
 *   src/cli.ts    -> lib/cli.js     the container service (always built)
 *   src/plugin.ts -> lib/plugin.js  the DSH plugin host (built when present)
 *
 * Why this script exists instead of a single `bun build` command line: the package now has two
 * entries, and one of them (`src/plugin.ts`) is delivered by a separate change (doc/plugin.md §14,
 * T6). Until that file lands, `bun run build` must keep producing `lib/cli.js` instead of failing on
 * a missing entry, because the container build and the checked-in `lib` both depend on it.
 *
 * The tolerance is deliberately narrow, and the two cases are distinct:
 *
 *   - `src/plugin.ts` absent, sources otherwise present -> skip that entry with a notice. "Not
 *     written yet" is not a build failure. Once the file exists it is compiled unconditionally, so a
 *     broken plugin entry fails the build like any other compile error.
 *   - `src/cli.ts` absent while `src/` exists -> hard failure. A checkout that lost the service entry
 *     is broken, and silently producing no `lib/cli.js` would ship a container that cannot boot.
 *   - `src/` absent entirely -> nothing to build, exit 0 with a notice. `prepare` runs on every
 *     `bun install` of this package, including a production install that has only `package.json` and
 *     `bun.lock` on disk (the Dockerfile installs dependencies before copying sources). That layout
 *     has no sources to compile and must not fail the install.
 *
 * Client half: `client.js` is a hand-written browser module at the package root (doc/plugin.md §9),
 * served through `exports["./client"]`; it is not bundled here and is not required to exist yet.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root: this file lives in `<root>/scripts/`. */
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const srcDir = join(root, 'src')
const outDir = join(root, 'lib')

/** `bun build` flags shared by both entries: Node ESM, dependencies left external. */
const BUILD_FLAGS = ['--outdir', outDir, '--target', 'node', '--format', 'esm', '--packages', 'external']

const entries = [
  { source: join(srcDir, 'cli.ts'), output: 'lib/cli.js', required: true },
  { source: join(srcDir, 'plugin.ts'), output: 'lib/plugin.js', required: false },
]

/** The bun executable: honour an explicit override, otherwise resolve from PATH. */
const bunBin = process.env.BUN_BINARY || 'bun'

function fail(message) {
  console.error(`build: ${message}`)
  process.exit(1)
}

// A production install (`bun install` with only the manifest on disk) runs `prepare` with no
// sources; there is nothing to compile and nothing to verify, so the install must succeed.
if (!existsSync(srcDir)) {
  console.log('build: no src/ directory in this install (nothing to build); skipping')
  process.exit(0)
}

const built = []
const skipped = []

for (const entry of entries) {
  if (!existsSync(entry.source)) {
    if (entry.required) {
      fail(`missing required entry ${entry.source}; the service entry cannot be built from this checkout`)
    }
    skipped.push(entry)
    continue
  }

  const result = spawnSync(bunBin, ['build', entry.source, ...BUILD_FLAGS], { cwd: root, stdio: 'inherit' })

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      fail(`cannot run "${bunBin}": bun is required to build this package (https://bun.sh)`)
    }
    fail(`could not start "${bunBin} build" for ${entry.source}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    fail(`compiling ${entry.source} failed with exit code ${result.status ?? 'unknown'}`)
  }
  built.push(entry)
}

for (const entry of skipped) {
  console.log(`build: skipped ${entry.output} (${entry.source} does not exist yet)`)
}
console.log(`build: wrote ${built.map((entry) => entry.output).join(', ')}`)
