import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { connect, type Socket } from 'node:net'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EngineServer } from '../src/server.js'
import { encode, NdjsonDecoder } from '@nudge/shared/protocol'
import type { NudgeEvent, SessionState } from '@nudge/shared/types'

let dir: string
let sock: string
let server: EngineServer
let received: NudgeEvent[]

const session = (): SessionState => ({
  sessionId: 's1', project: 'my-repo', cwd: '/a/my-repo',
  surface: { kind: 'vscode' }, status: 'blocked', tier: 'blocked',
  waitingSince: 1, turnStartedAt: null, lastEventAt: 1,
  message: 'Allow?', snoozedUntil: null, pushFailed: false,
})

function client(): Promise<{ s: Socket; next: () => Promise<unknown> }> {
  return new Promise(resolve => {
    const s = connect(sock, () => {
      const d = new NdjsonDecoder()
      const queue: unknown[] = []
      let waiter: ((v: unknown) => void) | null = null
      s.setEncoding('utf8')
      s.on('data', chunk => {
        for (const m of d.push(chunk as unknown as string)) {
          if (waiter) { waiter(m); waiter = null } else queue.push(m)
        }
      })
      resolve({
        s,
        next: () => queue.length
          ? Promise.resolve(queue.shift())
          : new Promise(res => { waiter = res }),
      })
    })
  })
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nudge-srv-'))
  sock = join(dir, 'engine.sock')
  received = []
  server = new EngineServer({
    onEvent: ev => { received.push(ev) },
    onList: () => [session()],
    onSnooze: vi.fn(),
    onMute: vi.fn(),
    onResolve: vi.fn(),
    onIdle: vi.fn(),
    onFrontmost: vi.fn(),
  })
  await server.listen(sock)
})

