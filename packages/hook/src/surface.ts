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
  try {
    const tty = process.stderr.isTTY ? String(process.stderr.fd) : undefined
    if (tty) s.tty = tty
  } catch { /* ignore */ }
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

const HOP_LIMIT = 5

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
 * WALK_DEADLINE_MS is an *additional* overall wall-clock budget, checked before
 * starting each hop. It doesn't shrink an in-flight call, but it does stop the
 * walk from *starting* further hops once time is up — on Windows this caps the
 * walk to effectively one attempt in the worst case (150ms), and on POSIX to about
 * three (180ms), well inside the hook's 500ms budget even before the read/send
 * halves are added. See task-16-report.md's timing analysis for the full
 * worst-case trace.
 */
const WALK_DEADLINE_MS = 150
const POSIX_HOP_TIMEOUT_MS = 60
const WINDOWS_HOP_TIMEOUT_MS = 150

function parsePsOutput(out: string): ProcessInfo | null {
  const m = out.trim().match(/^(\d+)\s+(.*)$/)
  if (!m) return null
  const ppid = Number(m[1])
  if (!Number.isFinite(ppid)) return null
  return { ppid, comm: m[2].trim() }
}

function parsePowershellOutput(out: string): ProcessInfo | null {
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
 * `probe` is injectable so tests never spawn a real `ps`/`powershell`.
 */
export function detectHostApp(probe: ProcessProbe = defaultProbe): Surface['app'] | undefined {
  const deadline = Date.now() + WALK_DEADLINE_MS
  try {
    let pid = process.ppid
    for (let hop = 0; hop < HOP_LIMIT; hop++) {
      if (!pid || pid <= 1) return undefined
      if (Date.now() >= deadline) return undefined

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
 */
export function detectSurfaceForHook(
  hook: string,
  env: NodeJS.ProcessEnv,
  probe: ProcessProbe = defaultProbe,
): Surface {
  const surface = detectSurface(env)
  if (hook !== 'SessionStart') return surface

  const app = detectHostApp(probe)
  if (!app) return surface

  surface.app = app
  if (surface.kind === 'unknown') {
    const kind = kindFromAppName(app.name)
    if (kind) surface.kind = kind
  }
  return surface
}
