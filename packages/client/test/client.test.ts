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
 *
 * Also answers `list` (mirroring EngineServer#handle's real
 * `{t:'ok', id, data: onList()}` reply) with `opts.listData` — defaulting to
 * an empty array so existing tests that never send `list` are unaffected.
 * This is Finding I1's fix: without a client that asks for `list` on
 * connect, this stub option would go unused.
 */
function stubEngine(opts: {
  onSubscribe?: (s: Socket, id: number) => void
  onList?: (s: Socket, id: number) => void
  listData?: SessionState[]
} = {}) {
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
        } else if (m.t === 'list') {
          s.write(encode({ t: 'ok', id: m.id, data: opts.listData ?? [] }))
          opts.onList?.(s, m.id)
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
    // The client also sends `list` right after `subscribe` (Finding I1) —
    // wait for that initial (empty, since this stub holds nothing) snapshot
    // to land first, so it can't be confused with the real broadcast below.
    await vi.waitFor(() => expect(states).toHaveLength(1))
    expect(states[0]).toHaveLength(0)

    subscriber!.write(encode({ t: 'state', sessions: [session()] }))
    await vi.waitFor(() => expect(states).toHaveLength(2))
    expect(states[1]).toHaveLength(1)
    expect(states[1][0].sessionId).toBe('s1')
  })

  // Finding I1 (CRITICAL): the engine only ever broadcasts on a *transition*
  // — it never sends a snapshot to a client that subscribes into an
  // already-stable state. A client connecting to an engine that already
  // holds a waiting session (or one that simply never changes state again)
  // must still learn about it, via the `list` request the wire protocol
  // already supports. Without this, `onState` never fires at all here — the
  // status bar stays blind (`mine` stuck at `[]`) for the entire session.
  it('receives an initial snapshot via `list` even though the stub engine never broadcasts (I1)', async () => {
    const already = [session({ sessionId: 'already-waiting', project: 'blocked-repo' })]
    let sawList = false
    const engine = stubEngine({ listData: already, onList: () => { sawList = true } })
    await listen(engine, sockPath)

    const states: SessionState[][] = []
    const client = makeClient()
    client.onState(s => states.push(s))
    client.connect()

    await vi.waitFor(() => expect(client.connected).toBe(true))
    await vi.waitFor(() => expect(states.length).toBeGreaterThan(0), { timeout: 2000 })

    expect(sawList).toBe(true)
    expect(states[0]).toHaveLength(1)
    expect(states[0][0].sessionId).toBe('already-waiting')
  })

  // I4 mutation coverage: the 'connect' handler resets #backoffMs back to
  // #initialBackoffMs on every successful connect, not only via dispose().
  // Without that reset, a client that struggled through several failed
  // attempts (backoff climbing well past its initial value) before finally
  // connecting would still be sitting on that grown value the next time the
  // engine drops — so the very next retry would be slow, not prompt.
  it('resets backoff to the initial delay after a successful connect, not just via dispose (I4)', async () => {
    const path = join(dir, 'flaky.sock')
    const client = makeClient({ path, initialBackoffMs: 20, maxBackoffMs: 500 })
    client.connect()

    // Let backoff climb well past its initial value across several failed
    // attempts against a socket nothing is listening on yet
    // (20 -> 40 -> 80 -> 160 -> 320 -> capped at 500).
    await new Promise(r => setTimeout(r, 650))
    expect(client.connected).toBe(false)

    // Bring an engine up: whichever already-grown delay the client is
    // currently waiting on, this connect succeeds.
    const engine1 = stubEngine()
    await listen(engine1, path)
    await vi.waitFor(() => expect(client.connected).toBe(true), { timeout: 3000 })

    // Take it down again and time the very next retry.
    await teardown(engine1)
    await vi.waitFor(() => expect(client.connected).toBe(false))

    const start = Date.now()
    let resubscribedAt = -1
    const engine2 = stubEngine({ onSubscribe: () => { if (resubscribedAt < 0) resubscribedAt = Date.now() - start } })
    await listen(engine2, path)
    await vi.waitFor(() => expect(resubscribedAt).toBeGreaterThanOrEqual(0), { timeout: 2000 })

    // A successful connect must reset backoff to ~20ms. Without the reset,
    // this retry would fire at the already-grown delay (hundreds of ms,
    // capped at 500) instead.
    expect(resubscribedAt).toBeLessThan(150)
  }, 10_000)

  // I4 mutation coverage: connect() rebuilds #dec (`this.#dec = new
  // NdjsonDecoder()`) on every fresh connection attempt. Without that reset,
  // a partial line left in the decoder's internal buffer by a connection
  // that dropped mid-frame would silently corrupt the framing of the next
  // connection's very first message.
  it('resets the NDJSON decoder on every fresh connection, so a stray partial line from a dropped socket cannot corrupt the next connection (I4)', async () => {
    // Sockets are tracked in a Set handed to `servers` (same bookkeeping
    // `stubEngine()` does) so afterEach's teardown can force-close them even
    // if this test's own cleanup below doesn't run to completion.
    const sockets = new Set<Socket>()
    const accepted: Socket[] = []
    const engine = createServer(s => {
      accepted.push(s)
      sockets.add(s)
      s.on('close', () => sockets.delete(s))
    })
    servers.push({ server: engine, sockets })
    await listen({ server: engine }, sockPath)

    // A short, fixed backoff: after the drop below, the client reconnects to
    // this SAME still-listening engine on its own — a second real 'connect',
    // which is exactly the event that must rebuild the decoder.
    const client = makeClient({ initialBackoffMs: 20, maxBackoffMs: 20 })
    client.connect()
    await vi.waitFor(() => expect(client.connected).toBe(true))
    await vi.waitFor(() => expect(accepted).toHaveLength(1))

    // A line with no trailing newline: it sits in the client's NdjsonDecoder
    // buffer, incomplete, forever — unless the decoder itself gets replaced.
    accepted[0].write('{"t":"state","sessions":[{"__partial')
    // Let the write actually flush to the pipe before severing the
    // connection — destroying immediately can drop data still in flight.
    await new Promise(r => setTimeout(r, 20))
    accepted[0].destroy()

    // Wait for the client's own backoff to produce a second, fresh
    // connection to this same engine.
    await vi.waitFor(() => expect(accepted).toHaveLength(2), { timeout: 2000 })
    await vi.waitFor(() => expect(client.connected).toBe(true), { timeout: 2000 })

    const states: SessionState[][] = []
    client.onState(s => states.push(s))
    // A complete, valid frame on the new connection. Without a decoder
    // reset, this line is corrupted by the leftover partial buffer from the
    // dropped connection and never parses into a `state` message.
    accepted[1].write(encode({ t: 'state', sessions: [session({ sessionId: 'fresh' })] }))

    await vi.waitFor(() => expect(states).toHaveLength(1))
    expect(states[0][0].sessionId).toBe('fresh')
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

  // Finding I3: both existing dispose tests above use a client that never
  // connected — they only exercise the pending-timer path (#clearReconnectTimer).
  // Neither can catch a regression in the OTHER half of dispose(): destroying
  // the live socket, and marking the client disposed so a 'close' fired by
  // that destroy() doesn't schedule yet another reconnect. This test connects
  // for real first, then disposes, and asserts both the server-side socket
  // actually closes AND that no new connection ever arrives afterwards.
  it('dispose() while connected destroys the live socket and does not reconnect (I3)', async () => {
    let connectionCount = 0
    const engine = stubEngine({ onSubscribe: () => { connectionCount++ } })
    await listen(engine, sockPath)

    const client = makeClient({ initialBackoffMs: 20, maxBackoffMs: 20 })
    client.connect()
    await vi.waitFor(() => expect(client.connected).toBe(true))
    expect(connectionCount).toBe(1)

    const [serverSideSocket] = engine.sockets
    let serverSawClose = false
    serverSideSocket.on('close', () => { serverSawClose = true })

    client.dispose()

    await vi.waitFor(() => expect(serverSawClose).toBe(true))
    // Long enough for a surviving (uncancelled) reconnect timer to have
    // fired and opened a second connection, had dispose() not actually
    // taken effect.
    await new Promise(r => setTimeout(r, 200))
    expect(connectionCount).toBe(1)
    expect(client.connected).toBe(false)
  })
})
