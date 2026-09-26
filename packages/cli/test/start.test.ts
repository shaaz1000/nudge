import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { socketAddress } from '@nudge/shared/paths'
import { createServer, type Server } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cmdStart } from '../src/commands.js'
import { encode, NdjsonDecoder } from '@nudge/shared/protocol'

// Single-instance guard: `nudge start` must not spawn a second engine when
// one is already listening on the socket. These tests exercise only the
// decision logic (does cmdStart call the injected spawn callback?) — no real
// daemon process is ever spawned here.

let dir: string
let sock: string
let server: Server | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nudge-start-'))
  sock = socketAddress(dir, 'e.sock')
})
afterEach(async () => {
  if (server) await new Promise<void>(r => server!.close(() => r()))
  server = null
  rmSync(dir, { recursive: true, force: true })
})

describe('cmdStart single-instance guard', () => {
  it('declines to spawn when a live engine already answers ping on the socket', async () => {
    server = createServer(s => {
      const d = new NdjsonDecoder()
      s.setEncoding('utf8')
      s.on('data', chunk => {
        for (const m of d.push(chunk as unknown as string)) {
          s.write(encode({ t: 'ok', id: (m as { id: number }).id }))
        }
      })
    })
    await new Promise<void>(r => server!.listen(sock, () => r()))

    const spawnEngine = vi.fn()
    await cmdStart(spawnEngine, sock)

    expect(spawnEngine).not.toHaveBeenCalled()
  })

  it('proceeds to spawn when nothing answers (no socket file / stale socket)', async () => {
    const spawnEngine = vi.fn()
    await cmdStart(spawnEngine, socketAddress(dir, 'absent.sock'))

    expect(spawnEngine).toHaveBeenCalledTimes(1)
  })

  it('proceeds to spawn when a peer accepts the connection but never replies (stale/hung listener)', async () => {
    // .resume() drains the incoming bytes so the accepted socket can reach
    // 'close' once the client is destroyed — otherwise the unconsumed data
    // sits buffered forever and afterEach's server.close() hangs.
    server = createServer(s => { s.resume() /* accept and stay silent, like a stuck process */ })
    await new Promise<void>(r => server!.listen(sock, () => r()))

    const spawnEngine = vi.fn()
    await cmdStart(spawnEngine, sock, 200)

    expect(spawnEngine).toHaveBeenCalledTimes(1)
  })
})
