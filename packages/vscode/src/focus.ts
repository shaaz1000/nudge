import * as vscode from 'vscode'
import type { SessionState } from '@nudge/shared/types'
import { sessionsForWindow } from './match.js'

/**
 * The slice of the `vscode` namespace focus.ts needs. There is no runtime
 * `vscode` module outside an Extension Development Host — only
 * `@types/vscode` for compile-time typing — so calling
 * `vscode.commands.executeCommand(...)` directly cannot be exercised under
 * plain Node/Vitest. Injecting this narrow surface (rather than the whole
 * namespace) lets a test drive the real branch-selection logic with a fake,
 * and lets production code default to the real thing.
 *
 * Deliberately has no way to talk to the engine (no `send`, no
 * `ClientMessage`) — see the module doc below for why that omission is the
 * point, not an oversight.
 */
export interface FocusSurface {
  /** This window's own workspace folder paths — same contract as sessionsForWindow's `folders` param. */
  workspaceFolderPaths(): readonly string[]
  /** `vscode.Uri.file(path)`, wrapped so this module never touches the real `vscode.Uri` at load time. */
  fileUri(path: string): unknown
  /** `vscode.commands.executeCommand(command, ...args)`. */
  executeCommand(command: string, ...args: unknown[]): Thenable<unknown> | void
}

/**
 * Built lazily, and only when no surface is injected — never at module load
 * — so importing this file never itself touches the real `vscode` binding.
 * Only production code (extension.ts's composition root) calls
 * `focusSession(s)` with no second argument; every test supplies its own
 * fake instead.
 */
function defaultSurface(): FocusSurface {
  return {
    workspaceFolderPaths: () => (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
    fileUri: path => vscode.Uri.file(path),
    executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
  }
}

/**
 * Brings the right window forward for a waiting session — the feature the
 * whole phase exists for. Ordered strategy (see the Phase 2 plan, Task 5):
 *
 *  1. The session's `cwd` is inside one of *this* window's own workspace
 *     folders (reuses `sessionsForWindow` from Task 2, applied to a single
 *     session) -> reveal the terminal panel where Claude Code is running.
 *  2. Otherwise -> ask VS Code to open the session's folder with
 *     `{ forceNewWindow: false }`. An extension has no API to inspect or
 *     focus a *sibling* window directly, and no way to ask "is this folder
 *     already open somewhere else?" — `vscode.openFolder` already resolves
 *     that internally: if the folder is open in another window, VS Code
 *     switches to it; if it is not open anywhere, VS Code opens it (reusing
 *     this window when it has no folder of its own). Branches 2 and 3 of the
 *     plan's ordered list are therefore the same call from here — the
 *     disambiguation between "another open window" and "no window at all"
 *     happens inside VS Code, not in this extension.
 *
 * Critical rule, and the reason this function's signature has no `send` or
 * `ClientMessage` anywhere in it: focusing is not answering. This must NEVER
 * resolve the wait — the engine keeps a session waiting until Claude Code's
 * own hook clears it, and resolving here would close the history row early
 * and cancel a still-valid escalation. `FocusSurface` above has no way to
 * write to the engine socket at all, so this function cannot send `resolve`
 * even by accident.
 */
export async function focusSession(s: SessionState, surface: FocusSurface = defaultSurface()): Promise<void> {
  const folders = surface.workspaceFolderPaths()
  const mine = sessionsForWindow([s], folders).length > 0

  if (mine) {
    await surface.executeCommand('workbench.action.terminal.focus')
    return
  }

  const uri = surface.fileUri(s.cwd)
  await surface.executeCommand('vscode.openFolder', uri, { forceNewWindow: false })
}
