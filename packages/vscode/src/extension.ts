import * as vscode from 'vscode'
import type { ClientMessage } from '@nudge/shared/protocol'
import type { SessionState } from '@nudge/shared/types'
import { EngineClient, type EngineClientOptions } from './client.js'
import { sessionsForWindow } from './match.js'
import { StatusBar } from './status.js'
import { Toaster } from './toast.js'
import { focusSession } from './focus.js'

const SNOOZE_MS = 600_000
const CONNECTIVITY_POLL_MS = 5_000

/**
 * The subset of `EngineClient`'s public members extension.ts actually uses.
 * `Pick<EngineClient, ...>` strips the class's private (`#`) fields from the
 * resulting type, so a plain fake object satisfies it structurally in
 * tests — a real `EngineClient` cannot otherwise be faked because private
 * fields make classes non-structural (only the class itself, or a
 * subclass, is assignable to it).
 *
 * Tests MUST always inject a fake here via `ActivateDeps.client`, never let
 * `activate()` fall through to constructing a real `EngineClient` with no
 * path override — the default path is the real, currently-running
 * production engine socket.
 */
export type EngineClientLike = Pick<EngineClient, 'connected' | 'onState' | 'send' | 'connect' | 'dispose'>

export interface SessionQuickPickItem extends vscode.QuickPickItem {
  session: SessionState
}

/**
 * The slice of the `vscode` namespace extension.ts itself needs — distinct
 * from (and narrower than) the surfaces StatusBar/Toaster/focus.ts define
 * for their own internal `defaultSurface()`s, which extension.ts leaves on
 * their real defaults. Same rationale as those modules: no runtime `vscode`
 * module exists outside an editor host, so this has to be injectable to be
 * testable under plain Node/Vitest.
 */
export interface ExtensionSurface {
  workspaceFolderPaths(): readonly string[]
  getConfiguration(section: string): { get<T>(key: string, defaultValue: T): T }
  isWindowFocused(): boolean
  onDidChangeWindowState(cb: (e: { focused: boolean }) => void): vscode.Disposable
  registerCommand(id: string, cb: (...args: unknown[]) => unknown): vscode.Disposable
  showQuickPick(
    items: SessionQuickPickItem[], options: vscode.QuickPickOptions,
  ): Thenable<SessionQuickPickItem | undefined>
  showInformationMessage(message: string): Thenable<string | undefined>
}

