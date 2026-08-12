import { connect, type Socket } from 'node:net'
import { encode, NdjsonDecoder, type ClientMessage, type ServerMessage } from '@nudge/shared/protocol'
import type { SessionState } from '@nudge/shared/types'
import { socketPath } from '@nudge/shared/paths'

export interface EngineClientOptions {
  /** Overrides socketPath() — tests only. Production always uses the real socket. */
  path?: string
  /** Initial reconnect delay in ms. Defaults to 1s; tests shrink this to run fast. */
  initialBackoffMs?: number
  /** Reconnect backoff cap in ms — the design constraint calls for 30s. */
  maxBackoffMs?: number
  /**
   * Review round 1, Finding 5 (USER-APPROVED): declares this connection a GUI
   * client on every `subscribe`, so the engine can skip its own desktop
   * notification and trust this client to show a clickable one instead (see
   * packages/engine/src/engine.ts's `onLocal`). Defaults to `false` — an
   * `EngineClient` that doesn't opt in behaves exactly as before. Only
   * packages/tray/src/main.ts sets this to `true`; the VS Code extension
   * deliberately does not (see extension.ts's comment for why: its toasts are
   * only visible while the editor window itself is focused, so it cannot
   * safely stand in for the engine's OS-level banner).
   */
  gui?: boolean
}

const DEFAULT_INITIAL_BACKOFF_MS = 1_000
const DEFAULT_MAX_BACKOFF_MS = 30_000

/**
 * A thin, never-throwing client of the Nudge engine's socket (a Unix domain
 * socket, or a named pipe on Windows — socketPath() already knows which).
 * It connects, subscribes, and forwards `state` broadcasts to `onState`
 * listeners.
 *
 * Design constraints (see the Phase 2 plan): a missing or dead engine is a
 * quiet `connected === false`, never a modal and never a thrown exception
 * into the extension host. The engine restarts under launchd/systemd
 * `KeepAlive`, so a dropped connection reconnects on its own with
 * exponential backoff capped at `maxBackoffMs`, rather than requiring the
 * composition root to notice and retry.
 */
export class EngineClient {
  readonly #path: string
  readonly #initialBackoffMs: number
  readonly #maxBackoffMs: number
  #backoffMs: number
  #sock: Socket | null = null
  #dec = new NdjsonDecoder()
  #listeners = new Set<(s: SessionState[], frontmost: string | null) => void>()
  #frontmost: string | null = null
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null
  #disposed = false
  #nextId = 1
  #connected = false
  // Finding I1: the engine only ever broadcasts `state` on a *transition* —
  // a client that subscribes into an already-stable state (e.g. a session
  // that has been sitting `blocked` for the last ten minutes) never gets
  // told about it. The wire protocol already has a `list` request for
  // exactly this; this tracks the id of the one currently in flight so
  // #onFrame can recognise its reply and treat it as an initial snapshot —
  // fed to the very same `onState` listeners a `state` broadcast uses, so
  // callers never need to know the difference.
  #pendingListId: number | null = null
  readonly #gui: boolean

  constructor(opts: EngineClientOptions = {}) {
    this.#path = opts.path ?? socketPath()
    this.#initialBackoffMs = opts.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS
    this.#maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
    this.#backoffMs = this.#initialBackoffMs
    this.#gui = opts.gui ?? false
  }

  get connected(): boolean {
    return this.#connected
  }

