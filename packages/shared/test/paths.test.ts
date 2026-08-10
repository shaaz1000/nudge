import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { nudgeHome, socketPath, configPath, spoolDir, dbPath } from '../src/paths.js'

describe('paths', () => {
  const original = process.env.NUDGE_HOME
  beforeEach(() => { process.env.NUDGE_HOME = '/tmp/nudge-test-home' })
  afterEach(() => {
    if (original === undefined) delete process.env.NUDGE_HOME
    else process.env.NUDGE_HOME = original
  })

  it('honours NUDGE_HOME for every derived path', () => {
    expect(nudgeHome()).toBe('/tmp/nudge-test-home')
    expect(configPath()).toBe(join('/tmp/nudge-test-home', 'config.json'))
    expect(spoolDir()).toBe(join('/tmp/nudge-test-home', 'spool'))
    expect(dbPath()).toBe(join('/tmp/nudge-test-home', 'nudge.db'))
  })

  it('produces a platform-appropriate socket path', () => {
    const p = socketPath()
    if (process.platform === 'win32') expect(p).toMatch(/^\\\\[.]\\pipe\\nudge-/)
    else expect(p).toBe(join('/tmp/nudge-test-home', 'engine.sock'))
  })
})
