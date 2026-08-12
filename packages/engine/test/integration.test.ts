import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { SessionState, Tier } from '@nudge/shared/types'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/engine.js'
import { FakeClock } from '../src/clock.js'
import { SessionStore } from '../src/state.js'
import { Escalator } from '../src/escalation.js'
import { Dispatcher } from '../src/dispatch.js'
import { Watchdog } from '../src/watchdog.js'
import { EngineServer } from '../src/server.js'
import { Db } from '../src/db.js'
import { mergeConfig } from '@nudge/shared/config'
import type { NudgeConfig } from '@nudge/shared/config'
import { socketPath } from '@nudge/shared/paths'

// vi.waitFor's default timeout (1s) is tuned for FakeClock-driven suites
// where a condition either holds already or never will. This file is the one
// place that waits on real OS process-spawn and real socket I/O, which can
// legitimately take longer on a loaded CI runner — an explicit, generous
// timeout here means a genuine regression fails clearly instead of flaking
// on a slow machine.
const WAIT_FOR_MS = 5_000

// This suite is the one place that spawns the REAL compiled hook binary
// (packages/hook/dist/bin.js) as a child process and lets it talk to a REAL
// engine over a REAL unix socket. Every other test in the repo either drives
// Engine.handle() in-process or exercises the hook's own stdin/stdout
// contract in isolation — this is the only proof the two ends of the wire
// actually agree with each other. Run `npx tsc --build` first so the dist
// file exists; execFile below does not compile anything.
const HOOK = join(import.meta.dirname, '..', '..', 'hook', 'dist', 'bin.js')

// Note on `promisify`: `execFile` itself is callback-style and returns a
// plain ChildProcess synchronously, with no `.child` property and nothing to
// `await`. `promisify(execFile)` is what returns a Promise that Node
// additionally decorates with a `.child` property pointing at the real
// ChildProcess (a documented Node feature, verified against this repo's
// Node 24 runtime) — that combination is what lets fireHook both write to
// stdin and await process exit.
const pExecFile = promisify(execFile)

let home: string, clock: FakeClock, db: Db, engine: Engine
let phone: Array<{ project: string; tier: string; detail?: string }>
let local: string[]
let originalNudgeHome: string | undefined

/**
 * Spawns the compiled hook binary exactly as Claude Code would: JSON payload
 * on stdin, NUDGE_HOME pointed at this test's temp dir so the hook's socket
 * client (packages/hook/src/send.ts, via @nudge/shared/paths socketPath())
 * resolves to the same address the server below is listening on. This must
 * be `socketPath()`'s own resolution, not a hand-built path: on POSIX that's
 * a plain file under NUDGE_HOME, but on Windows it's a named pipe keyed off
 * a hash of NUDGE_HOME (see paths.ts) — a bare temp-dir path is not a valid
 * pipe address there, so hand-building one would make the hook and the
 * engine agree on nothing.
 * NUDGE_NO_SPAWN=1 stops the hook from fork-spawning a second real engine
 * process if the write ever fails — this suite already owns one engine and
 * must not let a flaky send fork a stray daemon that outlives the test.
 */
async function fireHook(payload: Record<string, unknown>): Promise<void> {
  const child = pExecFile('node', [HOOK], {
    env: { ...process.env, NUDGE_HOME: home, NUDGE_NO_SPAWN: '1' },
  })
  child.child.stdin!.end(JSON.stringify(payload))
  await child
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'nudge-int-'))
  mkdirSync(join(home, 'spool'), { recursive: true })
  // Set on this (parent) process too, not just the hook's child env above —
  // socketPath() below reads process.env.NUDGE_HOME directly, and the server
  // it binds runs in this process. Restored in afterEach so this test file
  // never leaks its temp dir into the rest of the suite.
  originalNudgeHome = process.env.NUDGE_HOME
  process.env.NUDGE_HOME = home
  clock = new FakeClock(0)
  db = new Db(join(home, 'n.db'))
  phone = []
  local = []

  const cfg = mergeConfig({ channel: { id: 'spy', options: {} } }) as NudgeConfig
  const store = new SessionStore(cfg, clock)
  const dispatcher = new Dispatcher(cfg, clock, async () => ({
    id: 'spy',
    configSchema: {},
    // Mirrors exactly what the real ntfy channel forwards to the wire
    // (verified in Task 10's review: only project/tier/detail ever leave the
    // process) — sessionId and waitingSince arrive on `a` but are never read.
    send: async a => { phone.push({ project: a.project, tier: a.tier, detail: a.detail }) },
  }))
  const escalator = new Escalator({
    cfg, clock, idleMs: () => 0,
    onLocal: (s, t) => engine.onLocal(s, t),
    onPhone: (s, t) => { void engine.onPhone(s, t) },
  })
  const server = new EngineServer({
    onEvent: ev => engine.handle(ev),
    onList: () => engine.sessions(),
    onSnooze: (id, ms) => engine.snooze(id, ms),
    onMute: on => engine.mute(on),
    onResolve: id => engine.resolve(id),
    onIdle: ms => engine.setIdle(ms),
    onFrontmost: id => engine.setFrontmost(id),
  })
  engine = new Engine({
    cfg, clock, store, db, escalator, dispatcher,
    notifier: { alert: (s: SessionState, t: Tier) => local.push(`${s.project}:${t}`) } as never,
    watchdog: new Watchdog(cfg, clock, store, t => engine.onWatchdogStall(t)),
    server,
  })
  await server.listen(socketPath())
})

