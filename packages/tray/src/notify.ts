import { Notification } from 'electron'
import type { SessionState, Tier } from '@nudge/shared/types'

/**
 * Mirrors packages/engine/src/desktop.ts's TIER_TEXT (also duplicated,
 * unchanged, in packages/vscode/src/toast.ts). Duplicated rather than
 * imported: packages/engine is out of this task's scope (see the Phase 3
 * plan's Task 4/5 briefs — "Scope: packages/tray only"), and this is a tiny,
 * self-contained constant, not shared protocol logic like `@nudge/shared`
 * covers.
 */
const TIER_TEXT: Record<Tier, string> = {
  'blocked': 'Waiting on you: permission or question',
  'idle-long': 'Long task finished — your move',
  'idle-short': 'Turn finished — your move',
  'stalled': 'Session may have stalled',
}

/**
 * Pure — no Electron touched. `||`, not `??`, matching desktop.ts's and
 * toast.ts's identical fallback: an empty-string `message` is falsy but not
 * null/undefined, and must still fall back to the tier text rather than
 * rendering nothing after the title.
 *
 * Full detail, unconditionally — no `detailLevel` check. That is the
 * deliberate asymmetry against the *phone* payload (see
 * packages/engine/src/dispatch.ts's `buildAlert`, which gates `detail` on
 * `cfg.detailLevel === 'full'`): a phone push leaves this machine over the
 * network, so minimal-by-default is the safe choice there. A desktop
 * notification never leaves the machine it was raised on, so there is
 * nothing to protect by withholding the actual question or exact command —
 * withholding it here would only make the notification less useful for no
 * privacy benefit. This exactly matches what Phase 1's own local
 * `DesktopNotifier.alert()` already shows (see desktop.ts) — the tray does
 * not add any new exposure by matching it.
 */
export function notificationContent(s: SessionState): { title: string; body: string } {
  const tier = s.tier as Tier // non-null: only ever called for a session with tier !== null (see Notifier#show)
  return {
    title: `${s.project} needs you`,
    body: s.message || TIER_TEXT[tier],
  }
}

/**
 * The minimal shape of a real Electron `Notification` this module touches.
 * A real `Notification` instance satisfies this structurally (its `on` and
 * `close` are strictly more permissive than what is declared here); a test
 * fake needs nothing more.
 */
export interface NotificationLike {
  show(): void
  on(event: 'click', cb: () => void): void
  close(): void
}

/**
 * The slice of Electron's `Notification` constructor this module needs.
 * There is no runtime `electron` module outside an Electron host — only the
 * `electron` package's own bundled `.d.ts` for compile-time typing — so
 * `new Notification(...)` cannot be constructed under plain Node/Vitest.
 * Injecting this narrow surface (rather than calling the constructor
 * directly) lets tests drive the real de-dup/click logic with a fake, and
 * lets production code default to the real thing. Same pattern Task 3's
 * `tray.ts` used for `electron.Tray`.
 */
export interface NotifySurface {
  create(opts: { title: string; body: string; silent: boolean }): NotificationLike
}

/**
 * Built lazily, and only when no surface is injected — never at module load
 * — so importing this file never itself touches the real `electron`
 * binding. Only production code (main.ts's composition root) calls
 * `new Notifier(onFocus)` with no second argument; every test supplies its
 * own fake instead.
 */
function defaultSurface(): NotifySurface {
  return { create: opts => new Notification(opts) }
}

