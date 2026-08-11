import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { builtinChannels, loadChannels } from '../src/registry.js'

describe('registry', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nudge-ch-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('includes ntfy as a built-in', async () => {
    expect(builtinChannels().map(c => c.id)).toContain('ntfy')
  })

  it('returns built-ins when the user channel directory is absent', async () => {
    const m = await loadChannels(join(dir, 'does-not-exist'))
    expect(m.has('ntfy')).toBe(true)
  })

  it('loads a user channel from disk', async () => {
    writeFileSync(join(dir, 'mine.js'),
      `export default { id: 'mine', configSchema: {}, async send() {} }\n`)
    const m = await loadChannels(dir)
    expect(m.has('mine')).toBe(true)
  })

  it('lets a user channel override a built-in of the same id', async () => {
    writeFileSync(join(dir, 'ntfy.js'),
      `export default { id: 'ntfy', configSchema: {}, async send() {} }\n`)
    const m = await loadChannels(dir)
    expect(m.get('ntfy')!.configSchema).toEqual({})
  })

  it('skips a malformed channel file without throwing', async () => {
    writeFileSync(join(dir, 'broken.js'), `this is not javascript {{{\n`)
    writeFileSync(join(dir, 'good.js'),
      `export default { id: 'good', configSchema: {}, async send() {} }\n`)
    const m = await loadChannels(dir)
    expect(m.has('good')).toBe(true)
    expect(m.has('broken')).toBe(false)
  })

  it('skips a file whose default export is not a Channel', async () => {
    writeFileSync(join(dir, 'nope.js'), `export default { notAChannel: true }\n`)
    const m = await loadChannels(dir)
    expect(m.has('nope')).toBe(false)
  })
})
