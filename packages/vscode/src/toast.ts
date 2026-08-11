import * as vscode from 'vscode'
import type { ClientMessage } from '@nudge/shared/protocol'
import type { SessionState, Tier } from '@nudge/shared/types'

/**
 * The slice of the `vscode` namespace toast.ts needs. There is no runtime
 * `vscode` module outside an Extension Development Host — only
 * `@types/vscode` for compile-time typing — so a class that calls
 * `vscode.window.showWarningMessage(...)` directly cannot be constructed
 * under plain Node/Vitest. Injecting this narrow surface (rather than the
 * whole namespace) lets a test assert the real de-duplication and action
 * logic with a fake, and lets production code default to the real thing.
 */
export interface ToastSurface {
  showWarningMessage(message: string, ...items: string[]): Thenable<string | undefined>
  getConfiguration(section: string): { get<T>(key: string, defaultValue: T): T }
  executeCommand(command: string, ...args: unknown[]): Thenable<unknown> | void
}

const FOCUS_COMMAND = 'nudge.focusSession'
const SNOOZE_MS = 600_000

/**
 * Mirrors packages/engine/src/desktop.ts's TIER_TEXT. Duplicated rather than
 * imported: that module isn't exported for cross-package reuse, and this
 * task's brief scopes changes to packages/vscode only.
 */
const TIER_TEXT: Record<Tier, string> = {
  'blocked': 'Waiting on you: permission or question',
  'idle-long': 'Long task finished — your move',
  'idle-short': 'Turn finished — your move',
  'stalled': 'Session may have stalled',
}

/**
 * Built lazily, and only when no surface is injected — never at module load
 * — so importing this file never itself touches the real `vscode` binding.
 * Only production code (the eventual extension.ts composition root) calls
 * `new Toaster(send)` with no second argument; every test supplies its own
 * fake instead.
 */
function defaultSurface(): ToastSurface {
  return {
    showWarningMessage: (message, ...items) => vscode.window.showWarningMessage(message, ...items),
    getConfiguration: section => vscode.workspace.getConfiguration(section),
    executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
  }
}

/**
 * Shows a warning toast the moment a session enters a waiting state, with
 * 'Go to it' / 'Snooze 10m' actions.
 *
 * The engine broadcasts full state on every change, not only on
 * transitions — a session that has been waiting for an hour reappears in
 * every `mine` array passed to `update()` for that whole hour. Without
 * tracking which session ids have already been toasted, every one of those
 * broadcasts would pop a new toast. `#toasted` is that tracking: a session
 * id is added the first time it is seen waiting, and removed the moment it
 * stops waiting (tier goes back to `null`, or it drops out of `mine`
 * entirely — e.g. the session ended) so a later re-block toasts again.
 */
export class Toaster {
  readonly #send: (msg: ClientMessage) => void
  readonly #surface: ToastSurface
  readonly #toasted = new Set<string>()
  #nextId = 1
  #disposed = false

  constructor(send: (msg: ClientMessage) => void, surface: ToastSurface = defaultSurface()) {
    this.#send = send
    this.#surface = surface
  }

  update(mine: SessionState[]): void {
    if (this.#disposed) return

    const waitingIds = new Set(mine.filter(s => s.tier !== null).map(s => s.sessionId))
    // Clear-on-resolve: drop tracking for any session this update no longer
    // reports as waiting, so it toasts again if it re-blocks later. Iterating
    // and deleting from the same Set is well-defined in JS — a Set iterator
    // is unaffected by deletions of entries already visited or not yet due.
    for (const id of this.#toasted) {
      if (!waitingIds.has(id)) this.#toasted.delete(id)
    }

    const showToasts = this.#surface.getConfiguration('nudge').get('showToasts', true)

    for (const s of mine) {
      if (s.tier === null) continue
      if (this.#toasted.has(s.sessionId)) continue
      // Marked toasted regardless of the showToasts setting: flipping the
      // setting on mid-wait must not cause an immediate backlog of toasts
      // for sessions that had already been (silently) waiting.
      this.#toasted.add(s.sessionId)
      if (showToasts) this.#show(s)
    }
  }

  #show(s: SessionState): void {
    const tier = s.tier as Tier // non-null: only called from the `s.tier === null` guarded loop above
    const message = `${s.project}: ${s.message ?? TIER_TEXT[tier]}`
    void Promise.resolve(this.#surface.showWarningMessage(message, 'Go to it', 'Snooze 10m')).then(choice => {
      // The user can dismiss or click an action well after this Toaster was
      // disposed (window closed, extension reloaded) — without this guard a
      // stale toast would still call executeCommand/send into a torn-down
      // extension host.
      if (this.#disposed) return
      if (choice === 'Go to it') {
        void this.#surface.executeCommand(FOCUS_COMMAND, s)
      } else if (choice === 'Snooze 10m') {
        this.#send({ t: 'snooze', id: this.#nextId++, sessionId: s.sessionId, ms: SNOOZE_MS })
      }
      // Dismissing (choice === undefined) does nothing — the status bar
      // keeps showing the session as waiting.
    })
  }

  /**
   * Marks this Toaster inert (see #show's guard) and drops all tracked
   * session ids. There is no VS Code Disposable to release here — unlike
   * StatusBarItem, a shown toast holds no handle the extension owns — so
   * disposal is entirely about not acting on notifications in flight.
   */
  dispose(): void {
    this.#disposed = true
    this.#toasted.clear()
  }
}
