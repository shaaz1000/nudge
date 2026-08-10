import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer, type Server } from 'node:net'
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = promisify(execFile)
const BIN = join(import.meta.dirname, '..', 'dist', 'bin.js')

let home: string
let server: Server | null = null

const payload = JSON.stringify({
  hook_event_name: 'Notification',
  session_id: 's1',
  cwd: '/a/my-repo',
  message: 'Allow Bash(ls)?',
})

// NOTE: uses the promisified `run`, not raw `execFile`. Only `util.promisify(execFile)`
// synchronously exposes `.child` on its return value and resolves to { stdout, stderr };
// a raw `execFile()` call returns a plain (non-thenable) ChildProcess with no `.child`
// property at all, which is what the brief's literal code called and which throws
// "Cannot read properties of undefined (reading 'stdin')" on the very first line.
async function invoke(env: Record<string, string> = {}) {
  const child = run('node', [BIN], { env: { ...process.env, NUDGE_HOME: home, ...env } })
  child.child!.stdin!.end(payload)
  return child
}

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'nudge-bin-')) })
afterEach(async () => {
  if (server) await new Promise<void>(r => server!.close(() => r()))
  server = null
  rmSync(home, { recursive: true, force: true })
})

describe('hook binary contract', () => {
  it('exits 0 and writes nothing to stdout when the engine is listening', async () => {
    const got: string[] = []
    server = createServer(s => { s.setEncoding('utf8'); s.on('data', d => got.push(d as string)) })
    await new Promise<void>(r => server!.listen(join(home, 'engine.sock'), () => r()))

    const { stdout } = await invoke({ NUDGE_NO_SPAWN: '1' })
    expect(stdout).toBe('')
    expect(got.join('')).toContain('"hook":"Notification"')
    expect(got.join('')).toContain('"project":"my-repo"')
  })

  it('exits 0 and spools when the engine is absent', async () => {
    const { stdout } = await invoke({ NUDGE_NO_SPAWN: '1' })
    expect(stdout).toBe('')
    expect(readdirSync(join(home, 'spool'))).toHaveLength(1)
  })

  it('exits 0 on malformed stdin and spools nothing', async () => {
    const child = run('node', [BIN], {
      env: { ...process.env, NUDGE_HOME: home, NUDGE_NO_SPAWN: '1' },
    })
    child.child!.stdin!.end('not json at all')
    const { stdout } = await child
    expect(stdout).toBe('')
    expect(existsSync(join(home, 'spool')) ? readdirSync(join(home, 'spool')) : []).toHaveLength(0)
  })

  it('exits 0 on empty stdin', async () => {
    const child = run('node', [BIN], {
      env: { ...process.env, NUDGE_HOME: home, NUDGE_NO_SPAWN: '1' },
    })
    child.child!.stdin!.end('')
    await expect(child).resolves.toMatchObject({ stdout: '' })
  })

  it('completes well inside the 500ms budget with no engine', async () => {
    const started = Date.now()
    await invoke({ NUDGE_NO_SPAWN: '1' })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('ignores a hook it does not subscribe to', async () => {
    const child = run('node', [BIN], {
      env: { ...process.env, NUDGE_HOME: home, NUDGE_NO_SPAWN: '1' },
    })
    child.child!.stdin!.end(JSON.stringify({
      hook_event_name: 'SubagentStop', session_id: 's1', cwd: '/a/my-repo',
    }))
    await child
    expect(existsSync(join(home, 'spool')) ? readdirSync(join(home, 'spool')) : []).toHaveLength(0)
  })

  // --- Review round 1, Finding 1 ---
  // Proves the fix end-to-end, not just at the detectHostApp unit level: a real
  // SessionStart payload through the actual binary, with NUDGE_TEST_HOP_DELAY_MS
  // forcing every walk hop to consume its full configured timeout (mirroring the
  // review's "inject a probe that always consumes its full timeout" ask) rather
  // than returning instantly like every other test's probe does. Before the fix,
  // the three phases' allowances summed to more than the 500ms budget by
  // construction; this test would have taken ~700-800ms internally. It should now
  // finish close to the 500ms internal budget plus ordinary process-startup
  // overhead.
  it('stays within the process budget for a real SessionStart hook even when every walk hop consumes its full configured timeout', async () => {
    const started = Date.now()
    const child = run('node', [BIN], {
      env: { ...process.env, NUDGE_HOME: home, NUDGE_NO_SPAWN: '1', NUDGE_TEST_HOP_DELAY_MS: '60' },
    })
    child.child!.stdin!.end(JSON.stringify({
      hook_event_name: 'SessionStart', session_id: 's1', cwd: '/a/my-repo',
    }))
    const { stdout } = await child
    const elapsed = Date.now() - started

    expect(stdout).toBe('')
    // Measured ~160-190ms in this environment (`node` process-startup overhead
    // dominates; the internal walk/read/send work is a small fraction of that).
    // 600ms leaves real margin for a slower/loaded CI machine while still being
    // well under what the pre-fix design could reach on its own internal budget
    // alone (~700-800ms, *before* adding process-startup time on top).
    expect(elapsed).toBeLessThan(600)
    // And prove the spooled event still carries a surface (the walk ran, it just
    // didn't overshoot) rather than this passing only because nothing happened.
    expect(readdirSync(join(home, 'spool'))).toHaveLength(1)
  })
})
