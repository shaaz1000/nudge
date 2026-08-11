import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
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

export const DEFAULT_CONFIG: NudgeConfig = deepFreeze({
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
} as NudgeConfig)

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

function deepFreeze<T extends object>(obj: T): T {
  Object.freeze(obj)
  for (const value of Object.values(obj)) {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
      deepFreeze(value)
    }
  }
  return obj
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

  if ('escalation' in partial) {
    if (!isObj(partial.escalation)) {
      throw new Error(`config: escalation must be an object, got ${JSON.stringify(partial.escalation)}`)
    }
    for (const [k, v] of Object.entries(partial.escalation)) {
      if (!(k in cfg.escalation)) throw new Error(`config: unknown escalation key "${k}"`)
      ;(cfg.escalation as Record<string, number>)[k] = requireNonNegative(v, `escalation.${k}`)
    }
  }

  if ('watchdog' in partial) {
    if (!isObj(partial.watchdog)) {
      throw new Error(`config: watchdog must be an object, got ${JSON.stringify(partial.watchdog)}`)
    }
    for (const [k, v] of Object.entries(partial.watchdog)) {
      if (!(k in cfg.watchdog)) throw new Error(`config: unknown watchdog key "${k}"`)
      ;(cfg.watchdog as Record<string, number>)[k] = requireNonNegative(v, `watchdog.${k}`)
    }
  }

  if ('quietHours' in partial) {
    if (partial.quietHours === null) {
      cfg.quietHours = null
    } else if (isObj(partial.quietHours)) {
      const { start, end } = partial.quietHours
      const re = /^([01]\d|2[0-3]):[0-5]\d$/
      if (typeof start !== 'string' || !re.test(start)) throw new Error('config: quietHours.start must be "HH:MM"')
      if (typeof end !== 'string' || !re.test(end)) throw new Error('config: quietHours.end must be "HH:MM"')
      cfg.quietHours = { start, end }
    } else {
      throw new Error(`config: quietHours must be null or an object, got ${JSON.stringify(partial.quietHours)}`)
    }
  }

  if ('tiers' in partial) {
    if (!isObj(partial.tiers)) {
      throw new Error(`config: tiers must be an object, got ${JSON.stringify(partial.tiers)}`)
    }
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

  if ('channel' in partial) {
    if (partial.channel === null) {
      cfg.channel = null
    } else if (isObj(partial.channel)) {
      if (typeof partial.channel.id !== 'string' || partial.channel.id.length === 0) {
        throw new Error('config: channel.id must be a non-empty string')
      }
      cfg.channel = {
        id: partial.channel.id,
        options: isObj(partial.channel.options) ? partial.channel.options : {},
      }
    } else {
      throw new Error(`config: channel must be null or an object, got ${JSON.stringify(partial.channel)}`)
    }
  }

  if ('retentionDays' in partial) {
    cfg.retentionDays = requireNonNegative(partial.retentionDays, 'retentionDays')
  }

  if ('projects' in partial) {
    if (!isObj(partial.projects)) {
      throw new Error(`config: projects must be an object, got ${JSON.stringify(partial.projects)}`)
    }
    for (const [k, v] of Object.entries(partial.projects)) {
      if (!isObj(v)) throw new Error(`config: projects["${k}"] must be an object`)
      if ('muted' in v) {
        if (typeof v.muted !== 'boolean') {
          throw new Error(`config: projects["${k}"].muted must be a boolean, got ${JSON.stringify(v.muted)}`)
        }
        cfg.projects[k] = { muted: v.muted }
      } else {
        cfg.projects[k] = { muted: false }
      }
    }
  }

  return cfg
}

/**
 * Reads and JSON.parses the raw config file, or returns `undefined` when it
 * doesn't exist yet. Shared between `loadConfig` and `setMuted` so both
 * agree on what "no config file yet" and "malformed config file" mean.
 *
 * Also-fix from the review triage: this used to be a bare `JSON.parse(raw)`
 * inside `loadConfig`. A typo'd config.json (trailing comma, unclosed
 * brace — exactly what a human hand-editing the file produces) threw an
 * unwrapped, unnamed `SyntaxError` straight out of the engine's boot
 * sequence, giving no indication of which file was at fault. Wrapped so the
 * error names the path.
 */
function readRawConfig(path: string): unknown {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new Error(`config: could not parse ${path} as JSON (${(err as Error).message})`)
  }
}

export function loadConfig(path = configPath()): NudgeConfig {
  return mergeConfig(readRawConfig(path))
}

/**
 * Finding I7: `nudge mute` only ever flipped `cfg.muted` in the engine's
 * in-memory config object — nothing wrote it to config.json. `nudge status`
 * re-reads config.json fresh on every invocation, so it disagreed with
 * `nudge mute` the moment they ran in different processes (which they always
 * do — the CLI and the engine are separate processes), and a plain engine
 * restart silently unmuted everything with no trace it had ever happened.
 *
 * Patches only the `muted` key of the on-disk file (creating it, and any
 * missing parent directory, if it doesn't exist yet) rather than
 * serializing the whole resolved config, so a mute/unmute round trip never
 * clobbers whatever else the user has hand-edited into config.json.
 */
export function setMuted(on: boolean, path = configPath()): void {
  const raw = readRawConfig(path)
  const obj: Record<string, unknown> = isObj(raw) ? { ...raw } : {}
  obj.muted = on
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n', 'utf8')
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
