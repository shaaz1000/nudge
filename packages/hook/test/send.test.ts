import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:net'
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendEvent } from '../src/send.js'
import { spoolEvent } from '../src/spool.js'

let dir: string
let server: Server | null = null

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nudge-hook-')) })
afterEach(async () => {
  if (server) await new Promise<void>(r => server!.close(() => r()))
  server = null
  rmSync(dir, { recursive: true, force: true })
})

describe('sendEvent', () => {
  it('delivers the payload to a listening engine', async () => {
    const sock = join(dir, 'e.sock')
    const got: string[] = []
    server = createServer(s => { s.setEncoding('utf8'); s.on('data', d => got.push(d as unknown as string)) })
    await new Promise<void>(r => server!.listen(sock, () => r()))

    const ok = await sendEvent('{"t":"event"}\n', 500, sock)
    expect(ok).toBe(true)
    await new Promise(r => setTimeout(r, 50))
    expect(got.join('')).toContain('"t":"event"')
  })

  it('returns false rather than throwing when nothing is listening', async () => {
    const ok = await sendEvent('{"t":"event"}\n', 300, join(dir, 'absent.sock'))
    expect(ok).toBe(false)
  })

  it('gives up within the deadline when the peer never accepts', async () => {
    const started = Date.now()
    await sendEvent('{}\n', 200, join(dir, 'absent.sock'))
    expect(Date.now() - started).toBeLessThan(1500)
  })
})

describe('spoolEvent', () => {
  it('writes the raw payload to a uniquely named file', () => {
    spoolEvent('{"a":1}', dir)
    spoolEvent('{"a":2}', dir)
    const files = readdirSync(dir)
    expect(files).toHaveLength(2)
    expect(readFileSync(join(dir, files[0]), 'utf8')).toMatch(/\{"a":[12]\}/)
  })

  it('does not throw when the directory cannot be created', () => {
    expect(() => spoolEvent('{}', '/proc/definitely/not/writable')).not.toThrow()
  })
})
