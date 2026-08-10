import { describe, it, expect } from 'vitest'
import { DEFAULT_CONFIG, mergeConfig, escalateDelayFor } from '../src/config.js'

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
