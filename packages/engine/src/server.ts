import { createServer, type Server, type Socket } from 'node:net'
import { chmodSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import type { NudgeEvent, SessionState } from '@nudge/shared/types'
import { encode, NdjsonDecoder, type ClientMessage } from '@nudge/shared/protocol'
import { socketPath } from '@nudge/shared/paths'

export interface ServerHandlers {
  onEvent(ev: NudgeEvent): void
  onList(): SessionState[]
  onSnooze(sessionId: string, ms: number): void
  onMute(on: boolean): void
  onResolve(sessionId: string): void
  onIdle(idleMs: number): void
  onFrontmost(sessionId: string | null): void
}

export class EngineServer {
  #server: Server | null = null
  // Every accepted connection, subscribed or not — close() must be able to
  // tear all of them down, or a lingering non-subscribing client (a GUI that
  // connected and sent `list` but never disappeared) hangs shutdown forever.
  #sockets = new Set<Socket>()
  // Subset of #sockets that opted into `subscribe` — the only ones broadcast() writes to.
  #subscribers = new Set<Socket>()

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
    sock.on('error', () => { this.#sockets.delete(sock); this.#subscribers.delete(sock) })
    sock.on('close', () => { this.#sockets.delete(sock); this.#subscribers.delete(sock) })
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

  #handle(sock: Socket, m: ClientMessage): void {
    switch (m?.t) {
      case 'event':    this.h.onEvent(m.event); return
      case 'idle':     this.h.onIdle(m.idleMs); return
      case 'frontmost': this.h.onFrontmost(m.sessionId); return
      case 'ping':     this.#reply(sock, { t: 'ok', id: m.id }); return
      case 'list':     this.#reply(sock, { t: 'ok', id: m.id, data: this.h.onList() }); return
      case 'subscribe':
        this.#subscribers.add(sock)
        this.#reply(sock, { t: 'ok', id: m.id })
        return
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
  }

  broadcast(sessions: SessionState[]): void {
    const payload = encode({ t: 'state', sessions })
    for (const sock of this.#subscribers) {
      // Belt-and-braces here too: write() on a destroyed socket returns
      // false rather than throwing. Real eviction happens via #attach's
      // close/error listeners; this catch only guards a synchronous throw.
      try { sock.write(payload) } catch { this.#subscribers.delete(sock) }
    }
  }

  async close(): Promise<void> {
    // Destroy every accepted connection, not just subscribers — net.Server's
    // close() callback waits for ALL open connections to end, so a lingering
    // non-subscribing client would otherwise hang this indefinitely.
    for (const s of this.#sockets) s.destroy()
    this.#sockets.clear()
    this.#subscribers.clear()
    const server = this.#server
    if (!server) return
    this.#server = null
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
