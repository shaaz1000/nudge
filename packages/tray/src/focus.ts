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
// Terminal.app/iTerm2, Windows Terminal, Linux) but only THREE of them ever
// interpolate a value into a script string that a shell-like interpreter
// (osascript, powershell) will parse — AppleScript (desktop-app-by-name,
// Terminal.app/iTerm2-by-tty, and the Terminal.app/iTerm2 no-match fallback's
// clipboard/notification text) and PowerShell (desktop-app-by-name on
// Windows only). Every other branch (the editor CLIs, Linux's
// wmctrl/xdotool, and — as of the fix below — Windows-Terminal-by-wtSession)
// passes its value as a single argv element to `spawn()` with no shell in
// between, or never embeds the value in a script at all, so no escaper
// applies (see `buildFocusPlan`'s editor-CLI branch for exactly this note).
// The two escapers that DO exist are named for the language they target,
// not the surface, and are never swapped between each other.
//
// --- Review round 1, Finding 1 (CRITICAL) ---
// `buildWindowsTerminalFocusScript` used to interpolate `wtSession` into a
// `#`-comment line, escaped with `escapePowerShellSingleQuoted`. That
// escaper's contract (see its doc below) only covers a value placed INSIDE a
// single-quoted string literal — it doubles `'` and does nothing about
// `\r`/`\n`. A `#` comment ends at the line break, not at the string's
// closing quote, so `wtSession = 'abc\nStart-Process calc.exe #'` emitted a
// SECOND, live, executable PowerShell line — the escaper's guarantee was
// silently violated by this usage context (a comment, not a string literal).
// This is the exact category of bug this module's whole doc comment above
// exists to prevent, just with the escaper/context pairing right this time
// and the injection vector being where the value LANDS (a comment) rather
// than which escaper was used. Fixed by no longer interpolating `wtSession`
// into the script at all — see `buildWindowsTerminalFocusScript`'s own doc.
// ---------------------------------------------------------------------------

/**
 * AppleScript double-quoted string literal. Backslash first, then double
 * quote — reversing the order would double-escape a literal backslash.
 * Deliberately duplicated from (not imported from) packages/engine/src/
 * desktop.ts's identical function: packages/engine is out of this task's
 * scope, and this is a tiny, self-contained pure function.
 */
export function escapeAppleScriptString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    // AppleScript string literals cannot span a line break: a raw CR or LF
    // inside "…" is a COMPILE error that kills the ENTIRE script, not just
    // one line. `osascript`'s output is discarded (`stdio: 'ignore'`), so the
    // failure is completely silent — no window focused, and not even the
    // clipboard fallback, because that fallback lives in the same script.
    //
    // Reachable without an attacker: `s.cwd` and `s.project` flow into these
    // literals and a POSIX directory name may legally contain a newline.
    // `\r`/`\n` are AppleScript's own escapes, so the text survives intact.
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    // The remaining C0 controls have no AppleScript escape and would also
    // break the literal; drop them rather than emit a script that cannot
    // compile.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
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

/**
 * Builds the AppleScript source shared by the Terminal.app and iTerm2
 * branches: search for the exact recorded tty, then either focus it or fall
 * back — entirely within this one script, since it is spawned fire-and-forget
 * (see `realSpawner`) with nothing on the JS side ever inspecting its result.
 *
 * Review round 1, Finding 3: two problems in the old scripts, both fixed here:
 *   1. `tty of t contains "<value>"` substring-matched, so a single-digit
 *      tty (or any value that happens to be a substring of a real device
 *      path, e.g. "2" inside "/dev/ttys002") could match the WRONG tab and
 *      focus it — landing somewhere wrong rather than failing honestly.
 *      Fixed by exact comparison (`is`, not `contains`).
 *   2. Both scripts called `activate` unconditionally BEFORE searching, so
 *      the app came forward even on a total non-match. Fixed by moving
 *      `activate` inside the matched branch — it now only runs when a tab
 *      was actually found.
 *   Because `activate` no longer fires unconditionally, a non-match must do
 *   SOMETHING visible instead of silently leaving the terminal wherever it
 *   was ("failing visibly beats landing somewhere wrong") — so `matched`
 *   tracks whether the nested search succeeded, and the no-match branch
 *   copies the project's folder path to the clipboard and shows a
 *   notification, mirroring `clipboardFallback`'s own UX for every other
 *   "nothing to focus" case in this module. `cwd`/`reason` are interpolated
 *   into this same AppleScript, so — new as of this fix, since neither was
 *   ever embedded in a script before — they go through
 *   `escapeAppleScriptString` too, not just `tty`.
 */
function terminalNoMatchScript(s: SessionState, cwdEscaped: string): string[] {
  const reason = escapeAppleScriptString(
    `Nudge could not find the recorded terminal tab for "${s.project}" (it may have been closed); copied its folder path to the clipboard instead.`,
  )
  return [
    'if not matched then',
    `  set the clipboard to "${cwdEscaped}"`,
    `  display notification "${reason}" with title "Nudge"`,
    'end if',
  ]
}