  /** The session the user is looking at, per the engine's last broadcast; null if unknown or unreported. */
  get frontmost(): string | null { return this.#frontmost }

  onState(cb: (s: SessionState[], frontmost: string | null) => void): void {
    this.#listeners.add(cb)
  }

  /**
   * Idempotent: a second call while a socket already exists (connecting or
   * connected) is a no-op rather than leaking an extra connection. The
   * reconnect path relies on this being safe to call repeatedly — it is the
   * same function the backoff timer calls on every retry.
   */
  connect(): void {
    if (this.#disposed || this.#sock) return
    this.#clearReconnectTimer()
    this.#dec = new NdjsonDecoder()

    let sock: Socket
    try {
      sock = connect(this.#path)
    } catch (err) {
      // net.connect() only throws synchronously for programmer error (bad
      // arguments); a dead/missing engine surfaces asynchronously via
      // 'error' below. Guarded anyway so a platform quirk can never escape
      // as an uncaught exception into the extension host.
      console.error('nudge client: failed to start connecting to engine', err)
      this.#scheduleReconnect()
      return
    }
    this.#sock = sock
    sock.setEncoding('utf8')

    // A Socket with zero 'error' listeners throws an uncaught exception
    // (crashing the extension host) instead of emitting quietly — this
    // listener existing at all is the load-bearing part, not what it does.
    sock.on('error', err => {
      console.error('nudge client: engine socket error', err)
    })

    sock.on('connect', () => {
      this.#connected = true
      this.#backoffMs = this.#initialBackoffMs
      // Spread rather than always emitting the key: a non-GUI client's
      // subscribe stays byte-identical to what it sent before `gui`
      // existed, so the extraction changes nothing on the wire for it.
      this.send({ t: 'subscribe', id: this.#nextId++, ...(this.#gui ? { gui: true } : {}) })
      // Finding I1: `subscribe` alone only arms future broadcasts. Asking
      // for `list` right behind it fills in whatever the engine is already
      // holding — the fix for a client that connects (or reconnects) into a
      // session that is already waiting and never changes again.
      const listId = this.#nextId++
      this.#pendingListId = listId
      this.send({ t: 'list', id: listId })
    })

    sock.on('data', chunk => {
      let frames: unknown[]
      try {
        frames = this.#dec.push(chunk as unknown as string)
      } catch (err) {
        console.error('nudge client: failed to decode engine frame', err)
        return
      }
      for (const frame of frames) this.#onFrame(frame as ServerMessage)
    })

    // Node always emits 'close' after 'error' for a Socket (including a
    // failed connection attempt), so reconnect scheduling lives here only —
    // not duplicated in the 'error' handler above.
    sock.on('close', () => {
      this.#connected = false
      this.#sock = null
      // A reply to the OLD connection's `list` can never arrive now, and a
      // stale id lingering here could — after enough id wraparound in a
      // long-lived window — coincidentally match a later request. Cheap to
      // clear, and removes any doubt.
      this.#pendingListId = null
      // A remembered frontmost from a dead engine would keep suppressing
      // alerts for a window the user may have left long ago.
      this.#frontmost = null
      if (!this.#disposed) this.#scheduleReconnect()
    })
  }

  #onFrame(msg: ServerMessage): void {
    if (msg?.t === 'state') {
      // `?? null`: an older engine omits the key entirely, which must
      // read as "unknown", not as a stale value from a previous broadcast.
      this.#frontmost = msg.frontmost ?? null
      this.#emit(msg.sessions)
      return
    }
    // Finding I1: the reply to the `list` request sent right after
    // `subscribe` (see the 'connect' handler above) is indistinguishable on
    // the wire from any other `ok` reply except by its id — this is that
    // recognition. Treated identically to a `state` broadcast from here on:
    // every `onState` listener gets it, so StatusBar/Toaster/extension.ts
    // never need their own separate "initial snapshot" code path.
    if (msg?.t === 'ok' && this.#pendingListId !== null && msg.id === this.#pendingListId) {
      this.#pendingListId = null
      this.#emit((msg.data ?? []) as SessionState[])
    }
  }

  #emit(sessions: SessionState[]): void {
    for (const cb of this.#listeners) {
      try {
        cb(sessions, this.#frontmost)
      } catch (err) {
        console.error('nudge client: onState listener threw', err)
      }
    }
  }

  send(msg: ClientMessage): void {
    const sock = this.#sock
    if (!sock || !this.#connected) return
    try {
      sock.write(encode(msg))
    } catch (err) {
      console.error('nudge client: failed to write to engine socket', err)
    }
  }

  #scheduleReconnect(): void {
    if (this.#disposed || this.#reconnectTimer) return
    const delay = this.#backoffMs
    this.#backoffMs = Math.min(this.#backoffMs * 2, this.#maxBackoffMs)
    const timer = setTimeout(() => {
      this.#reconnectTimer = null
      this.connect()
    }, delay)
    timer.unref?.()
    this.#reconnectTimer = timer
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
  }

  /**
   * Destroys the live socket (if any) and cancels a pending reconnect timer.
   * Without the timer cancellation, a disposed-then-reconnecting client from
   * a previous extension activation would keep retrying forever and, once
   * the engine came back, hold a socket nobody reads from — one leaked
   * connection per window reload.
   */
  dispose(): void {
    this.#disposed = true
    this.#clearReconnectTimer()
    this.#connected = false
    const sock = this.#sock
    this.#sock = null
    sock?.destroy()
  }
}
