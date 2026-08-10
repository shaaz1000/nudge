import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { connect, type Socket } from 'node:net'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
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

  it.skipIf(process.platform === 'win32')('creates the socket with 0600 permissions', () => {
    expect(statSync(sock).mode & 0o777).toBe(0o600)
  })

  it('replaces a stale socket file left by a crashed engine', async () => {
    await server.close()
    const again = new EngineServer({
      onEvent: () => {}, onList: () => [], onSnooze: vi.fn(), onMute: vi.fn(),
      onResolve: vi.fn(), onIdle: vi.fn(), onFrontmost: vi.fn(),
    })
    await expect(again.listen(sock)).resolves.toBeUndefined()
    await again.close()
  })
})
