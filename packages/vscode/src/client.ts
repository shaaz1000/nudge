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
  #listeners = new Set<(s: SessionState[]) => void>()
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null
  #disposed = false
  #nextId = 1
  #connected = false

  constructor(opts: EngineClientOptions = {}) {
    this.#path = opts.path ?? socketPath()
    this.#initialBackoffMs = opts.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS
    this.#maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
    this.#backoffMs = this.#initialBackoffMs
  }

  get connected(): boolean {
    return this.#connected
  }

  onState(cb: (s: SessionState[]) => void): void {
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
      console.error('nudge vscode: failed to start connecting to engine', err)
      this.#scheduleReconnect()
      return
    }
    this.#sock = sock
    sock.setEncoding('utf8')

    // A Socket with zero 'error' listeners throws an uncaught exception
    // (crashing the extension host) instead of emitting quietly — this
    // listener existing at all is the load-bearing part, not what it does.
    sock.on('error', err => {
      console.error('nudge vscode: engine socket error', err)
    })

    sock.on('connect', () => {
      this.#connected = true
      this.#backoffMs = this.#initialBackoffMs
      this.send({ t: 'subscribe', id: this.#nextId++ })
    })

    sock.on('data', chunk => {
      let frames: unknown[]
      try {
        frames = this.#dec.push(chunk as unknown as string)
      } catch (err) {
        console.error('nudge vscode: failed to decode engine frame', err)
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
      if (!this.#disposed) this.#scheduleReconnect()
    })
  }

  #onFrame(msg: ServerMessage): void {
    if (msg?.t !== 'state') return
    for (const cb of this.#listeners) {
      try {
        cb(msg.sessions)
      } catch (err) {
        console.error('nudge vscode: onState listener threw', err)
      }
    }
  }

  send(msg: ClientMessage): void {
    const sock = this.#sock
    if (!sock || !this.#connected) return
    try {
      sock.write(encode(msg))
    } catch (err) {
      console.error('nudge vscode: failed to write to engine socket', err)
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
