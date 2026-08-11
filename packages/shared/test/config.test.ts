import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG, mergeConfig, escalateDelayFor, loadConfig, setMuted } from '../src/config.js'

describe('config defaults', () => {
  it('matches the spec values', () => {
    expect(DEFAULT_CONFIG.detailLevel).toBe('minimal')
    expect(DEFAULT_CONFIG.escalation.activeDelayMs).toBe(180_000)
    expect(DEFAULT_CONFIG.escalation.idleDelayMs).toBe(45_000)
    expect(DEFAULT_CONFIG.escalation.idleThresholdMs).toBe(60_000)
    expect(DEFAULT_CONFIG.escalation.longTurnMs).toBe(180_000)
    expect(DEFAULT_CONFIG.escalation.localRepeat).toBe(3)
    expect(DEFAULT_CONFIG.escalation.phoneRepeat).toBe(0)
    expect(DEFAULT_CONFIG.watchdog.stallAfterMs).toBe(900_000)
    expect(DEFAULT_CONFIG.watchdog.sessionTtlMs).toBe(86_400_000)
    expect(DEFAULT_CONFIG.retentionDays).toBe(30)
  })

  it('makes idle-short silent and non-escalating', () => {
    expect(DEFAULT_CONFIG.tiers['idle-short'].sound).toBeNull()
    expect(DEFAULT_CONFIG.tiers['idle-short'].escalates).toBe(false)
  })

  it('escalates blocked and idle-long, and stalled only if configured', () => {
    expect(DEFAULT_CONFIG.tiers['blocked'].escalates).toBe(true)
    expect(DEFAULT_CONFIG.tiers['idle-long'].escalates).toBe(true)
    expect(DEFAULT_CONFIG.tiers['stalled'].escalates).toBe(false)
  })
})