/**
 * Electron `Notification` with a real, clickable action — the reason Phase 3
 * exists at all (see the plan's top-level "Why this exists" section):
 * macOS's `osascript` banner (what Phase 1's engine fires locally, see
 * packages/engine/src/desktop.ts) cannot carry a click handler. This can.
 *
 * ## De-duplication
 *
 * The engine broadcasts full state on every change, not only on
 * transitions — a session that has been waiting for an hour reappears in
 * every array passed to `update()` for that whole hour. Without tracking
 * which session ids have already been notified, every one of those
 * broadcasts would pop a new OS notification. `#shown` is that tracking —
 * identical in shape and intent to packages/vscode/src/toast.ts's
 * `Toaster#toasted`, except it is a `Map` (session id -> the live
 * `NotificationLike` handle) rather than a bare `Set`, so a resolved
 * session's lingering banner can be `close()`d, not merely forgotten. A
 * session id is added the first time it is seen waiting, and removed (and
 * its notification closed) the moment it stops waiting (tier goes back to
 * `null`, it drops out of the list entirely, or it becomes snoozed) — so a
 * later re-block notifies again.
 *
 * ## The double-notification problem (Task 4, Step 4) — decision and why
 *
 * Phase 1's engine (packages/engine/src/engine.ts's `onLocal`, invoked by
 * the `Escalator` at t=0 the instant a session starts waiting, and again on
 * every local repeat) unconditionally fires its own `osascript`/
 * `notify-send`/PowerShell banner via `DesktopNotifier.alert()` —
 * regardless of whether this tray, the VS Code extension, both, or neither
 * is running. There is no existing lever to suppress it without changing
 * `packages/engine` or `packages/shared`'s `NudgeConfig` schema:
 *
 *   - The socket protocol (`@nudge/shared/protocol`) is fixed at `subscribe,
 *     list, snooze, mute, resolve, idle, frontmost` — there is no
 *     "a richer client is connected" message to send.
 *   - `mute` is too broad: it also disables phone escalation
 *     (`phoneSuppression` checks the same `cfg.muted`), and it is already
 *     wired to the tray's own manual Mute/Unmute menu item (tray.ts) — this
 *     module cannot repurpose it as an automatic "I've got this" signal
 *     without breaking that unrelated, user-facing toggle.
 *   - `frontmost` specifically suppresses `onLocal` for the marked session
 *     (see `localSuppression`), but the Phase 3 plan explicitly warns
 *     against the tray becoming a second `frontmost` reporter (Open
 *     Questions #2) — marking sessions frontmost from here would be
 *     semantically wrong (the tray itself having OS focus proves nothing
 *     about whether the user is looking at the actual waiting window) and
 *     would fight with the VS Code extension's own legitimate use of it.
 *
 * Both are changes to `packages/engine`/`packages/shared`, which are out of
 * scope twice over: the Phase 3 plan's own global constraint ("No engine
 * changes. If a task appears to need one, stop and report it.") and this
 * task's explicit scope restriction to `packages/tray` only.
 *
 * Given that, the choice actually made here: **ship this Notifier, wired
 * live**, rather than build it and never call it. Withholding it would mean
 * Phase 3 — whose *entire* stated reason for existing is a clickable
 * notification — ships nothing a user can ever see or click, which is a
 * worse outcome than the one being avoided. What IS done to reduce the
 * duplication, entirely within this module's own reach:
 *
 *   - Every notification is created `silent: true` (see `#show` below).
 *     Phase 1's `DesktopNotifier` already plays its own per-tier sound
 *     (`afplay`/`paplay`/a PowerShell `SoundPlayer`, see desktop.ts's
 *     `soundCommand`) as a SEPARATE spawned process from its silent
 *     `osascript`/`notify-send` banner — so an Electron `Notification`
 *     built with its default (non-silent) behaviour would add a SECOND,
 *     purely redundant "ding" on top, costing nothing to suppress since the
 *     sound is not what this module adds. This closes the audible half of
 *     "two banners for one event" without touching the engine.
 *   - This Notifier only ever fires ONCE per wait (de-dup, above), while
 *     the engine's own `onLocal` repeats up to `cfg.escalation.localRepeat`
 *     additional times (default 3, every `localRepeatIntervalMs` = 60s) for
 *     the same unresolved wait — so the tray does not compound the
 *     engine's own repeat cadence; it only adds one clickable option at the
 *     start of it.
 *
 * What is NOT closed, and cannot be without an engine change: the VISUAL
 * banner still doubles at t=0 — the user will see both the engine's
 * (non-clickable) banner and this module's (clickable) one for the same
 * event when both processes are running. This is a real, acknowledged
 * defect, not something silently accepted as fine. The smallest correct fix
 * I can identify for a follow-up task: let `subscribe` carry an optional
 * capability flag (e.g. `{ t: 'subscribe', id, richNotify: true }`) that
 * `Engine#onLocal` checks — via `this.d.server` knowing at least one such
 * client is currently connected — before calling `notifier.alert()`,
 * skipping it only in that case. That is a `packages/engine` +
 * `packages/shared/protocol` change, and is explicitly out of scope here.
 */
export class Notifier {
  readonly #onFocus: (s: SessionState) => void
  readonly #surface: NotifySurface
  readonly #shown = new Map<string, NotificationLike>()
  #disposed = false

  constructor(onFocus: (s: SessionState) => void, surface: NotifySurface = defaultSurface()) {
    this.#onFocus = onFocus
    this.#surface = surface
  }

  update(mine: SessionState[]): void {
    if (this.#disposed) return

    // Identical rule to Toaster#update and NudgeTray#render: a snoozed
    // session is still `tier !== null` server-side (snooze is a separate
    // suppression overlay, not a tier clear — see
    // packages/engine/src/suppression.ts), so it must count as not-waiting
    // for BOTH the clearing loop below AND notify-eligibility, or it would
    // immediately drop its #shown tracking and re-notify in this same call.
    const now = Date.now()
    const isWaiting = (s: SessionState): boolean =>
      s.tier !== null && (s.snoozedUntil === null || now >= s.snoozedUntil)
    const waitingIds = new Set(mine.filter(isWaiting).map(s => s.sessionId))

    // Clear-on-resolve: close the OS notification (if still on screen) and
    // drop tracking for any session this update no longer reports as
    // waiting, so it notifies again if it re-blocks later. Iterating and
    // deleting from the same Map is well-defined in JS — a Map iterator is
    // unaffected by deletions of entries already visited or not yet due.
    for (const [id, n] of this.#shown) {
      if (!waitingIds.has(id)) {
        n.close()
        this.#shown.delete(id)
      }
    }

    for (const s of mine) {
      if (!isWaiting(s)) continue
      if (this.#shown.has(s.sessionId)) continue
      this.#shown.set(s.sessionId, this.#show(s))
    }
  }

  #show(s: SessionState): NotificationLike {
    const { title, body } = notificationContent(s)
    // silent: true — see the class doc's "double-notification problem"
    // section: the engine already plays its own per-tier sound for this
    // same event, so this module's own default banner sound would be pure,
    // avoidable duplication.
    const n = this.#surface.create({ title, body, silent: true })
    n.on('click', () => {
      // The user can click well after this Notifier was disposed (tray
      // quitting, engine restart tearing down `active` in main.ts) —
      // without this guard a stale click would still call into focus logic
      // built for a torn-down process.
      if (this.#disposed) return
      this.#onFocus(s)
    })
    n.show()
    return n
  }

  /**
   * Marks this Notifier inert (see `#show`'s click guard) and closes every
   * currently-shown OS notification rather than leaving stale banners (and
   * their now-orphaned click handlers) on screen after the tray itself has
   * quit.
   */
  dispose(): void {
    this.#disposed = true
    for (const n of this.#shown.values()) n.close()
    this.#shown.clear()
  }
}
