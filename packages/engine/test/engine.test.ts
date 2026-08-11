import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
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
import type { HookName, NudgeEvent } from '@nudge/shared/types'
import type { NudgeConfig } from '@nudge/shared/config'

let dir: string, clock: FakeClock, db: Db, engine: Engine
let local: string[], phone: string[]

const ev = (hook: HookName, extra: Partial<NudgeEvent> = {}): NudgeEvent => ({
  source: 'claude-code', sessionId: 's1', hook,
  cwd: '/a/my-repo', project: 'my-repo', ts: clock.now(), ...extra,
})

function build(over: Record<string, unknown> = {}) {
  const cfg = mergeConfig({ channel: { id: 'test', options: {} }, ...over }) as NudgeConfig
  clock = new FakeClock(0)
  db = new Db(join(dir, 'e.db'))
  local = []; phone = []

  const store = new SessionStore(cfg, clock)
  const notifier = { alert: (s: { project: string }, tier: string) => local.push(`${s.project}:${tier}`) }
  const dispatcher = new Dispatcher(cfg, clock, async () => ({
    id: 'test', configSchema: {},
    send: async (a: { project: string; tier: string }) => { phone.push(`${a.project}:${a.tier}`) },
  }))
  let idle = 0
  const escalator = new Escalator({
    cfg, clock, idleMs: () => idle,
    onLocal: (s, t) => engine.onLocal(s, t),
    onPhone: (s, t) => { void engine.onPhone(s, t) },
  })
  const watchdog = new Watchdog(cfg, clock, store, t => engine.onWatchdogStall(t))
  const server = { broadcast: vi.fn(), listen: vi.fn(), close: vi.fn() }

  engine = new Engine({
    cfg, clock, store, db, escalator, dispatcher,
    notifier: notifier as never, watchdog, server: server as never,
  })
  return { cfg, store, server, setIdle: (v: number) => { idle = v } }
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nudge-eng-')) })
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

describe('end-to-end within the engine', () => {
  it('alerts locally then escalates to phone when nobody responds', async () => {
    build()
    engine.handle(ev('SessionStart'))
    engine.handle(ev('UserPromptSubmit'))
    engine.handle(ev('Notification', { message: 'Allow Bash?' }))
    expect(local).toEqual(['my-repo:blocked'])
    expect(phone).toEqual([])
    clock.advance(180_001)
    await vi.waitFor(() => expect(phone).toEqual(['my-repo:blocked']))
  })

  it('cancels the phone push when the human responds in time', async () => {
    build()
    engine.handle(ev('Notification', { message: 'Allow Bash?' }))
    clock.advance(120_000)
    engine.handle(ev('PostToolUse', { tool: 'Bash', ts: clock.now() }))
    clock.advance(600_000)
    expect(phone).toEqual([])
  })

  it('does not re-alert on a duplicate notification', () => {
    // localRepeat: 0 isolates the assertion to dedup logic — with the
    // default localRepeat: 3 (60s cadence, see DEFAULT_CONFIG), the ladder's
    // own first repeat lands at exactly the same t=60_000 boundary this test
    // advances to, adding a second (legitimate, non-duplicate-caused) local
    // alert before the duplicate event is even handled. That collision is
    // already covered by escalation.test.ts ("repeats three times at sixty
    // seconds apart"); this test only cares whether processing a duplicate
    // Notification re-alerts, so the repeat ladder is turned off here.
    build({ escalation: { localRepeat: 0 } })
    engine.handle(ev('Notification', { message: 'Allow Bash?' }))
    clock.advance(60_000)
    engine.handle(ev('Notification', { message: 'Allow Bash?', ts: clock.now() }))
    expect(local).toEqual(['my-repo:blocked'])
  })

  it('records a wait row that closes when resolved', () => {
    build()
    engine.handle(ev('Notification', { message: 'Allow?' }))
    expect(db.openWaits()).toHaveLength(1)
    clock.advance(10_000)
    engine.handle(ev('PostToolUse', { tool: 'Bash', ts: clock.now() }))
    expect(db.openWaits()).toHaveLength(0)
    expect(db.waitsSince(0)[0].resolvedBy).toBe('PostToolUse')
  })

  it('records history even when the alert is suppressed', () => {
    build({ muted: true })
    engine.handle(ev('Notification', { message: 'Allow?' }))
    expect(local).toEqual([])
    expect(db.openWaits()).toHaveLength(1)
  })

  it('logs every event, including ones that start no wait', () => {
    build()
    engine.handle(ev('SessionStart'))
    engine.handle(ev('PreToolUse', { tool: 'Read' }))
    expect(db.eventCount()).toBe(2)
  })

  it('stays silent for idle-short but still shows the notification', async () => {
    build()
    engine.handle(ev('UserPromptSubmit'))
    clock.advance(10_000)
    engine.handle(ev('Stop', { ts: clock.now() }))
    expect(local).toEqual(['my-repo:idle-short'])
    clock.advance(600_000)
    expect(phone).toEqual([])
  })

  it('escalates a long turn', async () => {
    build()
    engine.handle(ev('UserPromptSubmit'))
    clock.advance(240_000)
    engine.handle(ev('Stop', { ts: clock.now() }))
    expect(local).toEqual(['my-repo:idle-long'])
    clock.advance(180_001)
    await vi.waitFor(() => expect(phone).toEqual(['my-repo:idle-long']))
  })

  it('marks pushFailed when the channel keeps failing', async () => {
    const cfg = mergeConfig({ channel: { id: 'bad', options: {} } }) as NudgeConfig
    clock = new FakeClock(0); db = new Db(join(dir, 'f.db')); local = []; phone = []
    const store = new SessionStore(cfg, clock)
    const dispatcher = new Dispatcher(cfg, clock, async () => ({
      id: 'bad', configSchema: {}, send: async () => { throw new Error('offline') },
    }))
    const escalator = new Escalator({
      cfg, clock, idleMs: () => 0,
      onLocal: (s, t) => engine.onLocal(s, t),
      onPhone: (s, t) => { void engine.onPhone(s, t) },
    })
    engine = new Engine({
      cfg, clock, store, db, escalator, dispatcher,
      notifier: { alert: () => {} } as never,
      watchdog: new Watchdog(cfg, clock, store, () => {}),
      server: { broadcast: vi.fn(), listen: vi.fn(), close: vi.fn() } as never,
    })
    engine.handle(ev('Notification', { message: 'Allow?' }))
    clock.advance(180_001)
    for (let i = 0; i < 6; i++) { clock.advance(5_000); await Promise.resolve() }
    await vi.waitFor(() => expect(store.get('s1')!.pushFailed).toBe(true))
  })

  it('broadcasts state after every handled event', () => {
    const { server } = build()
    engine.handle(ev('SessionStart'))
    expect(server.broadcast).toHaveBeenCalled()
  })

  it('drops an unrecognised payload without throwing', () => {
    build()
    expect(() => engine.handle({ ...ev('Stop'), hook: 'SubagentStop' as never })).not.toThrow()
  })
})

describe('shutdown and suppression against an in-flight ladder', () => {
  it('stop() cancels every timer, closes the server, and releases the socket', async () => {
    // A real EngineServer and a real Watchdog, not the { broadcast/listen/close: vi.fn() }
    // stub build() uses elsewhere — stop() cleanliness is specifically about
    // the server's socket and the watchdog's own recurring timer, neither of
    // which the mock exercises.
    const cfg = mergeConfig({ channel: { id: 'test', options: {} } }) as NudgeConfig
    clock = new FakeClock(0); db = new Db(join(dir, 'stop.db')); local = []; phone = []
    const store = new SessionStore(cfg, clock)
    const dispatcher = new Dispatcher(cfg, clock, async () => ({
      id: 'test', configSchema: {}, send: async () => { phone.push('sent') },
    }))
    const escalator = new Escalator({
      cfg, clock, idleMs: () => 0,
      onLocal: (s, t) => engine.onLocal(s, t),
      onPhone: (s, t) => { void engine.onPhone(s, t) },
    })
    const watchdog = new Watchdog(cfg, clock, store, t => engine.onWatchdogStall(t))
    const server = new EngineServer({
      onEvent: e => engine.handle(e),
      onList: () => engine.sessions(),
      onSnooze: (id, ms) => engine.snooze(id, ms),
      onMute: on => engine.mute(on),
      onResolve: id => engine.resolve(id),
      onIdle: ms => engine.setIdle(ms),
      onFrontmost: id => engine.setFrontmost(id),
    })
    engine = new Engine({
      cfg, clock, store, db, escalator, dispatcher,
      notifier: { alert: () => {} } as never, watchdog, server,
    })

    // EngineServer.listen(), as called from Engine.start(), takes no
    // argument and binds shared/paths.ts's default socketPath() — redirect
    // it into this test's temp dir the same way paths.test.ts does, so this
    // doesn't bind a real ~/.nudge/engine.sock.
    const originalHome = process.env.NUDGE_HOME
    process.env.NUDGE_HOME = dir
    try {
      await engine.start()
      engine.handle(ev('Notification', { message: 'Allow?' }))
      // A genuinely in-flight ladder: the watchdog's own recurring tick plus
      // the local-repeat and phone-poll timers the Notification just armed.
      expect(clock.pendingCount()).toBeGreaterThan(0)

      await expect(engine.stop()).resolves.toBeUndefined()

      // Both the watchdog loop and every escalation timer were cancelled,
      // not merely abandoned to fire into a torn-down engine later.
      expect(clock.pendingCount()).toBe(0)

      // Prove the socket was actually released, not just that close()
      // resolved: a fresh server binding the same path must succeed.
      const fresh = new EngineServer({
        onEvent: () => {}, onList: () => [], onSnooze: vi.fn(), onMute: vi.fn(),
        onResolve: vi.fn(), onIdle: vi.fn(), onFrontmost: vi.fn(),
      })
      await expect(fresh.listen()).resolves.toBeUndefined()
      await fresh.close()
    } finally {
      if (originalHome === undefined) delete process.env.NUDGE_HOME
      else process.env.NUDGE_HOME = originalHome
    }
  }, 3000)

  it('mute(true) cancels an in-flight phone escalation, not just future ones', () => {
    build()
    engine.handle(ev('Notification', { message: 'Allow Bash?' }))
    clock.advance(90_000)
    engine.mute(true)
    // The sharp check: right now, the phone timer isn't due until t=180_000,
    // so if mute() only flipped cfg.muted without cancelling, it would still
    // be sitting on the clock. Checking phone-empty after advancing past it
    // would NOT catch that bug — phoneSuppression independently catches
    // cfg.muted whenever the timer *did* fire, so a merely-suppressed (never
    // cancelled) push still leaves `phone` empty. pendingCount() is the only
    // assertion that actually distinguishes cancellation from suppression.
    expect(clock.pendingCount()).toBe(0)
    clock.advance(600_000)
    expect(phone).toEqual([])
  })

  it('snooze(id, ms) cancels an in-flight phone escalation and sets snoozedUntil', () => {
    const { store } = build()
    engine.handle(ev('Notification', { message: 'Allow Bash?' }))
    clock.advance(90_000)
    engine.snooze('s1', 3_600_000)
    expect(clock.pendingCount()).toBe(0)
    expect(store.get('s1')!.snoozedUntil).toBe(90_000 + 3_600_000)
    clock.advance(600_000)
    expect(phone).toEqual([])
  })
})

describe('resume after sleep', () => {
  it('re-arms a still-waiting session so escalation is not lost to a sleeping laptop', async () => {
    build()
    engine.handle(ev('Notification', { message: 'Allow?' }))
    clock.advance(120_000)
    engine.onResume()          // laptop woke; ladder restarted from now
    clock.advance(120_000)
    expect(phone).toHaveLength(0)
    clock.advance(60_001)
    await vi.waitFor(() => expect(phone).toHaveLength(1))
  })

  it('leaves a non-waiting session alone', () => {
    build()
    engine.handle(ev('SessionStart'))
    expect(() => engine.onResume()).not.toThrow()
    expect(phone).toHaveLength(0)
  })
})