describe('mergeConfig', () => {
  it('deep-merges partial user config over defaults', () => {
    const cfg = mergeConfig({ escalation: { activeDelayMs: 60_000 } })
    expect(cfg.escalation.activeDelayMs).toBe(60_000)
    expect(cfg.escalation.idleDelayMs).toBe(45_000)
  })

  it('rejects an unknown detailLevel', () => {
    expect(() => mergeConfig({ detailLevel: 'loud' })).toThrow(/detailLevel/)
  })

  it('rejects a negative delay', () => {
    expect(() => mergeConfig({ escalation: { activeDelayMs: -1 } })).toThrow(/activeDelayMs/)
  })

  describe('nested field validation (Finding 1)', () => {
    it('rejects escalation when present but not an object', () => {
      expect(() => mergeConfig({ escalation: 'fast' })).toThrow(/escalation must be an object/)
      expect(() => mergeConfig({ escalation: 123 })).toThrow(/escalation must be an object/)
      expect(() => mergeConfig({ escalation: ['fast'] })).toThrow(/escalation must be an object/)
    })

    it('allows absent escalation key to use defaults', () => {
      const cfg = mergeConfig({ muted: true })
      expect(cfg.escalation.activeDelayMs).toBe(180_000)
    })

    it('rejects watchdog when present but not an object', () => {
      expect(() => mergeConfig({ watchdog: 'fast' })).toThrow(/watchdog must be an object/)
      expect(() => mergeConfig({ watchdog: 123 })).toThrow(/watchdog must be an object/)
      expect(() => mergeConfig({ watchdog: [] })).toThrow(/watchdog must be an object/)
    })

    it('allows absent watchdog key to use defaults', () => {
      const cfg = mergeConfig({ muted: true })
      expect(cfg.watchdog.stallAfterMs).toBe(900_000)
    })

    it('rejects tiers when present but not an object', () => {
      expect(() => mergeConfig({ tiers: 'all' })).toThrow(/tiers must be an object/)
      expect(() => mergeConfig({ tiers: 123 })).toThrow(/tiers must be an object/)
      expect(() => mergeConfig({ tiers: ['blocked'] })).toThrow(/tiers must be an object/)
    })

    it('allows absent tiers key to use defaults', () => {
      const cfg = mergeConfig({ muted: true })
      expect(cfg.tiers.blocked.escalates).toBe(true)
    })

    it('rejects quietHours when present but not null or valid object', () => {
      expect(() => mergeConfig({ quietHours: 'always' })).toThrow(/quietHours/)
      expect(() => mergeConfig({ quietHours: 123 })).toThrow(/quietHours/)
      expect(() => mergeConfig({ quietHours: { start: 'invalid' } })).toThrow(/quietHours/)
      expect(() => mergeConfig({ quietHours: { start: '22:00', end: 'bad' } })).toThrow(/quietHours/)
    })

    it('allows absent quietHours key or null to use defaults', () => {
      const cfg1 = mergeConfig({ muted: true })
      expect(cfg1.quietHours).toBeNull()
      const cfg2 = mergeConfig({ quietHours: null })
      expect(cfg2.quietHours).toBeNull()
    })

    it('rejects channel when present but not null or valid object', () => {
      expect(() => mergeConfig({ channel: 'slack' })).toThrow(/channel/)
      expect(() => mergeConfig({ channel: 123 })).toThrow(/channel/)
      expect(() => mergeConfig({ channel: { id: '' } })).toThrow(/channel.id/)
    })

    it('allows absent channel key or null to use defaults', () => {
      const cfg1 = mergeConfig({ muted: true })
      expect(cfg1.channel).toBeNull()
      const cfg2 = mergeConfig({ channel: null })
      expect(cfg2.channel).toBeNull()
    })

    it('rejects projects when present but not an object', () => {
      expect(() => mergeConfig({ projects: 'all' })).toThrow(/projects must be an object/)
      expect(() => mergeConfig({ projects: 123 })).toThrow(/projects must be an object/)
      expect(() => mergeConfig({ projects: [] })).toThrow(/projects must be an object/)
    })

    it('allows absent projects key to use defaults', () => {
      const cfg = mergeConfig({ muted: true })
      expect(cfg.projects).toEqual({})
    })

    it('rejects projects[k].muted when present but not a boolean', () => {
      expect(() => mergeConfig({ projects: { myproj: { muted: 'yes' } } })).toThrow(/muted must be a boolean/)
      expect(() => mergeConfig({ projects: { myproj: { muted: 1 } } })).toThrow(/muted must be a boolean/)
      expect(() => mergeConfig({ projects: { myproj: { muted: null } } })).toThrow(/muted must be a boolean/)
    })

    it('allows absent projects[k].muted key to default to false', () => {
      const cfg = mergeConfig({ projects: { myproj: {} } })
      expect(cfg.projects.myproj.muted).toBe(false)
    })
  })
})

describe('escalateDelayFor', () => {
  it('uses the active delay when the machine is in use', () => {
    expect(escalateDelayFor(DEFAULT_CONFIG, 'blocked', 0)).toBe(180_000)
  })

  it('uses the idle delay once idle passes the threshold', () => {
    expect(escalateDelayFor(DEFAULT_CONFIG, 'blocked', 90_000)).toBe(45_000)
  })

  it('returns null for a tier that never escalates', () => {
    expect(escalateDelayFor(DEFAULT_CONFIG, 'idle-short', 90_000)).toBeNull()
  })

  it('lets a per-tier override beat the adaptive base', () => {
    const cfg = mergeConfig({ tiers: { blocked: { escalateDelayMs: 5_000 } } })
    expect(escalateDelayFor(cfg, 'blocked', 0)).toBe(5_000)
    expect(escalateDelayFor(cfg, 'blocked', 90_000)).toBe(5_000)
  })
})