function defaultExtensionSurface(): ExtensionSurface {
  return {
    workspaceFolderPaths: () => (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
    getConfiguration: section => vscode.workspace.getConfiguration(section),
    isWindowFocused: () => vscode.window.state.focused,
    onDidChangeWindowState: cb => vscode.window.onDidChangeWindowState(cb),
    registerCommand: (id, cb) => vscode.commands.registerCommand(id, cb),
    showQuickPick: (items, options) => vscode.window.showQuickPick(items, options),
    showInformationMessage: message => vscode.window.showInformationMessage(message),
  }
}

/**
 * Pure decision, pulled out of activate() so it can be unit-tested without
 * ever constructing a real `EngineClient` (which would otherwise touch the
 * real socketPath() default — see EngineClientLike's doc). Empty string
 * (the setting's default) means "use the engine's normal socket path";
 * anything else is an explicit override.
 */
export function clientOptionsFromConfig(socketPathOverride: string): EngineClientOptions {
  return socketPathOverride ? { path: socketPathOverride } : {}
}

export interface ActivateDeps {
  client?: EngineClientLike
  surface?: ExtensionSurface
  pollIntervalMs?: number
}

interface Disposable { dispose(): void }

// Module-scoped so deactivate() (a fixed-signature export VS Code calls with
// no arguments) can tear down whatever the most recent activate() built.
let active: Disposable[] = []

/**
 * The composition root: builds the engine client, status bar and toaster,
 * wires the engine's state broadcasts to both, reports this window's focus
 * back to the engine (the suppression feed described in the Phase 2 plan),
 * and registers the four Task 6 commands.
 *
 * `deps` exists purely for testability (constructor/parameter injection,
 * same pattern as status.ts/toast.ts/focus.ts) — the real VS Code host only
 * ever calls `activate(context)` with no second argument.
 */
export function activate(context: vscode.ExtensionContext, deps: ActivateDeps = {}): void {
  const surface = deps.surface ?? defaultExtensionSurface()
  const socketPathOverride = surface.getConfiguration('nudge').get('socketPath', '')
  const client: EngineClientLike = deps.client ?? new EngineClient(clientOptionsFromConfig(socketPathOverride))
  const statusBar = new StatusBar()
  const toaster = new Toaster((msg: ClientMessage) => client.send(msg))
  // StatusBar's constructor shows the item but never calls render() itself
  // (see status.ts) — without this, the item sits blank (no icon at all,
  // not even the "unreachable" one) until the first broadcast or the first
  // poll tick, up to CONNECTIVITY_POLL_MS later.
  statusBar.render([], client.connected)

  let nextId = 1
  let mine: SessionState[] = []
  let mineWaiting: SessionState[] = []
  let allWaiting: SessionState[] = []
  let windowFocused = surface.isWindowFocused()

  // Only ever called while windowFocused is true from the loss branch's
  // perspective too — see the two call sites below. Sending unconditionally
  // on loss (even if this window never owned anything) is deliberate and
  // harmless: it is idempotent from the engine's point of view, and it is
  // the only way a window that stops owning anything still clears whatever
  // it last reported.
  function reportFrontmostOnFocusChange(focused: boolean): void {
    windowFocused = focused
    if (!windowFocused) {
      client.send({ t: 'frontmost', sessionId: null })
      return
    }
    reportFrontmostIfFocused()
  }

  // Distinct from the function above: called after every state broadcast
  // too (the waiting set can change while this window keeps focus), so it
  // must NOT unconditionally send on the "focused but nothing waiting"
  // case — the brief's gate is "gains focus AND owns a waiting session".
  function reportFrontmostIfFocused(): void {
    if (!windowFocused) return
    const candidate = mineWaiting[0]?.sessionId ?? null
    if (candidate !== null) client.send({ t: 'frontmost', sessionId: candidate })
  }

  client.onState(sessions => {
    const folders = surface.workspaceFolderPaths()
    mine = sessionsForWindow(sessions, folders)
    mineWaiting = mine.filter(s => s.tier !== null)
    allWaiting = sessions.filter(s => s.tier !== null)
    statusBar.render(mine, client.connected)
    toaster.update(mine)
    reportFrontmostIfFocused()
  })

  const windowStateSub = surface.onDidChangeWindowState(e => reportFrontmostOnFocusChange(e.focused))

  // client.onState() only fires on a fresh broadcast from the engine — if
  // the engine dies, no broadcast ever arrives to tell the status bar to go
  // quiet. Polling client.connected (a plain getter, not an event source
  // this package is allowed to add to client.ts) is the only way, short of
  // touching client.ts, to notice that promptly rather than only on the
  // next lucky reconnect-and-rebroadcast.
  const pollTimer = setInterval(() => {
    statusBar.render(mine, client.connected)
  }, deps.pollIntervalMs ?? CONNECTIVITY_POLL_MS)

  /**
   * Resolves a command's implicit session target from `list` when the
   * command was invoked with no explicit argument: no prompt needed for
   * zero (nothing to do) or exactly one (nothing to choose between);
   * otherwise asks via quick pick.
   */
  async function pickSession(list: SessionState[], placeHolder: string): Promise<SessionState | undefined> {
    if (list.length === 0) return undefined
    if (list.length === 1) return list[0]
    const items: SessionQuickPickItem[] = list.map(s => ({
      label: s.project,
      description: `${s.tier ?? ''} — ${s.message ?? ''}`,
      session: s,
    }))
    const picked = await surface.showQuickPick(items, { placeHolder })
    return picked?.session
  }

  // The load-bearing rule (Task 5, point 4 / the plan's "Critical rule"):
  // focusing is not answering. This handler must NEVER call client.send —
  // resolving here would close the history row early and cancel a
  // still-valid escalation. focusSession() itself has no way to send
  // anything (see focus.ts's FocusSurface), so this is the one place that
  // rule could be broken by a future edit — do not "helpfully" add a
  // send({t:'resolve', ...}) here.
  const cmdFocusSession = surface.registerCommand('nudge.focusSession', async (...args: unknown[]) => {
    const arg = args[0] as SessionState | undefined
    const target = arg ?? await pickSession(mineWaiting, 'Nudge: jump to a waiting session in this window')
    if (!target) return
    await focusSession(target)
  })

  const cmdSnooze = surface.registerCommand('nudge.snooze', async (...args: unknown[]) => {
    const arg = args[0] as SessionState | undefined
    const target = arg ?? await pickSession(allWaiting, 'Nudge: snooze which session?')
    if (!target) {
      void surface.showInformationMessage('Nudge: nothing waiting to snooze.')
      return
    }
    client.send({ t: 'snooze', id: nextId++, sessionId: target.sessionId, ms: SNOOZE_MS })
  })

  let muted = false
  const cmdMute = surface.registerCommand('nudge.mute', () => {
    muted = !muted
    client.send({ t: 'mute', id: nextId++, on: muted })
    void surface.showInformationMessage(muted ? 'Nudge: muted.' : 'Nudge: unmuted.')
  })

  // Lists every waiting session system-wide, not only this window's — the
  // whole point of a global list is to be able to jump to a session some
  // OTHER window owns, which focusSession()'s non-mine branch already
  // knows how to do (open/reuse that folder).
  const cmdShowList = surface.registerCommand('nudge.showList', async () => {
    if (allWaiting.length === 0) {
      void surface.showInformationMessage('Nudge: nothing waiting.')
      return
    }
    const target = await pickSession(allWaiting, 'Nudge: waiting sessions')
    if (!target) return
    await focusSession(target)
  })

  client.connect()

  active = [
    client, statusBar, toaster, windowStateSub,
    cmdFocusSession, cmdSnooze, cmdMute, cmdShowList,
    { dispose: () => clearInterval(pollTimer) },
  ]
  context.subscriptions.push(...active)
}

/**
 * Disposes everything the most recent activate() allocated: the engine
 * client's socket, the status bar item, the toaster, the window-focus
 * subscription, every registered command, and the connectivity poll timer.
 * A leaked socket here survives an extension reload and accumulates one per
 * reload — see client.ts's own dispose() doc for the same concern one layer
 * down.
 */
export function deactivate(): void {
  for (const d of active) d.dispose()
  active = []
}
