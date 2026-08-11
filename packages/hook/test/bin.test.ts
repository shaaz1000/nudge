import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer, type Server } from 'node:net'
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync } from 'node:fs'
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
    // Finding I8(a): this asserted < 2000 while guarding a 500ms contract —
    // a run 3.9x over budget (1900ms) still passed. Real measured cost is
    // 36-52ms, so < 500 is stable with ~10x headroom and actually catches a
    // regression against the contract this test exists to enforce.
    expect(Date.now() - started).toBeLessThan(500)
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

  // --- Review round 2, Finding 1 (retraction + replacement) ---
  // Round 1 added a test-only "force every walk hop to sleep for N ms" environment
  // variable to bin.ts so this test could exercise the full-timeout case end-to-end.
  // That seam was itself a regression: its busy-wait had no reference to any
  // deadline (unlike the real ps/powershell-backed probe, which is bounded by
  // execFileSync's OS-enforced timeout), so a large-enough value could block the
  // walk — and, being synchronous, block the guard's own setTimeout backstop right
  // along with it — for as long as the caller chose. The reviewer measured over a
  // full second of wall clock by setting it high enough. The seam and its helper
  // function have been removed from bin.ts entirely; see task-16-report.md's round-2
  // section for the full writeup (deliberately not naming the removed variable
  // here, so a repo-wide search for it turns up zero remaining references).
  //
  // The structural timing bound (a probe that genuinely consumes its full configured
  // timeout, on every hop, never overshoots the shared deadline) is already proven
  // safely at the function level in surface.test.ts's "never overshoots the
  // deadline" test — detectHostApp there is called directly, in-process, with an
  // injected probe, so a slow/malicious probe can only ever block that one test, not
  // every hook invocation Claude Code makes for the lifetime of the binary.
  //
  // What this test can honestly still demonstrate, without reintroducing that risk,
  // is that a real, completely unmocked SessionStart invocation — hitting the actual
  // `ps`-backed defaultProbe — comfortably clears the budget on a real machine.
  it('completes well inside the budget for a real, unmocked SessionStart hook', async () => {
    const started = Date.now()
    const child = run('node', [BIN], {
      env: { ...process.env, NUDGE_HOME: home, NUDGE_NO_SPAWN: '1' },
    })
    child.child!.stdin!.end(JSON.stringify({
      hook_event_name: 'SessionStart', session_id: 's1', cwd: '/a/my-repo',
    }))
    const { stdout } = await child
    const elapsed = Date.now() - started

    expect(stdout).toBe('')
    // Finding I8(a): this asserted < 2000 while guarding a 500ms contract —
    // a run 3.9x over budget (1900ms) still passed. Real measured cost
    // (node's own process-startup overhead plus a real `ps`-backed walk,
    // which normally adds only single-digit-to-low-double-digit ms) is
    // 36-52ms, so < 500 is stable with ~10x headroom and actually catches a
    // regression against the contract this test exists to enforce.
    expect(elapsed).toBeLessThan(500)
    // Proves the walk actually ran (not that nothing happened): the spooled event
    // carries a surface fingerprinted from this sandbox's real ancestor chain.
    const files = readdirSync(join(home, 'spool'))
    expect(files).toHaveLength(1)
    const spooled = JSON.parse(readFileSync(join(home, 'spool', files[0]), 'utf8'))
    expect(spooled.event.surface).toBeDefined()
  })
})
