import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from '../src/commands.js'
import { encode, NdjsonDecoder } from '@nudge/shared/protocol'

let dir: string
let sock: string
let server: Server | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nudge-cmd-'))
  sock = join(dir, 'e.sock')
})
afterEach(async () => {
  if (server) await new Promise<void>(r => server!.close(() => r()))
  server = null
  rmSync(dir, { recursive: true, force: true })
})

describe('request', () => {
  it('returns the engine reply', async () => {
    server = createServer(s => {
      const d = new NdjsonDecoder()
      s.setEncoding('utf8')
      s.on('data', chunk => {
        for (const m of d.push(chunk as unknown as string)) {
          s.write(encode({ t: 'ok', id: (m as { id: number }).id, data: ['x'] }))
        }
      })
    })
    await new Promise<void>(r => server!.listen(sock, () => r()))
    const reply = await request({ t: 'list', id: 1 }, sock)
    expect(reply).toMatchObject({ t: 'ok', data: ['x'] })
  })

  it('rejects with a clear message when the engine is not running', async () => {
    await expect(request({ t: 'ping', id: 1 }, join(dir, 'absent.sock')))
      .rejects.toThrow(/not running/i)
  })

  it('rejects rather than hanging when the engine never replies', async () => {
    // .resume() drains the incoming bytes so the accepted socket can observe
    // EOF and reach 'close' once the client is destroyed below — otherwise
    // the unconsumed data sits buffered forever and afterEach's
    // server.close() hangs, independent of anything request() does.
    server = createServer(s => { s.resume() /* accept and stay silent */ })
    await new Promise<void>(r => server!.listen(sock, () => r()))
    await expect(request({ t: 'ping', id: 1 }, sock, 300)).rejects.toThrow(/timed out/i)
  })
})
