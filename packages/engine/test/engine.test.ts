import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { Engine } from '../src/engine.js'
import { FakeClock } from '../src/clock.js'
import { SessionStore } from '../src/state.js'
import { Escalator } from '../src/escalation.js'
import { Dispatcher } from '../src/dispatch.js'
import { Watchdog, PRUNE_INTERVAL_MS } from '../src/watchdog.js'
import { EngineServer } from '../src/server.js'
import { Db } from '../src/db.js'
import { mergeConfig } from '@nudge/shared/config'
import { encode } from '@nudge/shared/protocol'
import type { HookName, NudgeEvent, SessionState } from '@nudge/shared/types'
import type { NudgeConfig } from '@nudge/shared/config'

let dir: string, clock: FakeClock, db: Db, engine: Engine
let local: string[], phone: string[]
/**
 * Round 2, Finding 1: tracks calls to `notifier.alertSound()` separately
 * from `local` (which tracks full `notifier.alert()` calls — banner +
 * sound together, the no-GUI path). Only exercised by the "Finding 5"
 * describe block below, which toggles a real GUI connection; every other
 * fixture's `server.hasGuiClient()` stub is hardcoded `false`, so
 * `alertSound()` is never reached there.
 */
let soundOnly: string[]

const ev = (hook: HookName, extra: Partial<NudgeEvent> = {}): NudgeEvent => ({
  source: 'claude-code', sessionId: 's1', hook,
  cwd: '/a/my-repo', project: 'my-repo', ts: clock.now(), ...extra,
})