afterEach(async () => {
  await engine.stop()
  rmSync(home, { recursive: true, force: true })
  if (originalNudgeHome === undefined) delete process.env.NUDGE_HOME
  else process.env.NUDGE_HOME = originalNudgeHome
})

describe('hook process -> socket -> engine -> channel', () => {
  it('runs the realistic sequence and escalates once nobody responds', async () => {
    await fireHook({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/tmp/fixture-project' })
    await fireHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/tmp/fixture-project' })
    await fireHook({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: '/tmp/fixture-project', tool_name: 'Bash' })
    await fireHook({
      hook_event_name: 'Notification', session_id: 's1',
      cwd: '/tmp/fixture-project', message: 'Allow Bash(rsync secret-host)?',
    })

    await vi.waitFor(() => expect(local).toContain('fixture-project:blocked'), WAIT_FOR_MS)

    clock.advance(180_001)
    await vi.waitFor(() => expect(phone).toHaveLength(1), WAIT_FOR_MS)

    // The privacy rule, verified across the real wire: nothing sensitive left.
    expect(phone[0].project).toBe('fixture-project')
    expect(phone[0].tier).toBe('blocked')
    expect(phone[0].detail).toBeUndefined()
    const wire = JSON.stringify(phone)
    // No command text or hostname from the Notification message.
    expect(wire).not.toContain('rsync')
    expect(wire).not.toContain('secret-host')
    // No filesystem path — only the basename ever becomes `project`.
    expect(wire).not.toContain('/tmp/fixture-project')
    // No session id, checked against this test's actual real id rather than
    // a string that never appeared in the fixture in the first place.
    expect(wire).not.toContain('s1')
  })

  it('cancels the escalation when the tool actually runs', async () => {
    await fireHook({ hook_event_name: 'Notification', session_id: 's2', cwd: '/tmp/fixture-project', message: 'Allow?' })
    await vi.waitFor(() => expect(local).toHaveLength(1), WAIT_FOR_MS)
    clock.advance(60_000)
    await fireHook({ hook_event_name: 'PostToolUse', session_id: 's2', cwd: '/tmp/fixture-project', tool_name: 'Bash' })
    await vi.waitFor(() => expect(engine.sessions()[0].status).toBe('running'), WAIT_FOR_MS)
    clock.advance(600_000)
    expect(phone).toHaveLength(0)
  })

  it('records the wait in history with a resolution reason', async () => {
    await fireHook({ hook_event_name: 'Notification', session_id: 's3', cwd: '/tmp/fixture-project', message: 'Allow?' })
    await vi.waitFor(() => expect(db.openWaits()).toHaveLength(1), WAIT_FOR_MS)
    await fireHook({ hook_event_name: 'UserPromptSubmit', session_id: 's3', cwd: '/tmp/fixture-project' })
    await vi.waitFor(() => expect(db.openWaits()).toHaveLength(0), WAIT_FOR_MS)
    expect(db.waitsSince(0).at(-1)!.resolvedBy).toBe('UserPromptSubmit')
  })
})

describe('spool recovery', () => {
  it('replays an event spooled while the engine was down', async () => {
    const { drainSpool } = await import('../src/drain.js')
    writeFileSync(join(home, 'spool', '1-x.json'), JSON.stringify({
      t: 'event',
      event: {
        source: 'claude-code', sessionId: 's9', hook: 'Notification',
        cwd: '/tmp/fixture-project', project: 'fixture-project', ts: 500, message: 'Allow?',
      },
    }))
    const n = await drainSpool(ev => engine.handle(ev), join(home, 'spool'))
    expect(n).toBe(1)
    expect(local).toContain('fixture-project:blocked')
  })
})