function buildTerminalAppFocusScript(s: SessionState, tty: string): string {
  const t = escapeAppleScriptString(tty)
  const cwd = escapeAppleScriptString(s.cwd)
  return [
    'set matched to false',
    'tell application "Terminal"',
    '  repeat with w in windows',
    '    repeat with t in tabs of w',
    `      if tty of t is "${t}" then`,
    '        activate',
    '        set frontmost of w to true',
    '        set selected tab of w to t',
    '        set matched to true',
    '        exit repeat',
    '      end if',
    '    end repeat',
    '    if matched then exit repeat',
    '  end repeat',
    'end tell',
    ...terminalNoMatchScript(s, cwd),
  ].join('\n')
}

function buildITermFocusScript(s: SessionState, tty: string): string {
  const t = escapeAppleScriptString(tty)
  const cwd = escapeAppleScriptString(s.cwd)
  return [
    'set matched to false',
    'tell application "iTerm2"',
    '  repeat with w in windows',
    '    repeat with tb in tabs of w',
    '      repeat with sess in sessions of tb',
    `        if tty of sess is "${t}" then`,
    '          activate',
    '          select tb',
    '          select w',
    '          set matched to true',
    '          exit repeat',
    '        end if',
    '      end repeat',
    '      if matched then exit repeat',
    '    end repeat',
    '    if matched then exit repeat',
    '  end repeat',
    'end tell',
    ...terminalNoMatchScript(s, cwd),
  ].join('\n')
}

function buildWindowsAppActivateScript(name: string): string {
  return `(New-Object -ComObject WScript.Shell).AppActivate('${escapePowerShellSingleQuoted(name)}')`
}

/**
 * Best-effort only: `WT_SESSION` identifies one specific pane/tab, but
 * Windows Terminal exposes no public window property carrying it, so there
 * is no way to select that exact pane from outside the process — only the
 * process itself can be brought to the foreground.
 *
 * Fix (review round 1, Finding 1 — CRITICAL): this used to interpolate
 * `wtSession` into the script as a `#`-comment line via
 * `escapePowerShellSingleQuoted`. That escaper's contract only covers a
 * value placed INSIDE a single-quoted string literal (see its doc) — a `#`
 * comment ends at the line break, not the string's closing quote, so a
 * `wtSession` containing a real newline (e.g.
 * `"abc\nStart-Process calc.exe #"`) broke out of the comment and became a
 * second, live, executable PowerShell line. `wtSession` was never live logic
 * here — the old comment said so itself — only ever echoed for a future
 * maintainer's benefit, so the simplest CORRECT fix is to stop interpolating
 * it into the script at all. Presence/absence of `surface.wtSession` is
 * still what `terminalPlan` uses to decide whether this branch (vs. the
 * clipboard fallback) applies at all — only the VALUE is no longer threaded
 * into the script text. If a future revision finds a real per-pane API to
 * target, thread `wtSession` through as a plain value the script's own
 * control flow branches on (still never string-interpolated), not back into
 * a comment.
 */
function buildWindowsTerminalFocusScript(): string {
  return [
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
      ? buildITermFocusScript(s, surface.tty)
      : buildTerminalAppFocusScript(s, surface.tty) // Apple_Terminal, or any other macOS terminal we don't specifically recognise.
    return { kind: 'spawn', cmd: 'osascript', args: ['-e', script] }
  }
  if (platform === 'win32') {
    if (!surface.wtSession) {
      return clipboardFallback(s, `Nudge has no recorded Windows Terminal session for "${s.project}"; copied its folder path to the clipboard instead.`)
    }
    // surface.wtSession's presence is still what gates this branch — see
    // buildWindowsTerminalFocusScript's doc for why its VALUE is no longer
    // threaded into the script (Finding 1).
    return { kind: 'spawn', cmd: 'powershell', args: ['-NoProfile', '-Command', buildWindowsTerminalFocusScript()] }
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
    case 'windsurf': {
      // argv, not a shell string: `spawn(cmd, [s.cwd])` passes `s.cwd` as a
      // single, literal process argument. There is no shell interpreting it
      // in between, so quotes/`;`/`$(...)`/backticks inside a real folder
      // name cannot break out of anything — no escaper applies here.
      const cli = EDITOR_CLI[surface.kind]
      // Presence-checked like the Linux branches below, and for a more common
      // reason than they have: on macOS the `code` CLI is absent from PATH
      // until the user runs "Shell Command: Install 'code' command in PATH",
      // and on Windows it is `code.cmd`, which Node's `spawn` will not
      // execute without a shell. In both cases the spawn fails into a
      // swallowed `'error'` event, so clicking the notification — the
      // headline interaction of this whole phase — did nothing whatsoever:
      // no window, no clipboard copy, no message. The clipboard fallback
      // exists for exactly this case and was simply never reached.
      if (!hasCommand(cli)) {
        return clipboardFallback(
          s,
          `Nudge could not find the "${cli}" command, so it could not open "${s.project}" for you. `
          + 'Run "Shell Command: Install \'code\' command in PATH" from the editor\'s command palette. '
          + 'The folder path is on your clipboard.',
        )
      }
      return { kind: 'spawn', cmd: cli, args: [s.cwd] }
    }
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
