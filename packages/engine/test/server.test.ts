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

function client(path: string = sock): Promise<{ s: Socket; next: () => Promise<unknown> }> {
  return new Promise(resolve => {
    const s = connect(path, () => {
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

  it('carries frontmost on the state frame, so clients can apply the same suppression the engine does', async () => {
    // The engine has always tracked frontmost for its OWN alerts but never
    // told anyone, so no client could honour it: the tray's Dock bounced at
    // the user while they were looking at the very window that was waiting.
    const a = await client()
    a.s.write(encode({ t: 'subscribe', id: 1 }))
    await a.next()
    server.broadcast([session()], 'sess-42')
    expect(await a.next()).toMatchObject({ t: 'state', frontmost: 'sess-42' })
    a.s.end()
  })

  it('sends frontmost: null when nothing is focused, rather than omitting the key', async () => {
    const a = await client()
    a.s.write(encode({ t: 'subscribe', id: 1 }))
    await a.next()
    server.broadcast([session()], null)
    const msg = await a.next() as { t: string; frontmost: string | null }
    expect(msg.frontmost).toBeNull()
    a.s.end()
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

  // --- Review round 1, Finding 5 (USER-APPROVED) ---
  // `gui: true` on `subscribe` is how a client (currently only the Electron
  // tray) declares itself a GUI so Engine#onLocal can skip its own desktop
  // notification and trust the tray's clickable one instead. `hasGuiClient()`
  // is what onLocal reads; `onGuiDisconnected` is what fires the instant that
  // goes from true to false, so the engine's own notifications resume
  // immediately rather than waiting for the next scheduled escalation
  // repeat — see engine.ts's onLocal/onGuiDisconnected docs for the full
  // design.
  describe('GUI client tracking (Finding 5)', () => {
    it('hasGuiClient() is false with no subscribers at all', () => {
      expect(server.hasGuiClient()).toBe(false)
    })

    it('a plain subscribe (no `gui`) does not count as a GUI client', async () => {
      const { s, next } = await client()
      s.write(encode({ t: 'subscribe', id: 1 }))
      await next()
      expect(server.hasGuiClient()).toBe(false)
      s.end()
    })

    it('subscribe({ gui: true }) makes hasGuiClient() true', async () => {
      const { s, next } = await client()
      s.write(encode({ t: 'subscribe', id: 1, gui: true }))
      await next()
      expect(server.hasGuiClient()).toBe(true)
      s.end()
    })

    it('two GUI subscribers: disconnecting one still leaves hasGuiClient() true', async () => {
      const a = await client()
      const b = await client()
      a.s.write(encode({ t: 'subscribe', id: 1, gui: true }))
      await a.next()
      b.s.write(encode({ t: 'subscribe', id: 2, gui: true }))
      await b.next()
      expect(server.hasGuiClient()).toBe(true)

      a.s.destroy()
      // Round 2, Finding 2: NOT vi.waitFor — its callback runs synchronously
      // once, before any timer is scheduled, i.e. before the server has even
      // processed `a`'s 'close' event. The assertion would then be true at
      // that instant no matter what #attach's onGone does (including a
      // broken implementation that clears the ENTIRE #guiSubscribers set on
      // any disconnect), so it proves nothing. A real wait for the event
      // loop to actually run the close handler (same pattern as :321-343
      // below) is required to exercise the real behaviour.
      await new Promise(r => setTimeout(r, 50))
      expect(server.hasGuiClient()).toBe(true) // b is still connected
      b.s.end()
    })

    function guiServer() {
      const onGuiDisconnected = vi.fn()
      const s = new EngineServer({
        onEvent: () => {}, onList: () => [], onSnooze: vi.fn(), onMute: vi.fn(),
        onResolve: vi.fn(), onIdle: vi.fn(), onFrontmost: vi.fn(), onGuiDisconnected,
      })
      return { s, onGuiDisconnected }
    }

    it('fires onGuiDisconnected the instant the LAST GUI subscriber disconnects', async () => {
      const { s: guiSock, onGuiDisconnected } = guiServer()
      const p = join(dir, 'gui1.sock')
      await guiSock.listen(p)
      try {
        const a = await client(p)
        a.s.write(encode({ t: 'subscribe', id: 1, gui: true }))
        await a.next()
        expect(guiSock.hasGuiClient()).toBe(true)

        a.s.destroy()
        await vi.waitFor(() => expect(onGuiDisconnected).toHaveBeenCalledTimes(1))
        expect(guiSock.hasGuiClient()).toBe(false)
      } finally {
        await guiSock.close()
      }
    })

    it('does NOT fire onGuiDisconnected while at least one other GUI subscriber remains', async () => {
      const { s: guiSock, onGuiDisconnected } = guiServer()
      const p = join(dir, 'gui2.sock')
      await guiSock.listen(p)
      try {
        const a = await client(p)
        const b = await client(p)
        a.s.write(encode({ t: 'subscribe', id: 1, gui: true }))
        await a.next()
        b.s.write(encode({ t: 'subscribe', id: 2, gui: true }))
        await b.next()

        a.s.destroy()
        await new Promise(r => setTimeout(r, 50))
        expect(onGuiDisconnected).not.toHaveBeenCalled()
        expect(guiSock.hasGuiClient()).toBe(true) // b is still connected

        b.s.destroy()
        await vi.waitFor(() => expect(onGuiDisconnected).toHaveBeenCalledTimes(1))
      } finally {
        await guiSock.close()
      }
    })

    it('does NOT fire onGuiDisconnected when a non-GUI subscriber disconnects', async () => {
      const { s: guiSock, onGuiDisconnected } = guiServer()
      const p = join(dir, 'gui3.sock')
      await guiSock.listen(p)
      try {
        const a = await client(p)
        a.s.write(encode({ t: 'subscribe', id: 1 })) // no `gui`
        await a.next()

        a.s.destroy()
        await new Promise(r => setTimeout(r, 50))
        expect(onGuiDisconnected).not.toHaveBeenCalled()
      } finally {
        await guiSock.close()
      }
    })

    it('fires onGuiDisconnected only once for a socket that both errors and closes', async () => {
      const { s: guiSock, onGuiDisconnected } = guiServer()
      const p = join(dir, 'gui4.sock')
      await guiSock.listen(p)
      try {
        const a = await client(p)
        a.s.on('error', () => { /* expected: forcing a reset below */ })
        a.s.write(encode({ t: 'subscribe', id: 1, gui: true }))
        await a.next()

        // resetAndDestroy() surfaces as an 'error' on the client side, and
        // Node always emits 'close' after 'error' — exactly the double-event
        // sequence #attach's `onGone` has to collapse into one call.
        a.s.destroy(new Error('forced reset'))
        await vi.waitFor(() => expect(onGuiDisconnected).toHaveBeenCalledTimes(1))
        await new Promise(r => setTimeout(r, 50))
        expect(onGuiDisconnected).toHaveBeenCalledTimes(1) // still just once
      } finally {
        await guiSock.close()
      }
    })

    it('a graceful close() never fires onGuiDisconnected — nothing useful to fall back to while the engine itself is shutting down', async () => {
      const { s: guiSock, onGuiDisconnected } = guiServer()
      const p = join(dir, 'gui5.sock')
      await guiSock.listen(p)
      const a = await client(p)
      a.s.on('error', () => { /* expected: server-initiated teardown */ })
      a.s.write(encode({ t: 'subscribe', id: 1, gui: true }))
      await a.next()

      await guiSock.close()
      await new Promise(r => setTimeout(r, 50))
      expect(onGuiDisconnected).not.toHaveBeenCalled()
    })

    it('missing onGuiDisconnected (an older/partial ServerHandlers) never throws when the last GUI disconnects', async () => {
      // Round 2, Finding 2: the old version of this test had zero `expect()`
      // calls, and its inline claim that an unguarded call "would throw
      // synchronously" was false regardless — `#attach`'s onGone (server.ts)
      // already wraps `this.h.onGuiDisconnected?.()` in a try/catch, so even
      // removing the `?.` would not make anything escape past this test.
      // What DOES change if the `?.` is removed: calling `undefined()`
      // throws a TypeError inside that try, which is caught and logged via
      // `console.error('nudge server: onGuiDisconnected handler failed', ...)`.
      // Spying on console.error gives a real, mechanical way to tell the two
      // implementations apart even though neither one crashes the process.
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const noHandler = new EngineServer({
        onEvent: () => {}, onList: () => [], onSnooze: vi.fn(), onMute: vi.fn(),
        onResolve: vi.fn(), onIdle: vi.fn(), onFrontmost: vi.fn(),
        // onGuiDisconnected deliberately omitted.
      })
      const p = join(dir, 'gui6.sock')
      await noHandler.listen(p)
      try {
        const a = await client(p)
        a.s.write(encode({ t: 'subscribe', id: 1, gui: true }))
        await a.next()
        a.s.destroy()
        await new Promise(r => setTimeout(r, 50))
        expect(errSpy).not.toHaveBeenCalled() // the `?.` swallowed the missing handler with nothing logged
      } finally {
        await noHandler.close()
        errSpy.mockRestore()
      }
    })
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
