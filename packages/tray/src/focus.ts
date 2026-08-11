import { spawn, execFileSync } from 'node:child_process'
import { clipboard, Notification } from 'electron'
import type { SessionState, Surface } from '@nudge/shared/types'

// ---------------------------------------------------------------------------
// Escaping. Phase 1 shipped a real PowerShell command-injection bug
// (packages/engine/src/desktop.ts's history) from reusing an AppleScript
// escaper where a PowerShell string was being built — `\"` ends a
// double-quoted PowerShell string rather than escaping it, so the reused
// escaper's output was not actually safe there. This module writes FIVE
// per-surface branches (VS Code/Cursor/Windsurf, Claude desktop app,
// Terminal.app/iTerm2, Windows Terminal, Linux) but only TWO of them ever
// interpolate a value into a script string that a shell-like interpreter
// (osascript, powershell) will parse — AppleScript (desktop-app-by-name,
// Terminal.app/iTerm2-by-tty) and PowerShell (desktop-app-by-name on
// Windows, Windows-Terminal-by-wtSession). Every other branch (the editor
// CLIs, and Linux's wmctrl/xdotool) passes its value as a single argv
// element to `spawn()` with no shell in between — there is no script syntax
// there for a quote/`$(...)`/backtick/`;` to break out of, so no escaper
// applies (see `buildFocusPlan`'s editor-CLI branch for exactly this note).
// The two escapers that DO exist are named for the language they target,
// not the surface, and are never swapped between each other.
// ---------------------------------------------------------------------------

/**
 * AppleScript double-quoted string literal. Backslash first, then double
 * quote — reversing the order would double-escape a literal backslash.
 * Deliberately duplicated from (not imported from) packages/engine/src/
 * desktop.ts's identical function: packages/engine is out of this task's
 * scope, and this is a tiny, self-contained pure function.
 */
