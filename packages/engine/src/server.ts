import { createServer, type Server, type Socket } from 'node:net'
import { chmodSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import type { NudgeEvent, SessionState } from '@nudge/shared/types'
import { encode, NdjsonDecoder, type ClientMessage } from '@nudge/shared/protocol'
import { socketPath } from '@nudge/shared/paths'
import { isValidEvent } from '@nudge/shared/normalize'

export interface ServerHandlers {
  onEvent(ev: NudgeEvent): void
  onList(): SessionState[]
  onSnooze(sessionId: string, ms: number): void
  onMute(on: boolean): void
  onResolve(sessionId: string): void
  onIdle(idleMs: number): void
  onFrontmost(sessionId: string | null): void
  /**
   * Review round 1, Finding 5 (USER-APPROVED): fires the instant the LAST
   * remaining GUI client (see `#guiSubscribers` below) disconnects while
   * sessions are still waiting. Optional (defaults to a no-op via `?.()`
   * below) so every existing test that builds `ServerHandlers` without it —
   * and there are many, across server.test.ts/engine.test.ts/integration.test.ts
   * — keeps working unchanged; bin.ts's real wiring always supplies it.
   *
   * Why this exists: `Engine#onLocal` skips its own desktop notification
   * whenever `hasGuiClient()` is true, trusting the tray's own clickable one
   * instead. That trust is only safe if the fallback resumes IMMEDIATELY when
   * the last GUI vanishes (tray quit or crashed) — "the instant no GUI client
   * is connected," not merely "whenever the next scheduled local-repeat timer
   * happens to fire" (which could be `localRepeatIntervalMs` away, or never,
   * if `localRepeat` is configured to 0). See Engine#onGuiDisconnected.
   */
  onGuiDisconnected?(): void
}

export class EngineServer {
  #server: Server | null = null
  // Every accepted connection, subscribed or not — close() must be able to
  // tear all of them down, or a lingering non-subscribing client (a GUI that
  // connected and sent `list` but never disappeared) hangs shutdown forever.
  #sockets = new Set<Socket>()
  // Subset of #sockets that opted into `subscribe` — the only ones broadcast() writes to.
  #subscribers = new Set<Socket>()
  // Subset of #subscribers that subscribed with `gui: true` (Finding 5) — the
  // set `hasGuiClient()` reports on, and whose emptying (from >0 to 0) fires
  // `onGuiDisconnected`.
  #guiSubscribers = new Set<Socket>()

  constructor(private h: ServerHandlers) {}

  async listen(path = socketPath()): Promise<void> {
    if (process.platform !== 'win32') {
      mkdirSync(dirname(path), { recursive: true })
      // A crashed engine leaves the socket file behind; unlink before binding.
      try {
        unlinkSync(path)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
    }

    const server = createServer(sock => this.#attach(sock))
    this.#server = server

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })

    // The listener above only covers startup failures and is removed once
    // listen() succeeds. Without a durable replacement, a Server with zero
    // 'error' listeners crashes the whole process on the next EMFILE/etc.
    // during accept() — the component whose job is to notice problems must
    // not itself die quietly. This is a background daemon, so stderr is its log.
    server.on('error', err => { console.error('nudge server: error', err) })

    if (process.platform !== 'win32') chmodSync(path, 0o600)
  }

  #attach(sock: Socket): void {
    const dec = new NdjsonDecoder()
    this.#sockets.add(sock)
    sock.setEncoding('utf8')
    // Finding 5: both handlers also drop `sock` from `#guiSubscribers` (a
    // plain Set#delete is a harmless no-op if it was never a GUI subscriber
    // in the first place — same "belt and braces, cheap to duplicate"
    // pattern this method already uses for #sockets/#subscribers). Node
    // always emits 'close' after 'error' for a Socket, so on an errored
    // socket `wasGui` is true on the FIRST handler to run and false on the
    // second (the entry is already gone) — `onGuiDisconnected` fires at most
    // once per socket, not twice.
    const onGone = (): void => {
      const wasGui = this.#guiSubscribers.delete(sock)
      this.#sockets.delete(sock)
      this.#subscribers.delete(sock)
      if (wasGui && this.#guiSubscribers.size === 0) {
        try {
          this.h.onGuiDisconnected?.()
        } catch (err) {
          console.error('nudge server: onGuiDisconnected handler failed', err)
        }
      }
    }
    sock.on('error', onGone)
    sock.on('close', onGone)
    sock.on('data', chunk => {
      for (const raw of dec.push(chunk as unknown as string)) {
        this.#handle(sock, raw as ClientMessage)
      }
    })
  }

  #reply(sock: Socket, msg: unknown): void {
    // Belt-and-braces: Socket#write() on a destroyed socket returns false
    // rather than throwing, so this catch rarely fires. The real eviction
    // path is the close/error listeners registered in #attach.
    try { sock.write(encode(msg)) } catch { /* peer vanished */ }
  }

  /**
   * Finding C1: this used to dispatch straight into `this.h.*` with no
   * try/catch and no validation of the wire payload. A single malformed
   * `event` message (e.g. missing `ts` — a version-skewed hook/engine pair,
   * or a corrupted spool file) reached `Db.recordEvent`'s SQLite bind
   * unguarded and threw, and with nothing catching it here, that exception
   * propagated out of the socket's `data` handler and crashed the whole
   * daemon (uncaught exception, exit 1) — taking every other session's
   * ladder down with it. Every other handler in this codebase (watchdog,
   * drift, Engine#onLocal/#onPhone, and this class's own `server.on('error',
   * ...)`) already follows the convention of catching and logging rather
   * than letting an exception escape; this was the one place that didn't.
   *
   * Two independent layers now guard against that: `isValidEvent` rejects a
   * malformed `event` payload before it ever reaches the store or the DB,
   * and the try/catch is defense in depth against anything else that
   * throws (a SQLite I/O error from `recordEvent`/`openWait`/`closeWait`, a
   * misbehaving handler) — the same "log it, keep the daemon alive" rule
   * bin.ts's process-level `uncaughtException`/`unhandledRejection`
   * listeners enforce one level up.
   */
  #handle(sock: Socket, m: ClientMessage): void {
    try {
      switch (m?.t) {
        case 'event':
          if (!isValidEvent(m.event)) {
            console.error('nudge server: dropping malformed event', m.event)
            return
          }
          this.h.onEvent(m.event)
          return
        case 'idle':     this.h.onIdle(m.idleMs); return
        case 'frontmost': this.h.onFrontmost(m.sessionId); return
        case 'ping':     this.#reply(sock, { t: 'ok', id: m.id }); return
        case 'list':     this.#reply(sock, { t: 'ok', id: m.id, data: this.h.onList() }); return
        case 'subscribe': {
          this.#subscribers.add(sock)
          // Symmetric: a re-subscribe WITHOUT `gui` un-declares, and if that
          // was the last GUI client the engine must resume its own banner —
          // otherwise it stays suppressed forever with nothing showing one.
          if (m.gui) {
            this.#guiSubscribers.add(sock)
          } else if (this.#guiSubscribers.delete(sock) && this.#guiSubscribers.size === 0) {
            this.h.onGuiDisconnected?.()
          }
          this.#reply(sock, { t: 'ok', id: m.id })
          return
        }
        case 'snooze':
          this.h.onSnooze(m.sessionId, m.ms)
          this.#reply(sock, { t: 'ok', id: m.id })
          return
        case 'mute':
          this.h.onMute(m.on)
          this.#reply(sock, { t: 'ok', id: m.id })
          return
        case 'resolve':
          this.h.onResolve(m.sessionId)
          this.#reply(sock, { t: 'ok', id: m.id })
          return
        default:
          this.#reply(sock, {
            t: 'err',
            id: (m as { id?: number })?.id ?? 0,
            message: `unknown message type: ${String((m as { t?: string })?.t)}`,
          })
      }
    } catch (err) {
      console.error('nudge server: handler failed', err)
    }
  }

  broadcast(sessions: SessionState[]): void {
    const payload = encode({ t: 'state', sessions })
    for (const sock of this.#subscribers) {
      // Belt-and-braces here too: write() on a destroyed socket returns
      // false rather than throwing. Real eviction happens via #attach's
      // close/error listeners; this catch only guards a synchronous throw.
      // Evict from BOTH sets. Dropping only #subscribers is how
      // hasGuiClient() gets stuck true for a socket that is already gone,
      // which silences the engine's own banner permanently.
      try {
        sock.write(payload)
      } catch {
        this.#subscribers.delete(sock)
        if (this.#guiSubscribers.delete(sock) && this.#guiSubscribers.size === 0) {
          this.h.onGuiDisconnected?.()
        }
      }
    }
  }

  /** Finding 5: whether at least one currently-connected client declared itself a GUI via `subscribe({ gui: true })`. */
  hasGuiClient(): boolean {
    return this.#guiSubscribers.size > 0
  }

  async close(): Promise<void> {
    // Destroy every accepted connection, not just subscribers — net.Server's
    // close() callback waits for ALL open connections to end, so a lingering
    // non-subscribing client would otherwise hang this indefinitely.
    for (const s of this.#sockets) s.destroy()
    this.#sockets.clear()
    this.#subscribers.clear()
    // Cleared synchronously here (before the sockets' own async 'close'
    // events land) so a graceful shutdown never fires `onGuiDisconnected` —
    // there is nothing useful to fall back to while the engine itself is
    // going down. By the time each destroyed socket's 'close' event actually
    // fires, this set is already empty, so #attach's `onGone` sees
    // `wasGui === false` for all of them.
    this.#guiSubscribers.clear()
    const server = this.#server
    if (!server) return
    this.#server = null
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
