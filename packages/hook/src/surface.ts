import { execFileSync } from 'node:child_process'
import type { Surface, SurfaceKind } from '@nudge/shared/types'

const EDITORS: Record<string, SurfaceKind> = {
  vscode: 'vscode',
  cursor: 'cursor',
  windsurf: 'windsurf',
}

export function detectSurface(env: NodeJS.ProcessEnv): Surface {
  const termProgram = env.TERM_PROGRAM
  const lower = termProgram?.toLowerCase() ?? ''

  let kind: SurfaceKind = 'unknown'
  if (EDITORS[lower]) kind = EDITORS[lower]
  else if (lower.length > 0) kind = 'terminal'
  else if (env.WT_SESSION) kind = 'terminal'

  const s: Surface = { kind }
  if (termProgram) s.termProgram = termProgram
  if (env.TERM_SESSION_ID) s.termSessionId = env.TERM_SESSION_ID
  if (env.WT_SESSION) s.wtSession = env.WT_SESSION
  if (env.TMUX) s.tmux = true
  if (process.ppid) s.ppid = process.ppid
  // tty is deliberately NOT set here — see detectTtyPath's doc below for why
  // (it used to be a literal `"2"`, and getting a REAL device path costs a
  // process spawn this hot-path function must never pay for). Only
  // detectSurfaceForHook adds it, gated to SessionStart.
  return s
}

// --- Amendment: host-app detection via a bounded, injectable parent-process walk ---
//
// The Claude Code desktop app sets none of the terminal env vars detectSurface() keys
// off (TERM_PROGRAM, WT_SESSION, TMUX), so without this it always fingerprints as
// 'unknown'. This walks the parent-process chain looking for a recognisable host
// application (the desktop app, or VS Code/Cursor/Windsurf as a fallback when the
// env vars are absent). It is deliberately conservative:
//   - runs only for SessionStart (see detectSurfaceForHook below) — it must never add
//     latency to a hot-path hook like PreToolUse;
//   - wrapped in try/catch, returns undefined on any failure/timeout/missing probe —
//     a fingerprint is a nice-to-have, delivering the event is not;
//   - every probe call carries an explicit timeout, and the walk is double-bounded:
//     at most 5 hops AND an overall wall-clock deadline (see "Timing" below).

/** One hop of the parent-process chain. */
export interface ProcessInfo { ppid: number; comm: string }
export type ProcessProbe = (pid: number) => ProcessInfo | null

export const HOP_LIMIT = 5

/**
 * Timing. `execFileSync` is synchronous and blocks the event loop for up to its own
 * `timeout` option — Node kills the child and throws once that elapses, so this is
 * the real enforcement mechanism (the hook's outer 500ms "guard" backstop in bin.ts
 * cannot preempt an in-flight synchronous call; it only helps between calls).
 *
 * POSIX_HOP_TIMEOUT_MS is tightened well below the illustrative 150ms in the
 * amendment: a real `ps -p <pid>` resolves in low single-digit ms, so 60ms is
 * already 10x+ headroom for a legitimately slow (not hung) call, while keeping the
 * hard worst case (5 hops all timing out) at 300ms instead of 750ms.
 *
 * WINDOWS_HOP_TIMEOUT_MS stays closer to the amendment's suggestion because
 * spinning up `powershell` + a WMI query is inherently slower even when healthy;
 * cutting it too far would make the walk fail on ordinary Windows systems, not
 * just pathological ones.
 *
 * WALK_DEADLINE_MS is an *additional* overall wall-clock budget for the walk's own
 * local allowance. `detectHostApp`'s caller (bin.ts, via `detectSurfaceForHook`) may
 * pass a tighter, process-wide deadline instead — see the "shared deadline" note on
 * `detectHostApp` below for why a plain "check before each hop" guard was not
 * sufficient on its own and had to become "check whether this hop *can complete*
 * before the deadline."
 */
export const WALK_DEADLINE_MS = 150
export const POSIX_HOP_TIMEOUT_MS = 60
export const WINDOWS_HOP_TIMEOUT_MS = 150

/** The configured hop timeout for the current platform — POSIX `ps` or Windows `powershell`. */
function hopTimeoutForPlatform(): number {
  return process.platform === 'win32' ? WINDOWS_HOP_TIMEOUT_MS : POSIX_HOP_TIMEOUT_MS
}

/** Parses `ps -o ppid=,comm= -p <pid>` output. Exported so real captured output can be
 *  unit-tested directly, without spawning a real `ps`. Returns null, never throws, on
 *  anything malformed or empty. */
export function parsePsOutput(out: string): ProcessInfo | null {
  const m = out.trim().match(/^(\d+)\s+(.*)$/)
  if (!m) return null
  const ppid = Number(m[1])
  if (!Number.isFinite(ppid)) return null
  return { ppid, comm: m[2].trim() }
}

/** Parses the two-line `ParentProcessId` / `Name` output of the Windows probe command.
 *  Exported so the Windows branch gets real parsing coverage without a Windows machine.
 *  Returns null, never throws, on anything malformed, empty, or missing the name line. */
