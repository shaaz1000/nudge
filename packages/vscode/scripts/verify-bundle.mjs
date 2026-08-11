// Finding I5: CI ran `tsc --build` and `vitest run` but never bundled or
// packaged the extension — a green build said nothing about whether the
// esbuild bundle (or `vsce package`, which depends on it) still produces a
// loadable artifact. This script is that missing check's assertion half:
// it proves the workspace package specifier (`@nudge/shared/...`) actually
// got inlined by esbuild rather than left as an unresolved `require(...)`
// that would only ever fail at runtime, inside a real extension host, on
// someone's machine. Written as a standalone script (not an inline `node -e`
// in the CI YAML) so its quoting doesn't have to survive bash on Ubuntu/
// macOS AND PowerShell on the windows-latest runner.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'dist', 'extension.cjs')

const src = readFileSync(bundlePath, 'utf8')

if (src.includes('@nudge/')) {
  console.error(`${bundlePath} still references "@nudge/" — esbuild did not inline the workspace package (Finding I5)`)
  process.exit(1)
}

console.log(`OK: ${bundlePath} (${src.length} bytes) has no @nudge/ references`)