describe('DEFAULT_CONFIG immutability (Finding 2)', () => {
  it('is deeply frozen to prevent accidental mutation', () => {
    // Attempting to mutate the root object should fail or be a no-op
    expect(() => {
      ;(DEFAULT_CONFIG as any).detailLevel = 'full'
    }).toThrow()

    // Attempting to mutate nested objects should fail or be a no-op
    expect(() => {
      DEFAULT_CONFIG.escalation.activeDelayMs = 999
    }).toThrow()

    expect(() => {
      DEFAULT_CONFIG.watchdog.stallAfterMs = 999
    }).toThrow()

    expect(() => {
      DEFAULT_CONFIG.tiers.blocked.escalates = false
    }).toThrow()

    expect(() => {
      ;(DEFAULT_CONFIG.projects as any).injected = { muted: true }
    }).toThrow()
  })

  it('structuredClone returns a mutable copy', () => {
    const cloned = structuredClone(DEFAULT_CONFIG)

    // Cloned config should be mutable
    expect(() => {
      cloned.detailLevel = 'full'
    }).not.toThrow()
    expect(cloned.detailLevel).toBe('full')

    expect(() => {
      cloned.escalation.activeDelayMs = 999
    }).not.toThrow()
    expect(cloned.escalation.activeDelayMs).toBe(999)

    expect(() => {
      cloned.tiers.blocked.escalates = false
    }).not.toThrow()
    expect(cloned.tiers.blocked.escalates).toBe(false)

    // Original should be unchanged
    expect(DEFAULT_CONFIG.detailLevel).toBe('minimal')
    expect(DEFAULT_CONFIG.escalation.activeDelayMs).toBe(180_000)
    expect(DEFAULT_CONFIG.tiers.blocked.escalates).toBe(true)
  })

  it('mergeConfig returns a mutable config', () => {
    const cfg = mergeConfig({})
    expect(() => {
      cfg.escalation.activeDelayMs = 123
    }).not.toThrow()
    expect(cfg.escalation.activeDelayMs).toBe(123)
  })
})

describe('loadConfig', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nudge-config-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('returns defaults when the file does not exist', () => {
    const cfg = loadConfig(join(dir, 'does-not-exist.json'))
    expect(cfg).toEqual(DEFAULT_CONFIG)
  })

  it('merges a valid on-disk config over the defaults', () => {
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify({ muted: true }), 'utf8')
    expect(loadConfig(path).muted).toBe(true)
  })

  /**
   * Also-fix from the review triage: loadConfig used to call
   * `JSON.parse(raw)` completely unwrapped. A typo'd config.json (a stray
   * comma, an unclosed brace — the kind of thing a human hand-editing the
   * file produces) threw a bare, unnamed `SyntaxError` that propagated
   * straight out of the engine's boot sequence with no indication of which
   * file was at fault. Wrapped so the error names the path.
   */
  it('throws a clear, file-naming error on malformed JSON instead of a bare SyntaxError', () => {
    const path = join(dir, 'config.json')
    writeFileSync(path, '{ "muted": true, }', 'utf8') // trailing comma: invalid JSON
    expect(() => loadConfig(path)).toThrow(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })

  it('still rejects a validly-parsed but schema-invalid config, unchanged', () => {
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify({ detailLevel: 'loud' }), 'utf8')
    expect(() => loadConfig(path)).toThrow(/detailLevel/)
  })
})

describe('setMuted (Finding I7)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nudge-config-mute-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('creates config.json with muted: true when no config file exists yet', () => {
    const path = join(dir, 'nested', 'config.json')
    setMuted(true, path)
    expect(loadConfig(path).muted).toBe(true)
  })

  it('persists so a later loadConfig (a fresh `nudge status` process) agrees', () => {
    const path = join(dir, 'config.json')
    setMuted(true, path)
    expect(loadConfig(path).muted).toBe(true)
    setMuted(false, path)
    expect(loadConfig(path).muted).toBe(false)
  })

  it('preserves the rest of an existing hand-edited config.json', () => {
    const path = join(dir, 'config.json')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, JSON.stringify({ detailLevel: 'full', retentionDays: 7 }), 'utf8')
    setMuted(true, path)
    const cfg = loadConfig(path)
    expect(cfg.muted).toBe(true)
    expect(cfg.detailLevel).toBe('full')
    expect(cfg.retentionDays).toBe(7)
  })
})
