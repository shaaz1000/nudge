import type { NudgeConfig } from '@nudge/shared/config'
import type { Clock, Cancel } from './clock.js'
import type { SessionStore, Transition } from './state.js'

/**
 * Finding I2: retention (`Db#prune`) used to run exactly once, at
 * `Engine#start()`. The engine is a daemon meant to run for weeks, so a
 * one-shot prune at boot means events and resolved waits accumulate
 * unbounded between restarts — on a machine that reboots rarely, `nudge.db`
 * grows forever regardless of `retentionDays`. This is deliberately much
 * slower than the default 30s watchdog tick (`tickMs`): pruning is cheap but
 * not free, and correctness here has no dependency on tick cadence at all —
 * "eventually, periodically" is the whole requirement.
 */
export const PRUNE_INTERVAL_MS = 3_600_000 // 1 hour

/**
 * Heuristic, and honest about it: a session sitting in PreToolUse on a
 * nine-minute test script is indistinguishable from a crashed one. Hence the
 * conservative default and no phone escalation unless explicitly enabled.
 */
export class Watchdog {
  #lastPruneAt: number

  constructor(
    private cfg: NudgeConfig,
    private clock: Clock,
    private store: SessionStore,
    private onStall: (t: Transition) => void,
    /**
     * Finding I1: `store.drop(id)` below used to be the whole story for a
     * TTL expiry — nothing told the escalator to cancel that session's
     * ladder, and nothing closed its DB wait row (`prune()` never deletes an
     * *open* wait by design, so a dropped session's row became permanent).
     * The caller (bin.ts wires this to `Engine#onWatchdogDrop`) is
     * responsible for `escalator.cancel(id)` + `db.closeWait(id, ...)`;
     * Watchdog itself has no handle on either. Defaults to a no-op so
     * existing 4-arg call sites that don't care about this cleanup — most
     * test files construct a Watchdog with only `onStall` — keep compiling.
     */
    private onDrop: (sessionId: string) => void = () => {},
    /**
     * Finding I2: fired at most once per PRUNE_INTERVAL_MS of elapsed time
     * (not once per tick — the default tick is 30s, pruning every 30s would
     * be needless churn against retention windows measured in days). The
     * caller (bin.ts wires this to `Engine#onWatchdogPrune`) owns the actual
     * `Db#prune` call and its retentionDays math; Watchdog only owns the
     * cadence. Defaults to a no-op for the same compile-compatibility reason
     * `onDrop` does.
     */
    private onPrune: () => void = () => {},
  ) {
    // Anchored to construction time, not epoch 0 / "never pruned yet" —
    // Engine#start() already pruned once at boot immediately before
    // starting this loop, so the first *periodic* prune should land a full
    // interval later, not redundantly re-fire on the very first tick.
    this.#lastPruneAt = clock.now()
  }

  start(): Cancel {
    let cancelled = false
    let cancelTimer: Cancel = () => {}
    const loop = () => {
      if (cancelled) return
      try {
        this.tick()
      } catch (err) {
        console.error('nudge watchdog: tick failed', err)
      } finally {
        cancelTimer = this.clock.schedule(this.cfg.watchdog.tickMs, loop)
      }
    }
    cancelTimer = this.clock.schedule(this.cfg.watchdog.tickMs, loop)
    return () => { cancelled = true; cancelTimer() }
  }

  tick(): void {
    // TTL first: an expired session should be dropped, not resurrected as stalled.
    for (const id of this.store.idsOlderThan(this.cfg.watchdog.sessionTtlMs)) {
      this.store.drop(id)
      try {
        this.onDrop(id)
      } catch (err) {
        console.error(`nudge watchdog: onDrop failed for ${id}`, err)
      }
    }

    const cutoff = this.clock.now() - this.cfg.watchdog.stallAfterMs
    for (const s of this.store.list()) {
      if (s.status !== 'running') continue
      if (s.lastEventAt > cutoff) continue
      const t = this.store.markStalled(s.sessionId)
      if (t) {
        try {
          this.onStall(t)
        } catch (err) {
          console.error(`nudge watchdog: onStall failed for ${t.session.sessionId}`, err)
        }
      }
    }

    if (this.clock.now() - this.#lastPruneAt >= PRUNE_INTERVAL_MS) {
      this.#lastPruneAt = this.clock.now()
      try {
        this.onPrune()
      } catch (err) {
        console.error('nudge watchdog: onPrune failed', err)
      }
    }
  }
}
