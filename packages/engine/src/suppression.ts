import type { SessionState, Tier } from '@nudge/shared/types'
import type { NudgeConfig } from '@nudge/shared/config'

export type Suppression =
  | 'none' | 'tier-disabled' | 'frontmost'
  | 'muted' | 'project-muted' | 'snoozed' | 'quiet-hours'

export function minutesOfDay(ts: number): number {
  const d = new Date(ts)
  return d.getHours() * 60 + d.getMinutes()
}

function parseHM(hm: string): number {
  const [h, m] = hm.split(':').map(Number)
  return h * 60 + m
}

/** Half-open [start, end); handles windows that cross midnight. */
export function inQuietHours(q: { start: string; end: string } | null, minutes: number): boolean {
  if (!q) return false
  const start = parseHM(q.start)
  const end = parseHM(q.end)
  if (start === end) return false
  return start < end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end
}

function shared(cfg: NudgeConfig, s: SessionState, now: number): Suppression {
  if (cfg.muted) return 'muted'
  if (cfg.projects[s.cwd]?.muted) return 'project-muted'
  if (s.snoozedUntil !== null && now < s.snoozedUntil) return 'snoozed'
  return 'none'
}

/**
 * Priority: tier disabled -> frontmost -> mute -> project mute -> snooze.
 * Quiet hours deliberately does NOT suppress local alerts.
 */
export function localSuppression(
  cfg: NudgeConfig,
  s: SessionState,
  tier: Tier,
  frontmostSessionId: string | null,
  now: number,
): Suppression {
  if (!cfg.tiers[tier].enabled) return 'tier-disabled'
  if (frontmostSessionId !== null && frontmostSessionId === s.sessionId) return 'frontmost'
  return shared(cfg, s, now)
}

export function phoneSuppression(
  cfg: NudgeConfig,
  s: SessionState,
  tier: Tier,
  now: number,
  minutes: number,
): Suppression {
  const t = cfg.tiers[tier]
  if (!t.enabled || !t.escalates) return 'tier-disabled'
  const base = shared(cfg, s, now)
  if (base !== 'none') return base
  if (inQuietHours(cfg.quietHours, minutes)) return 'quiet-hours'
  return 'none'
}