afterEach(async () => {
  await server.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('EngineServer', () => {
  it('accepts an event and hands it to the handler', async () => {
    const { s } = await client()
    const ev: NudgeEvent = {
      source: 'claude-code', sessionId: 's1', hook: 'Notification',
      cwd: '/a/my-repo', project: 'my-repo', ts: 1, message: 'Allow?',
    }
    s.write(encode({ t: 'event', event: ev }))
    await vi.waitFor(() => expect(received).toHaveLength(1))
    expect(received[0].sessionId).toBe('s1')
    s.end()
  })

  it('answers list with the current sessions', async () => {
    const { s, next } = await client()
    s.write(encode({ t: 'list', id: 7 }))
    const reply = await next() as { t: string; id: number; data: SessionState[] }
    expect(reply.t).toBe('ok')
    expect(reply.id).toBe(7)
    expect(reply.data[0].sessionId).toBe('s1')
    s.end()
  })

  it('answers ping', async () => {
    const { s, next } = await client()
    s.write(encode({ t: 'ping', id: 3 }))
    expect(await next()).toMatchObject({ t: 'ok', id: 3 })
    s.end()
  })

  it('returns an error for an unknown message type', async () => {
    const { s, next } = await client()
    s.write(encode({ t: 'nonsense', id: 9 }))
    expect(await next()).toMatchObject({ t: 'err', id: 9 })
    s.end()
  })

  it('broadcasts state to subscribers only', async () => {
    const a = await client()
    const b = await client()
    a.s.write(encode({ t: 'subscribe', id: 1 }))
    await a.next()
    server.broadcast([session()])
    const msg = await a.next() as { t: string; sessions: SessionState[] }
    expect(msg.t).toBe('state')
    expect(msg.sessions).toHaveLength(1)
    b.s.write(encode({ t: 'ping', id: 2 }))
    expect(await b.next()).toMatchObject({ t: 'ok', id: 2 })
    a.s.end(); b.s.end()
  })

  it('survives a client disconnecting mid-broadcast', async () => {
    const a = await client()
    a.s.write(encode({ t: 'subscribe', id: 1 }))
    await a.next()
    a.s.destroy()
    await new Promise(r => setTimeout(r, 50))
    expect(() => server.broadcast([session()])).not.toThrow()
  })

  it('survives a garbage line without dropping the connection', async () => {
    const { s, next } = await client()
    s.write('garbage\n')
    s.write(encode({ t: 'ping', id: 5 }))
    expect(await next()).toMatchObject({ t: 'ok', id: 5 })
    s.end()
  })

  // Finding C1: a malformed `event` message (missing `ts`, missing
  // `sessionId`, a wrong type, or not an object at all) used to flow
  // straight into `this.h.onEvent(m.event)` with no validation. In the real
  // engine that reaches `Db.recordEvent`'s SQLite bind unguarded and throws
  // `TypeError: Provided value cannot be bound to SQLite parameter 1` —
  // uncaught, that took the whole daemon down (exit 1), silencing every
  // other session's ladder along with it. These tests exercise the same
  // path C1 actually broke: a real socket, a message from `onEvent`'s
  // caller (#handle) rather than a hand-crafted Transition or NudgeEvent
  // passed directly to a component that already trusts its shape.
  describe('malformed events (C1)', () => {
    const send = (s: Socket, raw: unknown) => s.write(encode(raw))

    it('does not crash the process, and stays responsive to a later valid event, on an event missing ts', async () => {
      const { s, next } = await client()
      send(s, { t: 'event', event: { source: 'claude-code', sessionId: 's1', hook: 'Notification', cwd: '/a/my-repo', project: 'my-repo' } })
      await new Promise(r => setTimeout(r, 50))
      expect(received).toHaveLength(0) // the malformed event never reached the handler

      s.write(encode({ t: 'ping', id: 1 }))
      expect(await next()).toMatchObject({ t: 'ok', id: 1 })

      const ev: NudgeEvent = {
        source: 'claude-code', sessionId: 's2', hook: 'Notification',
        cwd: '/a/my-repo', project: 'my-repo', ts: 1, message: 'Allow?',
      }
      s.write(encode({ t: 'event', event: ev }))
      await vi.waitFor(() => expect(received).toHaveLength(1))
      expect(received[0].sessionId).toBe('s2')
      s.end()
    })

    it('drops an event with a missing sessionId without crashing', async () => {
      const { s, next } = await client()
      send(s, { t: 'event', event: { source: 'claude-code', hook: 'Notification', cwd: '/a/my-repo', project: 'my-repo', ts: 1 } })
      s.write(encode({ t: 'ping', id: 2 }))
      expect(await next()).toMatchObject({ t: 'ok', id: 2 })
      expect(received).toHaveLength(0)
      s.end()
    })

    it('drops an event whose hook is not one Nudge subscribes to', async () => {
      const { s, next } = await client()
      send(s, { t: 'event', event: { source: 'claude-code', sessionId: 's1', hook: 'SubagentStop', cwd: '/a/my-repo', project: 'my-repo', ts: 1 } })
      s.write(encode({ t: 'ping', id: 3 }))
      expect(await next()).toMatchObject({ t: 'ok', id: 3 })
      expect(received).toHaveLength(0)
      s.end()
    })

    it('drops a non-object event payload (null, a string, a number, an array)', async () => {
      const { s, next } = await client()
      for (const bad of [null, 'nope', 42, []]) {
        send(s, { t: 'event', event: bad })
      }
      s.write(encode({ t: 'ping', id: 4 }))
      expect(await next()).toMatchObject({ t: 'ok', id: 4 })
      expect(received).toHaveLength(0)
      s.end()
    })

    it('survives a handler that throws synchronously and stays responsive', async () => {
      const throwingServer = new EngineServer({
        onEvent: () => { throw new Error('boom') },
        onList: () => [session()],
        onSnooze: vi.fn(), onMute: vi.fn(), onResolve: vi.fn(), onIdle: vi.fn(), onFrontmost: vi.fn(),
      })
      const throwingSock = join(dir, 'throwing.sock')
      await throwingServer.listen(throwingSock)
      try {
        const s = connect(throwingSock)
        await new Promise<void>(r => s.on('connect', r))
        s.setEncoding('utf8')
        const dec = new NdjsonDecoder()
        const replyPromise = new Promise(resolve => {
          s.on('data', chunk => { for (const m of dec.push(chunk as unknown as string)) resolve(m) }
          )
        })
        const ev: NudgeEvent = {
          source: 'claude-code', sessionId: 's1', hook: 'Notification',
          cwd: '/a/my-repo', project: 'my-repo', ts: 1,
        }
        s.write(encode({ t: 'event', event: ev }))
        s.write(encode({ t: 'ping', id: 1 }))
        expect(await replyPromise).toMatchObject({ t: 'ok', id: 1 })
        s.end()
      } finally {
        await throwingServer.close()
      }
    })
  })

  it.skipIf(process.platform === 'win32')('creates the socket with 0600 permissions', () => {
    expect(statSync(sock).mode & 0o777).toBe(0o600)
  })

  it('replaces a stale socket file left by a crashed engine', async () => {
    await server.close()
    // A graceful close() already unlinks the socket file itself, so that
    // alone doesn't reproduce what a crash leaves behind. Recreate the
    // leftover inode a killed process actually leaves: a stale, orphaned
    // file sitting at the socket path with nothing listening on it.
    writeFileSync(sock, '')
    const again = new EngineServer({
      onEvent: () => {}, onList: () => [], onSnooze: vi.fn(), onMute: vi.fn(),
      onResolve: vi.fn(), onIdle: vi.fn(), onFrontmost: vi.fn(),
    })
    await expect(again.listen(sock)).resolves.toBeUndefined()
    // Prove the new server is actually live at this path, not merely that
    // listen() happened to resolve.
    const { s, next } = await client()
    s.write(encode({ t: 'ping', id: 1 }))
    expect(await next()).toMatchObject({ t: 'ok', id: 1 })
    s.end()
    await again.close()
  })

  it('close() does not hang on a connection that subscribed to nothing and never disconnects', async () => {
    const { s } = await client()
    // A server-initiated teardown of this socket may surface as ECONNRESET
    // on the client side; that's expected here, not a test failure.
    s.on('error', () => { /* expected: server closes this out from under us */ })
    // Deliberately send nothing further and never end()/destroy() from the
    // client side — this reproduces a lingering client (e.g. a Phase 2 GUI
    // that connected and sent `list` but never disappeared) that must not
    // make shutdown hang.
    await expect(server.close()).resolves.toBeUndefined()
    s.destroy()
  }, 3000)
})
