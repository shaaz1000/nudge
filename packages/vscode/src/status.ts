import * as vscode from 'vscode'
import type { SessionState } from '@nudge/shared/types'

/**
 * The minimal shape of a `vscode.StatusBarItem` this module touches. A real
 * StatusBarItem satisfies this structurally; a test fake needs nothing more.
 */
export interface StatusBarItemLike {
  text: string
  // vscode.StatusBarItem's real tooltip/command types are wider than what
  // this module ever assigns (it only ever sets plain strings) — matching
  // them exactly is what lets `vscode.window.createStatusBarItem(...)`
  // satisfy this interface structurally in defaultSurface() below.
  tooltip: string | vscode.MarkdownString | undefined
  backgroundColor: unknown
  command: string | vscode.Command | undefined
  show(): void
  dispose(): void
}

/**
 * The slice of the `vscode` namespace status.ts needs. There is no runtime
 * `vscode` module outside an Extension Development Host — only
 * `@types/vscode` for compile-time typing — so a class built straight on
 * `vscode.window.createStatusBarItem(...)` cannot be constructed, let alone
 * asserted on, under plain Node/Vitest. Injecting this narrow surface (a
 * factory for the item, and the one themed color this module ever sets)
 * lets tests drive real render() behaviour with a fake.
 */
export interface StatusBarSurface {
  createStatusBarItem(): StatusBarItemLike
  /** `new vscode.ThemeColor('statusBarItem.warningBackground')` — the only background color this module uses. */
  warningBackgroundColor: unknown
}

const FOCUS_COMMAND = 'nudge.focusSession'

/**
 * Built lazily, and only when no surface is injected — never at module load
 * — so importing this file never itself touches the real `vscode` binding.
 * Only production code (the eventual extension.ts composition root) calls
 * `new StatusBar()` with no argument; every test supplies its own fake.
 */
function defaultSurface(): StatusBarSurface {
  return {
    createStatusBarItem: () => vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100),
    warningBackgroundColor: new vscode.ThemeColor('statusBarItem.warningBackground'),
  }
}

/** "65000" -> "1m", "90 minutes" -> "1h 30m". Never negative (clock skew). */
export function formatWaitDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${hours}h ${minutes}m`
}

/**
 * The status bar item: a persistent, always-visible indicator of whether any
 * of *this window's* sessions are waiting on the user, in one of three
 * states — see the module-level behaviour spec in the Phase 2 plan
 * (docs/superpowers/plans/2026-08-11-phase2-vscode-extension.md, Task 3):
 *
 *  - engine unreachable: quiet `$(bell-slash)`, never an error toast
 *  - nothing waiting: dim `$(bell)`
 *  - N waiting: warning-colored `$(bell-dot) Nudge N`, tooltip listing each
 *
 * `connected` always wins over `mine`: a disconnect can leave the caller
 * holding a stale, non-empty `mine` from the last broadcast before the
 * engine died, and showing a confident count the extension can no longer
 * verify would be worse than showing nothing.
 */
export class StatusBar {
  readonly #surface: StatusBarSurface
  readonly #item: StatusBarItemLike
  #disposed = false

  constructor(surface: StatusBarSurface = defaultSurface()) {
    this.#surface = surface
    this.#item = surface.createStatusBarItem()
    this.#item.command = FOCUS_COMMAND
    this.#item.show()
  }

  render(mine: SessionState[], connected: boolean): void {
    if (this.#disposed) return
    this.#item.command = FOCUS_COMMAND

    if (!connected) {
      this.#item.text = '$(bell-slash) Nudge'
      this.#item.tooltip = 'The Nudge engine is not running. Start it with `nudge start`.'
      this.#item.backgroundColor = undefined
      return
    }

    if (mine.length === 0) {
      this.#item.text = '$(bell) Nudge'
      this.#item.tooltip = 'Nothing waiting'
      this.#item.backgroundColor = undefined
      return
    }

    this.#item.text = `$(bell-dot) Nudge ${mine.length}`
    this.#item.backgroundColor = this.#surface.warningBackgroundColor
    this.#item.tooltip = mine
      .map(s => `${s.project} — ${s.tier} — waiting ${formatWaitDuration(Date.now() - (s.waitingSince ?? Date.now()))}`)
      .join('\n')
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#item.dispose()
  }
}