function build(over: Record<string, unknown> = {}, extraDeps: Record<string, unknown> = {}) {
  const cfg = mergeConfig({ channel: { id: 'test', options: {} }, ...over }) as NudgeConfig
  clock = new FakeClock(0)
  db = new Db(join(dir, 'e.db'))
  local = []; phone = []; soundOnly = []

  const store = new SessionStore(cfg, clock)
  const notifier = {
    alert: (s: { project: string }, tier: string) => local.push(`${s.project}:${tier}`),
    alertSound: (tier: string) => soundOnly.push(tier),
  }
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
  // hasGuiClient: () => false — Finding 5's onLocal gate calls this on every
  // local-alert check; every test in this file assumes no GUI is connected
  // (real GUI-gating behaviour is covered separately, see engine.test.ts's
  // "Finding 5" describe block below).
  const server = { broadcast: vi.fn(), listen: vi.fn(), close: vi.fn(), hasGuiClient: () => false }

  engine = new Engine({
    cfg, clock, store, db, escalator, dispatcher,
    notifier: notifier as never, watchdog, server: server as never,
    ...extraDeps,
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
      server: { broadcast: vi.fn(), listen: vi.fn(), close: vi.fn(), hasGuiClient: () => false } as never,
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

/**
 * Review round 1, Finding 5 (USER-APPROVED): with a GUI client (the Electron
 * tray) connected, the engine must skip its own local desktop notification —
 * the tray shows its own clickable one instead — but fall back to its own
 * notification the INSTANT no GUI client is connected (including right after
 * one disconnects or crashes), and phone escalation / DB history must be
 * completely unaffected either way. This uses a REAL EngineServer bound to a
 * real socket (not the `{ hasGuiClient: () => false }` stub `build()` uses
 * for every other test in this file) so the whole stack — wire protocol
 * (`subscribe({gui:true})`) -> server (`#guiSubscribers`) -> engine
 * (`onLocal`'s gate) — is proven end to end, not just Engine's own gate in
 * isolation.
 */
describe('engine defers to a connected GUI client (Finding 5)', () => {
  let sockPath: string
  let realServer: EngineServer

  beforeEach(() => { sockPath = join(dir, 'gui.sock') })
  afterEach(async () => { await realServer?.close() })

  function buildWithRealServer() {
    const cfg = mergeConfig({ channel: { id: 'test', options: {} } }) as NudgeConfig
    clock = new FakeClock(0)
    db = new Db(join(dir, 'gui.db'))
    local = []; phone = []; soundOnly = []
    const store = new SessionStore(cfg, clock)
    const notifier = {
      // Full alert (banner + sound) — the no-GUI path.
      alert: (s: { project: string }, tier: string) => local.push(`${s.project}:${tier}`),
      // Sound only — round 2, Finding 1's fix, taken while a GUI is
      // connected and the banner is left to the tray's own Notifier.
      alertSound: (tier: string) => soundOnly.push(tier),
    }
    const dispatcher = new Dispatcher(cfg, clock, async () => ({
      id: 'test', configSchema: {},
      send: async (a: { project: string; tier: string }) => { phone.push(`${a.project}:${a.tier}`) },
    }))
    const escalator = new Escalator({
      cfg, clock, idleMs: () => 0,
      onLocal: (s, t) => engine.onLocal(s, t),
      onPhone: (s, t) => { void engine.onPhone(s, t) },
    })
    const watchdog = new Watchdog(cfg, clock, store, t => engine.onWatchdogStall(t))
    realServer = new EngineServer({
      onEvent: e => engine.handle(e),
      onList: () => engine.sessions(),
      onSnooze: (id, ms) => engine.snooze(id, ms),
      onMute: on => engine.mute(on),
      onResolve: id => engine.resolve(id),
      onIdle: ms => engine.setIdle(ms),
      onFrontmost: id => engine.setFrontmost(id),
      onGuiDisconnected: () => engine.onGuiDisconnected(),
    })
    engine = new Engine({
      cfg, clock, store, db, escalator, dispatcher,
      notifier: notifier as never, watchdog, server: realServer,
    })
    return { store }
  }

  /** Connects, subscribes (optionally as a GUI), and waits for the server to have processed it. */
  async function subscribeGui(gui: boolean): Promise<import('node:net').Socket> {
    const sock = connect(sockPath)
    await new Promise<void>(resolve => sock.on('connect', resolve))
    sock.write(encode({ t: 'subscribe', id: 1, gui }))
    await vi.waitFor(() => expect(realServer.hasGuiClient()).toBe(gui))
    return sock
  }

  it('GUI connected -> no engine banner at t=0, but the per-tier sound still fires (round 2, Finding 1)', async () => {
    buildWithRealServer()
    await realServer.listen(sockPath)
    const guiSock = await subscribeGui(true)

    engine.handle(ev('Notification', { message: 'Allow Bash?' }))
    expect(local).toEqual([]) // no banner: the tray's own clickable Notifier shows one instead
    expect(soundOnly).toEqual(['blocked']) // but the configured sound for this tier still plays

    guiSock.destroy()
  })

  it('GUI disconnects -> banner resumes immediately, not just on the next scheduled repeat', async () => {
    buildWithRealServer()
    await realServer.listen(sockPath)
    const guiSock = await subscribeGui(true)

    engine.handle(ev('Notification', { message: 'Allow Bash?' }))
    expect(local).toEqual([]) // suppressed while the GUI is connected
    expect(soundOnly).toEqual(['blocked']) // the sound is not

    guiSock.destroy()
    await vi.waitFor(() => expect(realServer.hasGuiClient()).toBe(false))
    // onGuiDisconnected re-runs onLocal for every still-waiting session the
    // instant the last GUI vanishes — no need to advance the clock to the
    // next localRepeatIntervalMs boundary (default 60s) to see it resume.
    await vi.waitFor(() => expect(local).toEqual(['my-repo:blocked']))
  })

  it('the escalation ladder\'s local repeats stay audible (sound-only) for the whole time a GUI is connected', async () => {
    buildWithRealServer()
    await realServer.listen(sockPath)
    const guiSock = await subscribeGui(true)

    engine.handle(ev('Notification', { message: 'Allow Bash?' }))
    expect(soundOnly).toEqual(['blocked']) // t=0

    // Default cfg: localRepeat=3 every localRepeatIntervalMs=60s, so t=60s
    // and t=120s are two more repeats — well short of activeDelayMs=180s,
    // so phone escalation cannot have fired yet and isn't muddying this.
    clock.advance(60_000)
    await vi.waitFor(() => expect(soundOnly).toEqual(['blocked', 'blocked']))
    clock.advance(60_000)
    await vi.waitFor(() => expect(soundOnly).toEqual(['blocked', 'blocked', 'blocked']))

    expect(local).toEqual([]) // the banner never fired even once across all three repeats
    expect(phone).toEqual([]) // and phone escalation hasn't kicked in yet either

    guiSock.destroy()
  })

  it('two GUIs connected -> still no banner (sound still fires); only disconnecting BOTH resumes the banner', async () => {
    buildWithRealServer()
    await realServer.listen(sockPath)
    const a = await subscribeGui(true)
    const b = connect(sockPath)
    await new Promise<void>(resolve => b.on('connect', resolve))
    b.write(encode({ t: 'subscribe', id: 2, gui: true }))
    await vi.waitFor(() => expect(realServer.hasGuiClient()).toBe(true))

    engine.handle(ev('Notification', { message: 'Allow Bash?' }))
    expect(local).toEqual([])
    expect(soundOnly).toEqual(['blocked'])

    a.destroy()
    await new Promise(r => setTimeout(r, 50))
    expect(realServer.hasGuiClient()).toBe(true) // b is still connected
    expect(local).toEqual([]) // still suppressed

    b.destroy()
    await vi.waitFor(() => expect(realServer.hasGuiClient()).toBe(false))
    await vi.waitFor(() => expect(local).toEqual(['my-repo:blocked']))
  })

  it('phone escalation is entirely unaffected by a connected GUI (only the local banner is gated)', async () => {
    buildWithRealServer()
    await realServer.listen(sockPath)
    const guiSock = await subscribeGui(true)

    engine.handle(ev('Notification', { message: 'Allow Bash?' }))
    expect(local).toEqual([]) // local banner suppressed
    expect(phone).toEqual([])

    clock.advance(180_001)
    await vi.waitFor(() => expect(phone).toEqual(['my-repo:blocked'])) // phone escalation fires regardless

    guiSock.destroy()
  })

  it('DB wait-history recording is entirely unaffected by a connected GUI', async () => {
    const { store } = buildWithRealServer()
    await realServer.listen(sockPath)
    const guiSock = await subscribeGui(true)

    engine.handle(ev('Notification', { message: 'Allow Bash?' }))
    expect(local).toEqual([]) // local banner suppressed
    expect(db.openWaits()).toHaveLength(1) // history is not

    clock.advance(10_000)
    engine.handle(ev('PostToolUse', { tool: 'Bash', ts: clock.now() }))
    expect(db.openWaits()).toHaveLength(0)
    expect(db.waitsSince(0)[0].resolvedBy).toBe('PostToolUse')
    expect(store.get('s1')?.tier).toBeNull() // resolved and cleared, same as with no GUI connected

    guiSock.destroy()
  })

  it('no GUI ever connected -> behaves exactly like before this fix (local banner fires normally)', async () => {
    buildWithRealServer()
    await realServer.listen(sockPath)

    engine.handle(ev('Notification', { message: 'Allow Bash?' }))
    expect(local).toEqual(['my-repo:blocked'])
  })
})

/**
 * Finding I7: `nudge mute` only ever flipped `cfg.muted` on the engine's
 * in-memory config object — nothing wrote it to config.json. `nudge status`
 * re-reads config.json fresh in a separate process on every invocation, so
 * it disagreed with `nudge mute` immediately, and a plain engine restart
 * silently unmuted everything with no trace it had happened. `persistMuted`
 * is an optional engine dependency (defaults to a no-op, so every other test
 * in this file that builds an Engine without it keeps working unchanged and
 * never touches a real file) that bin.ts wires to shared/config's
 * setMuted() — this test only proves the engine calls it, not the on-disk
 * effect itself, which config.test.ts already covers directly.
 */
describe('mute persistence (I7)', () => {
  it('calls persistMuted with the new value whenever mute() is called', () => {
    const persistMuted = vi.fn()
    build({}, { persistMuted })
    engine.mute(true)
    expect(persistMuted).toHaveBeenCalledWith(true)
    engine.mute(false)
    expect(persistMuted).toHaveBeenCalledWith(false)
    expect(persistMuted).toHaveBeenCalledTimes(2)
  })

  it('still flips cfg.muted in-memory even when persistMuted is absent', () => {
    const { cfg } = build()
    engine.mute(true)
    expect(cfg.muted).toBe(true)
  })
})

describe('watchdog TTL drop cleanup (I1)', () => {
  it('cancels the escalator ladder and closes the open wait row when a session drops past its TTL', () => {
    const cfg = mergeConfig({
      channel: { id: 'test', options: {} },
      watchdog: { stallAfterMs: 900_000, sessionTtlMs: 86_400_000, tickMs: 30_000 },
    }) as NudgeConfig
    clock = new FakeClock(0); db = new Db(join(dir, 'ttl.db')); local = []; phone = []
    const store = new SessionStore(cfg, clock)
    const dispatcher = new Dispatcher(cfg, clock, async () => ({
      id: 'test', configSchema: {}, send: async () => { phone.push('sent') },
    }))
    const escalator = new Escalator({
      cfg, clock, idleMs: () => 0,
      onLocal: (s, t) => engine.onLocal(s, t),
      onPhone: (s, t) => { void engine.onPhone(s, t) },
    })
    const watchdog = new Watchdog(
      cfg, clock, store,
      t => engine.onWatchdogStall(t),
      id => engine.onWatchdogDrop(id),
    )
    // hasGuiClient: () => false — Finding 5's onLocal gate calls this on every
  // local-alert check; every test in this file assumes no GUI is connected
  // (real GUI-gating behaviour is covered separately, see engine.test.ts's
  // "Finding 5" describe block below).
  const server = { broadcast: vi.fn(), listen: vi.fn(), close: vi.fn(), hasGuiClient: () => false }
    engine = new Engine({
      cfg, clock, store, db, escalator, dispatcher,
      notifier: { alert: () => {} } as never, watchdog, server: server as never,
    })

    engine.handle(ev('Notification', { message: 'Allow?' }))
    expect(db.openWaits()).toHaveLength(1)
    // A live ladder, not just a suppressed one — the sharp check the "mute"
    // and "snooze" tests above already rely on to distinguish cancellation
    // from mere suppression.
    expect(escalator.activeCount()).toBeGreaterThan(0)

    clock.advance(86_400_001)
    watchdog.tick()

    expect(store.get('s1')).toBeUndefined()
    expect(db.openWaits()).toHaveLength(0)
    expect(db.waitsSince(0)[0].resolvedBy).toBe('ttl')
    expect(escalator.activeCount()).toBe(0)
  })

  it('is a no-op for a session with no open wait — nothing to cancel or close', () => {
    build()
    engine.handle(ev('SessionStart'))
    clock.advance(86_400_001)
    // watchdog isn't wired to the FakeClock's schedule here (build() stubs
    // the server, not the watchdog loop), so drive the sweep directly.
    expect(() => engine.onWatchdogDrop('s1')).not.toThrow()
    expect(db.openWaits()).toHaveLength(0)
  })
})

describe('periodic retention pruning via the watchdog (I2)', () => {
  it('prunes old events and resolved waits again after the initial boot-time prune, without a restart', async () => {
    const cfg = mergeConfig({
      channel: { id: 'test', options: {} },
      retentionDays: 1,
      watchdog: { stallAfterMs: 900_000, sessionTtlMs: 86_400_000, tickMs: 30_000 },
    }) as NudgeConfig
    clock = new FakeClock(0); db = new Db(join(dir, 'prune.db')); local = []; phone = []
    const store = new SessionStore(cfg, clock)
    const dispatcher = new Dispatcher(cfg, clock, async () => ({
      id: 'test', configSchema: {}, send: async () => {},
    }))
    const escalator = new Escalator({ cfg, clock, idleMs: () => 0, onLocal: () => {}, onPhone: () => {} })
    const watchdog = new Watchdog(
      cfg, clock, store,
      t => engine.onWatchdogStall(t),
      id => engine.onWatchdogDrop(id),
      () => engine.onWatchdogPrune(),
    )
    // hasGuiClient: () => false — Finding 5's onLocal gate calls this on every
  // local-alert check; every test in this file assumes no GUI is connected
  // (real GUI-gating behaviour is covered separately, see engine.test.ts's
  // "Finding 5" describe block below).
  const server = { broadcast: vi.fn(), listen: vi.fn(), close: vi.fn(), hasGuiClient: () => false }
    engine = new Engine({
      cfg, clock, store, db, escalator, dispatcher,
      notifier: { alert: () => {} } as never, watchdog, server: server as never,
    })

    // The one-shot boot-time prune (engine.ts's start()) — nothing exists
    // yet, so this is a no-op. Proves the periodic path below isn't just
    // riding on this call.
    await engine.start()

    clock.advance(1_000)
    const oldSession: SessionState = {
      sessionId: 'old', project: 'x', cwd: '/a/x', surface: { kind: 'unknown' },
      status: 'blocked', tier: 'blocked', waitingSince: clock.now(), turnStartedAt: null,
      lastEventAt: clock.now(), message: 'Allow?', snoozedUntil: null, pushFailed: false,
    }
    db.recordEvent({
      source: 'claude-code', sessionId: 'old', hook: 'Notification',
      cwd: '/a/x', project: 'x', ts: clock.now(),
    })
    db.openWait(oldSession, 'blocked')
    db.closeWait('old', clock.now(), 'manual')
    expect(db.eventCount()).toBe(1)
    expect(db.waitsSince(0)).toHaveLength(1)

    // Past retentionDays (1 day) *and* past PRUNE_INTERVAL_MS (1h) from
    // boot — old enough that only a periodic sweep, not the one-shot boot
    // prune (which already ran, before either row existed), can be what
    // notices and prunes these. engine.start() above already started the
    // real watchdog loop, so this single big jump fires every intermediate
    // tick along the way (FakeClock.advance() runs all due tasks in
    // deadline order, including ones a callback reschedules) — the
    // periodic onPrune the loop itself is driving, not a manually-invoked
    // extra tick(), is what has to notice and prune these.
    clock.advance(86_400_000 + PRUNE_INTERVAL_MS)

    expect(db.eventCount()).toBe(0)
    expect(db.waitsSince(0)).toHaveLength(0)

    await engine.stop()
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

/**
 * Finding I10: `isValidEvent` (shared/normalize.ts) used to check `hook`,
 * `sessionId`, `cwd`, `project` and `ts`, but not `message`/`tool`/`source`.
 * An `event` message off the wire with e.g. `message: {evil:true}` used to
 * pass that guard, reach `EngineServer#onEvent` → `Engine#handle`, and get
 * applied to the store (`store.apply()` runs *before* `db.recordEvent()`,
 * which is what actually threw on the bad bind) — so the session was left
 * sitting in the store, mutated, with no wait row opened and no escalation
 * ladder armed, because `handle()` throws before reaching
 * `#applyTransition`/`broadcast`. This is a full round-trip through the real
 * socket path (the same one the C1 "malformed events" tests in
 * server.test.ts exercise), with a real `SessionStore`/`Db` behind it,
 * specifically to prove the *store* — not just "no exception escaped" — is
 * left untouched now that the guard catches these fields too.
 */
describe('malformed optional fields never reach the store (I10)', () => {
  // Real Engine + real SessionStore + real Db behind a real EngineServer
  // socket, one dedicated to this describe block's own dbName/sockName —
  // the same shape as "stop() cancels every timer" above, trimmed to just
  // what's needed to send one wire message and inspect the store after.
  function buildReal(dbName: string) {
    const cfg = mergeConfig({ channel: { id: 'test', options: {} } }) as NudgeConfig
    clock = new FakeClock(0); db = new Db(join(dir, dbName)); local = []; phone = []
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
    return { store, db, server }
  }

  async function sendOverSocket(server: EngineServer, sockPath: string, event: unknown): Promise<void> {
    await server.listen(sockPath)
    await new Promise<void>(resolve => {
      const sock = connect(sockPath, () => {
        sock.write(encode({ t: 'event', event }))
        sock.end()
        resolve()
      })
    })
    await new Promise(r => setTimeout(r, 100))
  }

  it('a non-string message is dropped before it can mutate the store', async () => {
    const { store, db, server } = buildReal('i10-bad.db')
    try {
      const badEvent = {
        source: 'claude-code', sessionId: 's1', hook: 'Notification',
        cwd: '/a/my-repo', project: 'my-repo', ts: clock.now(), message: { evil: true },
      }
      await sendOverSocket(server, join(dir, 'i10-bad.sock'), badEvent)

      // The sharp checks: not "handle() didn't throw", but that nothing it
      // would have done before throwing actually happened.
      expect(store.list()).toHaveLength(0)
      expect(store.get('s1')).toBeUndefined()
      expect(db.eventCount()).toBe(0)
      expect(db.openWaits()).toHaveLength(0)
    } finally {
      await server.close()
    }
  })

  it('the same event with a valid string message reaches and mutates the store', async () => {
    const { store, db, server } = buildReal('i10-good.db')
    try {
      const goodEvent = {
        source: 'claude-code', sessionId: 's1', hook: 'Notification',
        cwd: '/a/my-repo', project: 'my-repo', ts: clock.now(), message: 'Allow?',
      }
      await sendOverSocket(server, join(dir, 'i10-good.sock'), goodEvent)

      expect(store.get('s1')).toBeDefined()
      expect(store.list()).toHaveLength(1)
      expect(db.eventCount()).toBe(1)
      expect(db.openWaits()).toHaveLength(1)
    } finally {
      await server.close()
    }
  })
})
