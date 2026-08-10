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
  #subscribers = new Set<Socket>()

  constructor(private h: ServerHandlers) {}

  async listen(path = socketPath()): Promise<void> {
    if (process.platform !== 'win32') {
      mkdirSync(dirname(path), { recursive: true })
      // A crashed engine leaves the socket file behind; unlink before binding.
      try { unlinkSync(path) } catch { /* not present */ }
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

    if (process.platform !== 'win32') chmodSync(path, 0o600)
  }

  #attach(sock: Socket): void {
    const dec = new NdjsonDecoder()
    sock.setEncoding('utf8')
    sock.on('error', () => { this.#subscribers.delete(sock) })
    sock.on('close', () => { this.#subscribers.delete(sock) })
    sock.on('data', chunk => {
      for (const raw of dec.push(chunk as unknown as string)) {
        this.#handle(sock, raw as ClientMessage)
      }
    })
  }

  #reply(sock: Socket, msg: unknown): void {
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
      try { sock.write(payload) } catch { this.#subscribers.delete(sock) }
    }
  }

  async close(): Promise<void> {
    for (const s of this.#subscribers) s.destroy()
    this.#subscribers.clear()
    const server = this.#server
    if (!server) return
    this.#server = null
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
