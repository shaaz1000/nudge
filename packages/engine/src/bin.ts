#!/usr/bin/env node
import { performance } from 'node:perf_hooks'
import { loadConfig } from '@nudge/shared/config'
import { lockPath } from '@nudge/shared/paths'
import { loadChannels } from '@nudge/channels'
import { SystemClock } from './clock.js'
import { SessionStore } from './state.js'
import { Escalator } from './escalation.js'
import { Dispatcher } from './dispatch.js'
import { DesktopNotifier } from './desktop.js'
import { Watchdog } from './watchdog.js'
import { EngineServer } from './server.js'
import { Db } from './db.js'
import { Engine } from './engine.js'
import { drainSpool } from './drain.js'
import { DriftDetector } from './drift.js'
import { acquireLock } from './lock.js'

/**
 * Finding C1 (part 3): the last unguarded path. Every handler this daemon
 * runs already catches and logs rather than letting an exception escape
 * (server.ts's #handle and its `error` listener, watchdog.ts, drift.ts,
 * Engine#onLocal/#onPhone) — but nothing caught anything that slipped past
 * all of those, so a single one still took the whole process down (see the
 * C1 finding for the exact TypeError this produced from a missing `ts`).
 * These two are the final backstop: whatever gets here, log it and keep
 * running. A daemon whose entire job is noticing problems must not itself
 * disappear silently over one bad event.
 */
process.on('uncaughtException', err => {
  console.error('nudge engine: uncaught exception', err)
})
process.on('unhandledRejection', err => {
  console.error('nudge engine: unhandled rejection', err)
})

// Finding C2: exclusive single-instance guard. Must run before anything else
// touches the socket, the DB, or the watchdog/escalation timers — a second
// engine process for the same NUDGE_HOME exits here, quietly and cleanly,
// before any of that state exists. See lock.ts for why this is race-free
// and why a stale lock (holder no longer alive) is reclaimed rather than
// left to brick the engine forever after one crash.
const lock = acquireLock(lockPath())
if (!lock) {
  console.error('nudge engine: another engine instance is already running for this NUDGE_HOME; exiting.')
  process.exit(0)
}

const cfg = loadConfig()
const clock = new SystemClock()
const store = new SessionStore(cfg, clock)
const db = new Db()
const notifier = new DesktopNotifier(cfg)

const dispatcher = new Dispatcher(cfg, clock, async () => {
  if (!cfg.channel) return null
  const channels = await loadChannels()
  return channels.get(cfg.channel.id) ?? null
})

let engine: Engine

const escalator = new Escalator({
  cfg, clock,
  idleMs: () => engine.idleMs(),
  onLocal: (s, tier) => engine.onLocal(s, tier),
  onPhone: (s, tier) => { void engine.onPhone(s, tier) },
})

const watchdog = new Watchdog(cfg, clock, store, t => engine.onWatchdogStall(t))

const server = new EngineServer({
  onEvent: ev => engine.handle(ev),
  onList: () => engine.sessions(),
  onSnooze: (id, ms) => engine.snooze(id, ms),
  onMute: on => engine.mute(on),
  onResolve: id => engine.resolve(id),
  onIdle: ms => engine.setIdle(ms),
  onFrontmost: id => engine.setFrontmost(id),
})

const drift = new DriftDetector({
  clock,
  wall: () => Date.now(),
  mono: () => performance.now(),
  onDrift: () => engine.onResume(),
})

engine = new Engine({ cfg, clock, store, db, escalator, dispatcher, notifier, watchdog, server, drift })

await engine.start()
await drainSpool(ev => engine.handle(ev))

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { void engine.stop().then(() => { lock.release(); process.exit(0) }) })
}