export function parsePowershellOutput(out: string): ProcessInfo | null {
  const lines = out.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  if (lines.length < 2) return null
  const ppid = Number(lines[0])
  if (!Number.isFinite(ppid)) return null
  return { ppid, comm: lines[1] }
}

/** Real probe: shells out to `ps` (POSIX) or `powershell` (Windows) for one pid's parent+name. */
function defaultProbe(pid: number): ProcessInfo | null {
  if (process.platform === 'win32') {
    const out = execFileSync('powershell', [
      '-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId,(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").Name`,
    ], { timeout: WINDOWS_HOP_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return parsePowershellOutput(out)
  }
  const out = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], {
    timeout: POSIX_HOP_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  })
  return parsePsOutput(out)
}

// --- Amendment (review round 1, Finding 4 — USER-APPROVED): a real tty device path ---
//
// `detectSurface()` used to store `String(process.stderr.fd)` in `surface.tty` — the
// literal `"2"` (stderr's fd NUMBER), never a device path. It looked like a real
// value and never was one: packages/tray/src/focus.ts's terminal-focus AppleScript
// compares `surface.tty` against Terminal.app/iTerm2's own `tty of t`/`tty of sess`
// property, which is always a POSIX device path (e.g. `/dev/ttys002`) — a bare "2"
// could never match that, so tty-based focus was silently dead for every session.
//
// Investigated what genuinely works on darwin (this task's actual target, though the
// mechanism is identical on Linux): there is no Node core API for `ttyname(3)`, and
// `fs.readlinkSync('/proc/self/fd/2')` (the Linux-only trick) does not apply on macOS
// at all — macOS has no /proc. `/dev/fd/2` on macOS is itself a character-special
// device node, not a symlink to one, so readlink on it fails (confirmed empirically:
// `readlink /dev/fd/2` exits 1, "Not a symlink"). `process.stderr.isTTY` only tells you
// whether fd 2 itself is a tty right now — which is frequently FALSE for a hook
// subprocess even when it is genuinely running inside a real terminal session, because
// Claude Code pipes the hook's stdio rather than inheriting the terminal's fds.
//
// What DOES work, verified empirically (see the task report for the exact transcript):
// `ps -o tty= -p <pid>` reports the process's SESSION-level controlling terminal — a
// property inherited through the process tree from the session leader (the shell
// running inside Terminal.app/iTerm2), independent of whatever fd 0/1/2 happen to be
// connected to right now. A grandchild process with stdio fully redirected to
// /dev/null, spawned from a shell running inside a real pty, still reports that pty's
// real device name via `ps -o tty=` (`ttys000`, needing a `/dev/` prefix to match what
// AppleScript's `tty of t` returns) — exactly the shape of a piped-stdio hook
// subprocess. A process with no controlling terminal at all prints `??`.
//
// Cost/safety, matching this file's existing `detectHostApp` conventions exactly:
// POSIX-only (win32 has no `ps`, and `surface.tty` is only ever read on darwin — see
// focus.ts's `terminalPlan`, so there is nothing to gain by attempting it there),
// gated to SessionStart only (wired into `detectSurfaceForHook` below, never inside
// `detectSurface` itself, so a hot-path hook like PreToolUse never pays for it),
// bounded by the SAME `POSIX_HOP_TIMEOUT_MS`/shared `deadline` the host-app walk
// already uses (a single non-looping call, so unlike the walk it cannot overshoot by
// more than one hop's timeout regardless), always wrapped, never throws.

export type TtyProbe = (pid: number) => string | null

/**
 * Parses `ps -o tty=` output into a full POSIX device path (`/dev/<name>`), or
 * `undefined` when the process has no controlling terminal (`ps` prints `?`/`??`) or
 * the output is empty/malformed. Exported so this gets real parsing coverage without
 * spawning a real `ps`, mirroring `parsePsOutput`/`parsePowershellOutput` above.
 */
export function parseTtyOutput(out: string): string | undefined {
  const name = out.trim()
  if (!name || name === '?' || name === '??') return undefined
  return `/dev/${name}`
}

/** Real probe: shells out to POSIX `ps` for one pid's controlling terminal. Never called
 *  in a test — always injected (same convention as `defaultProbe` above). */
function defaultTtyProbe(pid: number): string | null {
  return execFileSync('ps', ['-o', 'tty=', '-p', String(pid)], {
    timeout: POSIX_HOP_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  })
}

/**
 * Real controlling-terminal device path for `pid` (default: this process), e.g.
 * `/dev/ttys002` on macOS. Returns `undefined` — never throws — when there is no
 * controlling terminal, on any probe failure/timeout, on Windows (no POSIX `ps`, and
 * nothing reads `surface.tty` there anyway), or when `deadline` cannot be met (same
 * "refuse to start unless it can finish in time" rule `detectHostApp` uses, sized to
 * this being a single call rather than a loop — see the amendment above).
 */
export function detectTtyPath(
  pid: number = process.pid,
  probe: TtyProbe = defaultTtyProbe,
  deadline: number = Date.now() + POSIX_HOP_TIMEOUT_MS,
): string | undefined {
  if (process.platform === 'win32') return undefined
  if (Date.now() + POSIX_HOP_TIMEOUT_MS > deadline) return undefined
  try {
    const out = probe(pid)
    if (out === null) return undefined
    return parseTtyOutput(out)
  } catch {
    return undefined
  }
}

