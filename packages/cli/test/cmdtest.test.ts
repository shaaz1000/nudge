import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cmdTest } from '../src/commands.js'

// cmdTest must fail clearly (a thrown Error with a message a script or a
// human can read) in each of the three ways a phone-test can be misconfigured:
// no channel configured, an unknown channel id, and a channel that exists
// but does not implement verify(). bin.ts's outer catch turns any of these
// into `console.error` + a non-zero exit, never a raw stack trace.

let dir: string
let originalHome: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nudge-cmdtest-'))
  originalHome = process.env.NUDGE_HOME
  process.env.NUDGE_HOME = dir
})
afterEach(() => {
  if (originalHome === undefined) delete process.env.NUDGE_HOME
  else process.env.NUDGE_HOME = originalHome
  rmSync(dir, { recursive: true, force: true })
})

describe('cmdTest failure modes', () => {
  it('throws a clear error when no channel is configured anywhere', async () => {
    // No ~/.nudge/config.json at all -> DEFAULT_CONFIG.channel is null, and no
    // channelId argument was passed either.
    await expect(cmdTest()).rejects.toThrow(/no channel configured/i)
  })

  it('throws a clear error for an unknown channel id', async () => {
    await expect(cmdTest('does-not-exist')).rejects.toThrow(/unknown channel/i)
  })

  it('throws a clear error when the channel has no verify()', async () => {
    const channelsDir = join(dir, 'channels')
    mkdirSync(channelsDir, { recursive: true })
    writeFileSync(
      join(channelsDir, 'noverify.mjs'),
      `export default { id: 'noverify', configSchema: {}, async send() {} }\n`,
      'utf8',
    )
    await expect(cmdTest('noverify')).rejects.toThrow(/does not support testing/i)
  })
})