export function escapeAppleScriptString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * PowerShell SINGLE-quoted string literal. Single quotes suppress both
 * `$(...)` subexpression expansion and backtick escapes, and backslash is
 * not an escape character in that context — doubling the quote is the
 * WHOLE contract. This is a structurally different algorithm from
 * `escapeAppleScriptString` (different character, different rule), not the
 * same function under a different name — seeing the two diverge on the same
 * hostile input is exactly what proves they are not accidentally the same
 * escaper reused (test/focus.test.ts's "escaper distinctness" suite).
 */
export function escapePowerShellSingleQuoted(s: string): string {
  return s.replace(/'/g, "''")
}

// ---------------------------------------------------------------------------
// Plan construction — pure, no process ever spawned here. Building the
// plan and executing it are split so every branch above is testable without
// touching a real spawner/clipboard.
// ---------------------------------------------------------------------------

export type FocusPlan =
  | { kind: 'spawn'; cmd: string; args: string[] }
  | { kind: 'clipboard'; text: string; reason: string }

const EDITOR_CLI = { vscode: 'code', cursor: 'cursor', windsurf: 'windsurf' } as const

function clipboardFallback(s: SessionState, reason: string): FocusPlan {
  return { kind: 'clipboard', text: s.cwd, reason }
}

function buildTerminalAppFocusScript(tty: string): string {
  const t = escapeAppleScriptString(tty)
  return [
    'tell application "Terminal"',
    '  activate',
    '  repeat with w in windows',
    '    repeat with t in tabs of w',
    `      if tty of t contains "${t}" then`,
    '        set frontmost of w to true',
    '        set selected tab of w to t',
    '        return',
    '      end if',
    '    end repeat',
    '  end repeat',
    'end tell',
  ].join('\n')
}

function buildITermFocusScript(tty: string): string {
  const t = escapeAppleScriptString(tty)
  return [
    'tell application "iTerm2"',
    '  activate',
    '  repeat with w in windows',
    '    repeat with tb in tabs of w',
    '      repeat with sess in sessions of tb',
    `        if tty of sess contains "${t}" then`,
    '          select tb',
    '          select w',
    '          return',
    '        end if',
    '      end repeat',
    '    end repeat',
    '  end repeat',
    'end tell',
  ].join('\n')
}

function buildWindowsAppActivateScript(name: string): string {
  return `(New-Object -ComObject WScript.Shell).AppActivate('${escapePowerShellSingleQuoted(name)}')`
}

/**
 * Best-effort only: `WT_SESSION` identifies one specific pane/tab, but
 * Windows Terminal exposes no public window property carrying it, so there
 * is no way to select that exact pane from outside the process — only the
 * process itself can be brought to the foreground. `wtSession` is still
 * escaped and threaded into the script (as a comment marker, not live
 * logic) so this stays defensively correct — never building an unescaped
 * interpolation anywhere, even where today's version only echoes the value
 * — if a future revision finds a real per-pane API to target.
 */
function buildWindowsTerminalFocusScript(wtSession: string): string {
  const escaped = escapePowerShellSingleQuoted(wtSession)
  return [
    `# focus target wtSession='${escaped}' (process-level only; WT_SESSION is not exposed for pane-level targeting)`,
    "$p = Get-Process -Name 'WindowsTerminal' -ErrorAction SilentlyContinue | Select-Object -First 1",
    'if ($p) { (New-Object -ComObject WScript.Shell).AppActivate($p.Id) }',
  ].join('\n')
}

function desktopAppPlan(
  surface: Surface, s: SessionState, platform: NodeJS.Platform, hasCommand: (cmd: string) => boolean,
): FocusPlan {
  const app = surface.app
  if (!app) {
    return clipboardFallback(s, `Nudge has no recorded app for "${s.project}"; copied its folder path to the clipboard instead.`)
  }

  if (platform === 'darwin') {
    return { kind: 'spawn', cmd: 'osascript', args: ['-e', `tell application "${escapeAppleScriptString(app.name)}" to activate`] }
  }
  if (platform === 'win32') {
    return { kind: 'spawn', cmd: 'powershell', args: ['-NoProfile', '-Command', buildWindowsAppActivateScript(app.name)] }
  }
  if (platform === 'linux') {
    if (hasCommand('wmctrl')) return { kind: 'spawn', cmd: 'wmctrl', args: ['-a', app.name] }
    if (hasCommand('xdotool')) return { kind: 'spawn', cmd: 'xdotool', args: ['search', '--name', app.name, 'windowactivate'] }
    return clipboardFallback(s, `Neither wmctrl nor xdotool is available to focus "${app.name}" (also the known Wayland gap); copied "${s.project}"'s folder path to the clipboard instead.`)
  }
  return clipboardFallback(s, `Nudge does not know how to focus an app on platform "${platform}"; copied "${s.project}"'s folder path to the clipboard instead.`)
}

function terminalPlan(
  surface: Surface, s: SessionState, platform: NodeJS.Platform, hasCommand: (cmd: string) => boolean,
): FocusPlan {
  if (platform === 'darwin') {
    if (!surface.tty) {
      return clipboardFallback(s, `Nudge has no recorded terminal (tty) for "${s.project}"; copied its folder path to the clipboard instead.`)
    }
    const script = surface.termProgram === 'iTerm.app'
      ? buildITermFocusScript(surface.tty)
      : buildTerminalAppFocusScript(surface.tty) // Apple_Terminal, or any other macOS terminal we don't specifically recognise.
    return { kind: 'spawn', cmd: 'osascript', args: ['-e', script] }
  }
  if (platform === 'win32') {
    if (!surface.wtSession) {
      return clipboardFallback(s, `Nudge has no recorded Windows Terminal session for "${s.project}"; copied its folder path to the clipboard instead.`)
    }
    return { kind: 'spawn', cmd: 'powershell', args: ['-NoProfile', '-Command', buildWindowsTerminalFocusScript(surface.wtSession)] }
  }
  if (platform === 'linux') {
    // No tty-level match available via wmctrl/xdotool (they operate on
    // window titles, not tty device paths) — best-effort match by project
    // name instead, same as a bare terminal window would typically show in
    // its title. X11 only; a known gap on Wayland (see the class doc).
    if (hasCommand('wmctrl')) return { kind: 'spawn', cmd: 'wmctrl', args: ['-a', s.project] }
    if (hasCommand('xdotool')) return { kind: 'spawn', cmd: 'xdotool', args: ['search', '--name', s.project, 'windowactivate'] }
    return clipboardFallback(s, `Neither wmctrl nor xdotool is available (also the known Wayland gap); copied "${s.project}"'s folder path to the clipboard instead.`)
  }
  return clipboardFallback(s, `Nudge does not know how to focus a terminal on platform "${platform}"; copied "${s.project}"'s folder path to the clipboard instead.`)
}

/**
 * Pure per-surface dispatch — see the Phase 3 plan's Task 5 table for the
 * surface -> mechanism mapping this implements. `hasCommand` is injected
 * (never a real shell-out here) so this stays a plain function safe to call
 * from a test with any combination of tool availability.
 */
export function buildFocusPlan(
  s: SessionState, platform: NodeJS.Platform, hasCommand: (cmd: string) => boolean,
): FocusPlan {
  const surface = s.surface
  switch (surface.kind) {
    case 'vscode':
    case 'cursor':
    case 'windsurf':
      // argv, not a shell string: `spawn(cmd, [s.cwd])` passes `s.cwd` as a
      // single, literal process argument. There is no shell interpreting it
      // in between, so quotes/`;`/`$(...)`/backticks inside a real folder
      // name cannot break out of anything — no escaper applies here.
      return { kind: 'spawn', cmd: EDITOR_CLI[surface.kind], args: [s.cwd] }
    case 'desktop':
      return desktopAppPlan(surface, s, platform, hasCommand)
    case 'terminal':
      return terminalPlan(surface, s, platform, hasCommand)
    default:
      return clipboardFallback(s, `Nudge does not recognise where "${s.project}" is running (surface: ${surface.kind}); copied its folder path to the clipboard instead.`)
  }
}

// ---------------------------------------------------------------------------
// Execution surfaces — all lazily constructed, never touched at module load.
// ---------------------------------------------------------------------------

/** Mirrors packages/engine/src/desktop.ts's identical `Spawner` shape (duplicated, not imported — see the module doc above). */
export interface FocusSpawner { run(cmd: string, args: string[]): void }

export interface ClipboardSurface { writeText(text: string): void }

/** A minimal way to tell the user "I copied it" — never routes through Notifier (Task 4): that class exists for de-duplicated waiting-session alerts, this is a one-off informational message about the fallback itself. */
export type NotifyFn = (title: string, body: string) => void

const realSpawner: FocusSpawner = {
  run(cmd, args) {
    try {
      const p = spawn(cmd, args, { stdio: 'ignore', detached: true })
      p.on('error', () => {}) // a missing `code`/`cursor`/`osascript`/`wmctrl`/etc. must never crash the tray
      p.unref()
    } catch { /* ignore */ }
  },
}

function defaultClipboard(): ClipboardSurface {
  return { writeText: text => clipboard.writeText(text) }
}

function defaultNotify(): NotifyFn {
  return (title, body) => { new Notification({ title, body }).show() }
}

/** Real presence check for Linux's optional wmctrl/xdotool — `which` is a real binary on every mainstream Linux distro (unlike the shell builtin `command`, which `execFileSync` cannot invoke without a shell). Never called in a test — always injected. */
function defaultHasCommand(): (cmd: string) => boolean {
  return cmd => {
    try {
      execFileSync('which', [cmd], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
}

export interface FocusDeps {
  spawner?: FocusSpawner
  clipboard?: ClipboardSurface
  notify?: NotifyFn
  platform?: NodeJS.Platform
  /** Presence check for Linux's optional wmctrl/xdotool. Tests always inject this — never let it fall through to a real shell-out. */
  commandExists?: (cmd: string) => boolean
}

/**
 * Brings the right window forward for a waiting session, from OUTSIDE any
 * editor (the tray has no editor API of its own — see the Phase 3 plan's
 * Task 5 table). Dispatches on the surface fingerprint the hook recorded at
 * session start (`buildFocusPlan`), then executes exactly one of: spawn a
 * focus command, or copy the project path to the clipboard and say so.
 *
 * Critical rule, and the reason `FocusDeps` has no `send`/`ClientMessage`
 * field anywhere in it, mirroring packages/vscode/src/focus.ts's identical
 * rule: focusing is not answering. The engine keeps a session waiting until
 * Claude Code's own hook clears it; resolving here would close the history
 * row early and cancel a still-valid escalation. There is no parameter on
 * this function, and no field on `FocusDeps`, through which a caller could
 * reach the engine socket even by accident.
 */
export async function focusSession(s: SessionState, deps: FocusDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform
  const hasCommand = deps.commandExists ?? defaultHasCommand()
  const plan = buildFocusPlan(s, platform, hasCommand)

  if (plan.kind === 'spawn') {
    const spawner = deps.spawner ?? realSpawner
    spawner.run(plan.cmd, plan.args)
    return
  }

  const clipboardSurface = deps.clipboard ?? defaultClipboard()
  clipboardSurface.writeText(plan.text)
  const notify = deps.notify ?? defaultNotify()
  notify('Nudge', plan.reason)
}
