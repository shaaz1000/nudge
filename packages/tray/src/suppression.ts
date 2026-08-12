import type { SessionState } from '@nudge/shared/types'
import type { NudgeConfig } from '@nudge/shared/config'

/**
 * The tray's single answer to "may this session raise a local alert?".
 *
 * Mirrors packages/engine/src/suppression.ts's `localSuppression`, in the
 * same priority order: tier-disabled -> frontmost -> muted -> project-muted
 * -> snoozed. Duplicated rather than imported because `packages/engine` is
 * the daemon and the tray must not depend on it; the engine remains the
 * authority, and if these ever diverge the engine's rules are the correct
 * ones.
 *
 * It lives in its own module because it was previously implemented twice
 * inside this package, with different rules, and the difference was a real
 * bug rather than a tidiness complaint: `notify.ts` checked only tier and
 * snooze, so it ignored mute entirely. Since the engine stands its own
 * banner down while a GUI client is connected (see engine.ts's `onLocal`
 * and protocol.ts's `gui` flag), `nudge mute` silenced the engine and the
 * tray notified anyway — mute simply stopped working whenever the tray was
 * running. One shared rule, one place to fix.
 *
 * Note this is a client-side re-derivation from broadcast state, which is
 * inherently fragile: the engine sends a view model, not its suppression
 * verdict, so every client has to reconstruct the decision. The durable fix
 * is for the engine to tell GUI clients when to alert instead of letting
 * them infer it — recorded in the Phase 3 review notes.
 */
export function isSessionSuppressed(
  cfg: NudgeConfig,
  s: SessionState,
  now: number,
  frontmostSessionId: string | null,
): boolean {
  // `?.` and an explicit `=== false`: a config missing this tier entirely
  // must not read as "disabled" (which `!undefined` would give), because
  // that silently suppresses a real nudge. Only an explicit `enabled: false`
  // suppresses.
  if (s.tier !== null && cfg.tiers[s.tier]?.enabled === false) return true
  if (frontmostSessionId !== null && frontmostSessionId === s.sessionId) return true
  if (cfg.muted) return true
  if (cfg.projects[s.cwd]?.muted) return true
  if (s.snoozedUntil !== null && now < s.snoozedUntil) return true
  return false
}

/**
 * A session that should currently be shown as waiting: it has a tier, and
 * nothing suppresses it.
 *
 * Used for BOTH "should we alert?" and "should we clear an existing alert?"
 * so the two can never disagree — a session that becomes muted or snoozed
 * mid-wait has its banner closed rather than left on screen.
 */
export function isWaiting(
  cfg: NudgeConfig,
  s: SessionState,
  now: number,
  frontmostSessionId: string | null = null,
): boolean {
  return s.tier !== null && !isSessionSuppressed(cfg, s, now, frontmostSessionId)
}
