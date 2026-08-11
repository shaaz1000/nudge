import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createServer, type Server, type Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encode, NdjsonDecoder } from '@nudge/shared/protocol'
import type { SessionState } from '@nudge/shared/types'
import { EngineClient } from '../src/client.js'

let dir: string
let sockPath: string
const servers: { server: Server; sockets: Set<Socket> }[] = []
const clients: EngineClient[] = []

const session = (over: Partial<SessionState> = {}): SessionState => ({
  sessionId: 's1', project: 'my-repo', cwd: '/a/my-repo',
  surface: { kind: 'vscode' }, status: 'blocked', tier: 'blocked',
  waitingSince: 1, turnStartedAt: null, lastEventAt: 1,
  message: 'Allow?', snoozedUntil: null, pushFailed: false, ...over,
})

/**
 * A stub engine that speaks the real NDJSON protocol (encode/NdjsonDecoder
 * from @nudge/shared/protocol) — that wire format is the contract under
 * test, not the engine's own internal behaviour. Tracks accepted sockets so
 * tests can force a hard disconnect (an EngineServer.close() equivalent):
 * server.close() alone only stops accepting *new* connections, it does not
 * sever ones already established.
 */
function stubEngine(opts: { onSubscribe?: (s: Socket, id: number) => void } = {}) {
  const sockets = new Set<Socket>()
  const server = createServer(s => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
    const dec = new NdjsonDecoder()
    s.setEncoding('utf8')
    s.on('data', chunk => {
      for (const raw of dec.push(chunk as unknown as string)) {
        const m = raw as { t: string; id: number }
        if (m.t === 'subscribe') {
          s.write(encode({ t: 'ok', id: m.id }))
          opts.onSubscribe?.(s, m.id)
        }
      }
    })
  })
  const entry = { server, sockets }
  servers.push(entry)
  return entry
}

function listen(entry: { server: Server }, path: string): Promise<void> {
  return new Promise(resolve => entry.server.listen(path, () => resolve()))
}

/** Mirrors EngineServer#close(): destroy every accepted socket, then close. */
function teardown(entry: { server: Server; sockets: Set<Socket> }): Promise<void> {
  for (const s of entry.sockets) s.destroy()
  return new Promise(resolve => entry.server.close(() => resolve()))
}

function makeClient(opts: { path?: string; initialBackoffMs?: number; maxBackoffMs?: number } = {}): EngineClient {
  const c = new EngineClient({ path: sockPath, ...opts })
  clients.push(c)
  return c
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nudge-vscx-'))
  sockPath = join(dir, 'engine.sock')
})

afterEach(async () => {
  for (const c of clients) c.dispose()
  clients.length = 0
  for (const entry of servers) await teardown(entry).catch(() => { /* already closed */ })
  servers.length = 0
  rmSync(dir, { recursive: true, force: true })
})

describe('EngineClient', () => {
  it('subscribes on connect and surfaces broadcast state', async () => {
    let subscriber: Socket | null = null
    const engine = stubEngine({ onSubscribe: s => { subscriber = s } })
    await listen(engine, sockPath)

    const states: SessionState[][] = []
    const client = makeClient()
    client.onState(s => states.push(s))
    client.connect()

    await vi.waitFor(() => expect(client.connected).toBe(true))
    await vi.waitFor(() => expect(subscriber).not.toBeNull())

    subscriber!.write(encode({ t: 'state', sessions: [session()] }))
    await vi.waitFor(() => expect(states).toHaveLength(1))
    expect(states[0]).toHaveLength(1)
    expect(states[0][0].sessionId).toBe('s1')
  })

  it('reconnects with backoff after the engine goes away', async () => {
    const engine1 = stubEngine()
    await listen(engine1, sockPath)

    const client = makeClient({ initialBackoffMs: 15, maxBackoffMs: 60 })
    client.connect()
    await vi.waitFor(() => expect(client.connected).toBe(true))

    // Simulate the engine dying under launchd: the socket the client is
    // holding must actually be severed, not just stop accepting new peers.
    await teardown(engine1)
    await vi.waitFor(() => expect(client.connected).toBe(false), { timeout: 2000 })

    // launchd's KeepAlive restarts the engine at the same socket path.
    let resubscribed = false
    const engine2 = stubEngine({ onSubscribe: () => { resubscribed = true } })
    await listen(engine2, sockPath)

    await vi.waitFor(() => expect(client.connected).toBe(true), { timeout: 2000 })
    await vi.waitFor(() => expect(resubscribed).toBe(true))
  })

  it('reports disconnected rather than throwing when no engine is listening', async () => {
    const client = makeClient({ path: join(dir, 'absent.sock') })
    expect(() => client.connect()).not.toThrow()
    await new Promise(r => setTimeout(r, 100))
    expect(client.connected).toBe(false)
  })

  it('never rejects an unhandled promise when the socket errors', async () => {
    const rejections: unknown[] = []
    const onUnhandledRejection = (err: unknown) => rejections.push(err)
    process.on('unhandledRejection', onUnhandledRejection)

    try {
      // Accept the connection, then immediately reset it — forces an
      // ECONNRESET-style socket error on the client rather than a mere
      // refused connection.
      const entry = { server: createServer(s => s.destroy()), sockets: new Set<Socket>() }
      servers.push(entry)
      await listen(entry, sockPath)

      const client = makeClient({ initialBackoffMs: 10, maxBackoffMs: 20 })
      client.connect()
      await new Promise(r => setTimeout(r, 150))
      expect(client.connected).toBe(false)
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }

    expect(rejections).toHaveLength(0)
  })

  it('dispose cancels a pending reconnect timer instead of leaking a connection per reload', async () => {
    const path = join(dir, 'appears-later.sock')
    // Nothing is listening yet: connect() fails fast and schedules a retry.
    const client = makeClient({ path, initialBackoffMs: 20, maxBackoffMs: 20 })
    client.connect()
    await new Promise(r => setTimeout(r, 50))
    expect(client.connected).toBe(false)

    client.dispose()

    let connections = 0
    const engine = stubEngine({ onSubscribe: () => { connections++ } })
    await listen(engine, path)
    // Long enough for the cancelled backoff to have fired had it survived dispose().
    await new Promise(r => setTimeout(r, 200))
    expect(connections).toBe(0)
  })

  // The test above proves the end-to-end outcome (no leaked connection), but
  // connect()'s own disposed-guard would mask a dispose() that forgot to
  // cancel the timer at all — the timer would still fire, call connect(),
  // and connect() would no-op anyway. This test isolates the specific
  // mechanism by spying on the global clearTimeout: it fails if dispose()
  // stops calling it, regardless of what connect()'s guard would do.
  it('dispose() calls clearTimeout on the pending reconnect timer', async () => {
    const clearSpy = vi.spyOn(global, 'clearTimeout')
    const path = join(dir, 'never-appears.sock')
    const client = makeClient({ path, initialBackoffMs: 5_000, maxBackoffMs: 5_000 })
    client.connect()
    await new Promise(r => setTimeout(r, 30))
    expect(client.connected).toBe(false)

    const callsBeforeDispose = clearSpy.mock.calls.length
    client.dispose()
    expect(clearSpy.mock.calls.length).toBeGreaterThan(callsBeforeDispose)
    clearSpy.mockRestore()
  })
})