const HOST_APP_PATTERN = /claude|code|cursor|windsurf/i

function nameAndPath(comm: string): { name: string; path?: string } {
  if (comm.includes('/') || comm.includes('\\')) {
    const parts = comm.split(/[\\/]/).filter(Boolean)
    return { name: parts[parts.length - 1] || comm, path: comm }
  }
  return { name: comm }
}

/**
 * Walks the parent-process chain from `process.ppid` upward, at most 5 hops,
 * looking for a recognisable host application. Returns the first match, or
 * `undefined` on no match, any probe failure, or timeout. Never throws.
 *
 * `probe` defaults to the real `ps`/`powershell`-backed implementation — tests
 * must always inject a fake probe (every test in this package does); calling
 * this with no arguments from a test would spawn a real child process.
 *
 * `deadline` is an absolute `Date.now()`-style timestamp, not a duration. The
 * caller (bin.ts, via `detectSurfaceForHook`) is expected to pass a value derived
 * from its own process-wide budget, so a slow `readStdin` shortens the walk
 * rather than the walk adding on top of an already-spent budget. Defaults to
 * `Date.now() + WALK_DEADLINE_MS` for direct/standalone callers (e.g. tests that
 * don't care about a wider budget).
 *
 * Fix (review round 1): the previous guard checked `Date.now() >= deadline`
 * *before* starting a hop, which only stops the walk from starting a hop once
 * the deadline has already passed — it does nothing to stop a hop that starts
 * just before the deadline and then runs its own full `timeout` on top,
 * overshooting by up to one hop's timeout. Since `execFileSync` is synchronous
 * and cannot be preempted once started, the only way to make the overshoot
 * structurally impossible (not just unlikely) is to refuse to *start* a hop
 * unless it can complete, in its own worst case, before the deadline.
 */
export function detectHostApp(
  probe: ProcessProbe = defaultProbe,
  deadline: number = Date.now() + WALK_DEADLINE_MS,
): Surface['app'] | undefined {
  const hopTimeout = hopTimeoutForPlatform()
  try {
    let pid = process.ppid
    for (let hop = 0; hop < HOP_LIMIT; hop++) {
      if (!pid || pid <= 1) return undefined
      // Only start a hop if it can finish, in its own worst case, before the
      // deadline — not merely "the deadline hasn't passed yet."
      if (Date.now() + hopTimeout > deadline) return undefined

      const info = probe(pid)
      if (!info) return undefined

      if (HOST_APP_PATTERN.test(info.comm)) {
        const { name, path } = nameAndPath(info.comm)
        return path ? { name, path, pid } : { name, pid }
      }
      pid = info.ppid
    }
    return undefined
  } catch {
    return undefined
  }
}

function kindFromAppName(name: string): SurfaceKind | null {
  if (/claude/i.test(name)) return 'desktop'
  if (/code/i.test(name)) return 'vscode'
  if (/cursor/i.test(name)) return 'cursor'
  if (/windsurf/i.test(name)) return 'windsurf'
  return null
}

/**
 * Combines env-based surface detection with the host-app process walk. The walk
 * only ever runs for `SessionStart` — every other hook (including `PreToolUse`,
 * which fires on every single tool call) returns immediately, before `probe` is
 * ever invoked, so it can never add latency to the hot path.
 *
 * Precedence: an env-var match always wins. The walk only fills in `kind` when
 * the env vars left it 'unknown'; it always populates `app` when it finds a
 * match, regardless of what `kind` ended up being.
 *
 * `deadline` (an absolute `Date.now()`-style timestamp) is forwarded to
 * `detectHostApp` as-is; see its doc comment for why the caller should derive
 * this from a process-wide budget rather than a fresh local one.
 *
 * `ttyProbe`/the real tty lookup (Finding 4) rides the exact same gate and the
 * exact same shared `deadline` as the host-app walk — both are SessionStart-only,
 * both cost a real process spawn, and running the tty probe FIRST means a slow
 * `readStdin` upstream (bin.ts) shortens what's left for the walk, not the other
 * way around, consistent with this whole file's "a slow phase shortens what's left
 * for the phases after it" rule (see bin.ts's DEADLINE doc for the same principle
 * one layer up).
 */
export function detectSurfaceForHook(
  hook: string,
  env: NodeJS.ProcessEnv,
  probe: ProcessProbe = defaultProbe,
  deadline: number = Date.now() + WALK_DEADLINE_MS,
  ttyProbe: TtyProbe = defaultTtyProbe,
): Surface {
  const surface = detectSurface(env)
  if (hook !== 'SessionStart') return surface

  const tty = detectTtyPath(process.pid, ttyProbe, deadline)
  if (tty) surface.tty = tty

  const app = detectHostApp(probe, deadline)
  if (!app) return surface

  surface.app = app
  if (surface.kind === 'unknown') {
    const kind = kindFromAppName(app.name)
    if (kind) surface.kind = kind
  }
  return surface
}
