#!/usr/bin/env node
import { performance } from 'node:perf_hooks'
import { loadConfig } from '@nudge/shared/config'
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
  process.on(sig, () => { void engine.stop().then(() => process.exit(0)) })
}
