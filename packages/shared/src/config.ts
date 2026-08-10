import { readFileSync } from 'node:fs'
import type { Tier } from './types.js'
import { configPath } from './paths.js'

export interface TierConfig {
  enabled: boolean
  sound: string | null
  escalates: boolean
  escalateDelayMs?: number
}

export interface NudgeConfig {
  detailLevel: 'minimal' | 'full'
  muted: boolean
  escalation: {
    activeDelayMs: number
    idleDelayMs: number
    idleThresholdMs: number
    /** A turn at or above this duration is idle-long rather than idle-short. */
    longTurnMs: number
    localRepeat: number
    localRepeatIntervalMs: number
    phoneRepeat: number
    phoneRepeatIntervalMs: number
  }
  quietHours: { start: string; end: string } | null
  watchdog: { stallAfterMs: number; sessionTtlMs: number; tickMs: number }
  tiers: Record<Tier, TierConfig>
  channel: { id: string; options: Record<string, unknown> } | null
  retentionDays: number
  projects: Record<string, { muted?: boolean }>
}

export const DEFAULT_CONFIG: NudgeConfig = {
  detailLevel: 'minimal',
  muted: false,
  escalation: {
    activeDelayMs: 180_000,
    idleDelayMs: 45_000,
    idleThresholdMs: 60_000,
    longTurnMs: 180_000,
    localRepeat: 3,
    localRepeatIntervalMs: 60_000,
    phoneRepeat: 0,
    phoneRepeatIntervalMs: 300_000,
  },
  quietHours: null,
  watchdog: { stallAfterMs: 900_000, sessionTtlMs: 86_400_000, tickMs: 30_000 },
  tiers: {
    'blocked':    { enabled: true, sound: 'blocked',   escalates: true },
    'idle-long':  { enabled: true, sound: 'done',      escalates: true },
    'idle-short': { enabled: true, sound: null,        escalates: false },
    'stalled':    { enabled: true, sound: 'stalled',   escalates: false },
  },
  channel: null,
  retentionDays: 30,
  projects: {},
}

const TIERS: Tier[] = ['blocked', 'idle-long', 'idle-short', 'stalled']

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function requireNonNegative(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new Error(`config: ${name} must be a non-negative number, got ${JSON.stringify(v)}`)
  }
  return v
}

export function mergeConfig(partial: unknown): NudgeConfig {
  if (partial === undefined || partial === null) return structuredClone(DEFAULT_CONFIG)
  if (!isObj(partial)) throw new Error('config: top level must be an object')

  const cfg = structuredClone(DEFAULT_CONFIG)

  if ('detailLevel' in partial) {
    const d = partial.detailLevel
    if (d !== 'minimal' && d !== 'full') {
      throw new Error(`config: detailLevel must be "minimal" or "full", got ${JSON.stringify(d)}`)
    }
    cfg.detailLevel = d
  }

  if ('muted' in partial) {
    if (typeof partial.muted !== 'boolean') throw new Error('config: muted must be a boolean')
    cfg.muted = partial.muted
  }

  if (isObj(partial.escalation)) {
    for (const [k, v] of Object.entries(partial.escalation)) {
      if (!(k in cfg.escalation)) throw new Error(`config: unknown escalation key "${k}"`)
      ;(cfg.escalation as Record<string, number>)[k] = requireNonNegative(v, `escalation.${k}`)
    }
  }

  if (isObj(partial.watchdog)) {
    for (const [k, v] of Object.entries(partial.watchdog)) {
      if (!(k in cfg.watchdog)) throw new Error(`config: unknown watchdog key "${k}"`)
      ;(cfg.watchdog as Record<string, number>)[k] = requireNonNegative(v, `watchdog.${k}`)
    }
  }

  if (partial.quietHours === null) cfg.quietHours = null
  else if (isObj(partial.quietHours)) {
    const { start, end } = partial.quietHours
    const re = /^([01]\d|2[0-3]):[0-5]\d$/
    if (typeof start !== 'string' || !re.test(start)) throw new Error('config: quietHours.start must be "HH:MM"')
    if (typeof end !== 'string' || !re.test(end)) throw new Error('config: quietHours.end must be "HH:MM"')
    cfg.quietHours = { start, end }
  }

  if (isObj(partial.tiers)) {
    for (const [name, raw] of Object.entries(partial.tiers)) {
      if (!TIERS.includes(name as Tier)) throw new Error(`config: unknown tier "${name}"`)
      if (!isObj(raw)) throw new Error(`config: tiers.${name} must be an object`)
      const t = cfg.tiers[name as Tier]
      if ('enabled' in raw) {
        if (typeof raw.enabled !== 'boolean') throw new Error(`config: tiers.${name}.enabled must be a boolean`)
        t.enabled = raw.enabled
      }
      if ('escalates' in raw) {
        if (typeof raw.escalates !== 'boolean') throw new Error(`config: tiers.${name}.escalates must be a boolean`)
        t.escalates = raw.escalates
      }
      if ('sound' in raw) {
        if (raw.sound !== null && typeof raw.sound !== 'string') {
          throw new Error(`config: tiers.${name}.sound must be a string or null`)
        }
        t.sound = raw.sound as string | null
      }
      if ('escalateDelayMs' in raw) {
        t.escalateDelayMs = requireNonNegative(raw.escalateDelayMs, `tiers.${name}.escalateDelayMs`)
      }
    }
  }

  if (partial.channel === null) cfg.channel = null
  else if (isObj(partial.channel)) {
    if (typeof partial.channel.id !== 'string' || partial.channel.id.length === 0) {
      throw new Error('config: channel.id must be a non-empty string')
    }
    cfg.channel = {
      id: partial.channel.id,
      options: isObj(partial.channel.options) ? partial.channel.options : {},
    }
  }

  if ('retentionDays' in partial) {
    cfg.retentionDays = requireNonNegative(partial.retentionDays, 'retentionDays')
  }

  if (isObj(partial.projects)) {
    for (const [k, v] of Object.entries(partial.projects)) {
      if (!isObj(v)) throw new Error(`config: projects["${k}"] must be an object`)
      cfg.projects[k] = { muted: v.muted === true }
    }
  }

  return cfg
}

export function loadConfig(path = configPath()): NudgeConfig {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(DEFAULT_CONFIG)
    throw err
  }
  return mergeConfig(JSON.parse(raw))
}

/**
 * Resolve the escalation delay for a tier.
 * Precedence: per-tier override -> idle-adaptive base.
 * Returns null when the tier must never reach a channel.
 */
export function escalateDelayFor(cfg: NudgeConfig, tier: Tier, idleMs: number): number | null {
  const t = cfg.tiers[tier]
  if (!t.enabled || !t.escalates) return null
  if (t.escalateDelayMs !== undefined) return t.escalateDelayMs
  return idleMs >= cfg.escalation.idleThresholdMs
    ? cfg.escalation.idleDelayMs
    : cfg.escalation.activeDelayMs
}
