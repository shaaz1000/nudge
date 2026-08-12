// Proves the BUILT artefact is loadable and complete — the half of the tray's
// correctness that the unit suite structurally cannot see.
//
// Every tray test injects a fake `loadImage`, so nothing in the suite ever
// touches the filesystem: a missing or un-copied icon leaves 200+ tests green
// and ships a blank menu-bar icon. That is not hypothetical here — ASSETS_DIR
// originally resolved to `src/assets`, and electron-builder ships `dist/`
// only, so every packaged build would have had no icon at all. Phase 2 shipped
// the same class of defect one package over: 84 green tests and a `.vsix` that
// would not load.
//
// Mirrors packages/vscode/scripts/verify-bundle.mjs.
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const fail = msg => { console.error(`verify-bundle: ${msg}`); process.exitCode = 1 }

// 1. The app entry point exists and is genuinely self-contained. An
//    unresolved workspace specifier only fails at runtime, in a real Electron
//    host, on someone else's machine.
const bundle = join(pkg, 'dist', 'index.cjs')
if (!existsSync(bundle)) {
  fail('dist/index.cjs missing — did `npm run bundle` run?')
} else {
  const src = readFileSync(bundle, 'utf8')
  for (const spec of ['@nudge/shared', '@nudge/client']) {
    if (src.includes(`require("${spec}`) || src.includes(`require('${spec}`)) {
      fail(`${spec} left unbundled in dist/index.cjs — esbuild did not inline it`)
    }
  }
}

// 2. Every icon the code can ask for is present in the BUILD OUTPUT, at the
//    exact path tray.ts resolves (`dist/assets`), not merely in src/.
const states = ['idle', 'waiting', 'unreachable']
const themes = ['light', 'dark']
for (const state of states) {
  for (const theme of themes) {
    for (const suffix of ['', '@2x']) {
      const file = `tray-${state}-${theme}${suffix}.png`
      if (!existsSync(join(pkg, 'dist', 'assets', file))) {
        fail(`dist/assets/${file} missing — copy-assets did not run, or an icon was renamed`)
      }
    }
  }
}

// 3. The engine ships with the app, or the tray's "Start engine" menu item —
//    offered precisely when the engine is unreachable — is a silent no-op in
//    the packaged build.
if (!existsSync(join(pkg, 'dist', 'engine', 'engine.mjs'))) {
  fail('dist/engine/engine.mjs missing — "Start engine" would do nothing in a packaged app')
}
for (const wav of ['blocked.wav', 'done.wav', 'stalled.wav']) {
  if (!existsSync(join(pkg, 'dist', 'assets-engine', wav))) {
    fail(`dist/assets-engine/${wav} missing — the bundled engine would have no alert sounds`)
  }
}

if (process.exitCode) {
  console.error('verify-bundle: FAILED')
} else {
  console.log('verify-bundle: ok — bundle self-contained, icons, engine and sounds all present')
}
