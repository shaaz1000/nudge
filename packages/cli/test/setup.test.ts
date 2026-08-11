import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = promisify(execFile)
const BIN = join(import.meta.dirname, '..', 'dist', 'bin.js')

// Finding I4: `nudge setup` used to write `` `node ${HOOK_BIN}` `` — an
// unquoted command hardcoding the bare `node` found on the shell's PATH at
// hook-invocation time. A space anywhere in the install path breaks all
// seven hook entries, and a bare `node` may resolve to a Node without
// `node:sqlite`. installService() already used process.execPath for the
// engine's own service unit; setup's hook command must match.
//
// This spawns the real compiled CLI (setup --dry-run never writes to
// ~/.claude/settings.json or touches the real engine service — it only
// prints the diff) so the assertion is against what bin.ts actually builds,
// not a hand-copied string.

let dir: string

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nudge-setup-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('nudge setup --dry-run: hook command construction (I4)', () => {
  it('quotes the command and uses this process\'s own execPath, not a bare "node"', async () => {
    const { stdout } = await run('node', [BIN, 'setup', '--dry-run'], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
    })

    // The dry-run diff embeds the exact command setup would write.
    expect(stdout).toContain(`"${process.execPath}"`)
    // Every hook line's command portion is the quoted execPath followed by a
    // quoted hook-bin path — never a bare, unquotable "node ...".
    expect(stdout).not.toMatch(/->\s+node\s/)
    // The hook binary path itself is quoted too, so a space in the install
    // path (e.g. "Application Support") can't split it into two argv entries.
    expect(stdout).toMatch(/"\S*nudge-hook[/\\]dist[/\\]bin\.js"|"\S*hook[/\\]dist[/\\]bin\.js"/)
  })
})
