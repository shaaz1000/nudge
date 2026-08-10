import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeHooks, removeHooks, backupSettings, applySetup, NUDGE_MARK } from '../src/settings.js'

const CMD = 'node /opt/nudge/packages/nudge-hook/dist/bin.js'
let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nudge-set-'))
  file = join(dir, 'settings.json')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('mergeHooks preserves everything it did not add', () => {
  it('keeps a large permissions block byte-for-byte', () => {
    const existing = {
      permissions: { allow: ['Bash(ls:*)', 'Read(/x/**)'], additionalDirectories: ['/tmp'] },
      model: 'opus[1m]',
      enabledPlugins: { 'superpowers@official': true },
    }
    const { merged } = mergeHooks(existing, CMD)
    expect(merged.permissions).toEqual(existing.permissions)
    expect(merged.model).toBe('opus[1m]')
    expect(merged.enabledPlugins).toEqual(existing.enabledPlugins)
  })

  it('adds all seven hooks to a file that has none', () => {
    const { merged, added } = mergeHooks({ model: 'opus' }, CMD)
    expect(added).toBe(7)
    const hooks = merged.hooks as Record<string, unknown[]>
    expect(Object.keys(hooks).sort()).toEqual([
      'Notification', 'PostToolUse', 'PreToolUse', 'SessionEnd',
      'SessionStart', 'Stop', 'UserPromptSubmit',
    ])
  })

  it('appends to an existing hooks array without disturbing the user entry', () => {
    const existing = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'my-own-script.sh' }] }] },
    }
    const { merged } = mergeHooks(existing, CMD)
    const stop = (merged.hooks as Record<string, unknown[]>).Stop
    expect(stop).toHaveLength(2)
    expect(JSON.stringify(stop[0])).toContain('my-own-script.sh')
    expect(JSON.stringify(stop[1])).toContain(NUDGE_MARK)
  })

  it('is idempotent — running setup twice adds nothing the second time', () => {
    const once = mergeHooks({}, CMD)
    const twice = mergeHooks(once.merged, CMD)
    expect(twice.added).toBe(0)
    expect(JSON.stringify(twice.merged)).toBe(JSON.stringify(once.merged))
  })

  it('updates the command in place when the install path changed', () => {
    const once = mergeHooks({}, CMD)
    const moved = mergeHooks(once.merged, '/new/path/nudge-hook/dist/bin.js')
    const stop = (moved.merged.hooks as Record<string, unknown[]>).Stop
    expect(stop).toHaveLength(1)
    expect(JSON.stringify(stop)).toContain('/new/path')
  })

  it('rejects a settings file that is not an object', () => {
    expect(() => mergeHooks([1, 2, 3], CMD)).toThrow(/object/)
  })
})

describe('removeHooks takes back exactly what it added', () => {
  it('restores the file to its pre-setup state', () => {
    const original = {
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'my-own-script.sh' }] }] },
    }
    const { merged } = mergeHooks(original, CMD)
    const { merged: back, removed } = removeHooks(merged)
    expect(removed).toBe(7)
    expect(JSON.stringify(back)).toBe(JSON.stringify(original))
  })

  it('drops the hooks key entirely when nothing else lived there', () => {
    const { merged } = mergeHooks({ model: 'opus' }, CMD)
    const { merged: back } = removeHooks(merged)
    expect(back).toEqual({ model: 'opus' })
  })

  it('removes nothing from a file Nudge never touched', () => {
    const other = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other.sh' }] }] } }
    const { merged, removed } = removeHooks(other)
    expect(removed).toBe(0)
    expect(merged).toEqual(other)
  })
})

describe('backupSettings', () => {
  it('writes a timestamped copy alongside the original', () => {
    writeFileSync(file, '{"model":"opus"}')
    const backup = backupSettings(file)
    expect(backup).toBeTruthy()
    expect(readFileSync(backup!, 'utf8')).toBe('{"model":"opus"}')
    expect(readdirSync(dir).some(f => f.startsWith('settings.json.nudge-backup'))).toBe(true)
  })

  it('returns null when there is nothing to back up', () => {
    expect(backupSettings(join(dir, 'absent.json'))).toBeNull()
  })
})

describe('applySetup', () => {
  it('dry-run reports the diff and writes nothing', () => {
    writeFileSync(file, '{"model":"opus"}')
    const r = applySetup({ command: CMD, dryRun: true, path: file })
    expect(r.added).toBe(7)
    expect(r.backup).toBeNull()
    expect(r.diff).toContain('Notification')
    expect(readFileSync(file, 'utf8')).toBe('{"model":"opus"}')
  })

  it('a real run backs up, writes valid JSON, and preserves other keys', () => {
    writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }, null, 2))
    const r = applySetup({ command: CMD, dryRun: false, path: file })
    expect(r.backup).toBeTruthy()
    const after = JSON.parse(readFileSync(file, 'utf8'))
    expect(after.permissions.allow).toEqual(['Bash(ls:*)'])
    expect(Object.keys(after.hooks)).toHaveLength(7)
  })

  it('refuses to write when the existing file is not valid JSON', () => {
    writeFileSync(file, '{ this is broken')
    expect(() => applySetup({ command: CMD, dryRun: false, path: file })).toThrow(/parse/i)
    expect(readFileSync(file, 'utf8')).toBe('{ this is broken')
  })

  it('creates the file when absent', () => {
    const r = applySetup({ command: CMD, dryRun: false, path: file })
    expect(r.added).toBe(7)
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).hooks)).toHaveLength(7)
  })
})
