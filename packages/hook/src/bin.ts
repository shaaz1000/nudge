#!/usr/bin/env node
/**
 * Invoked by Claude Code on every subscribed hook.
 *
 * Three inviolable rules, each covered by a test in test/bin.test.ts:
 *   1. finish within 500ms
 *   2. always exit 0
 *   3. never write to stdout
 * A notifier that can stall or break the agent is worse than no notifier.
 */
import { basename } from 'node:path'
import { spawn } from 'node:child_process'
import { encode } from '@nudge/shared/protocol'
import type { HookName, NudgeEvent } from '@nudge/shared/types'
import { readStdin } from './read-stdin.js'
import { detectSurfaceForHook, WALK_DEADLINE_MS } from './surface.js'
import { sendEvent } from './send.js'
import { spoolEvent } from './spool.js'

const BUDGET_MS = 500

// Captured once, at the very top: every phase below draws its own timeout from
// whatever's left of this single process-wide budget, rather than each phase
// getting its own fixed allowance that can add on top of the others.
//
// Fix (review round 1): the original design gave readStdin and sendEvent
// BUDGET_MS/2 (250ms) each — 500ms before the SessionStart walk cost anything —
// and gave the walk its own separate ~150ms deadline on top. Tightening the
// walk's own numbers could not fix that; the three phases' allowances summed to
// more than the budget by construction. A slow phase must now shorten what's
// left for the phases after it, not add to the total.
const DEADLINE = Date.now() + BUDGET_MS
/** Milliseconds left until DEADLINE, floored at 1 so a downstream setTimeout
 *  never gets called with 0 or a negative timeout. */
const remaining = () => Math.max(1, DEADLINE - Date.now())
/** The largest allowance readStdin/sendEvent may claim on their own even when
 *  the full budget is still available, so neither phase can starve the other
 *  two on a run where nothing has actually gone wrong yet. */
const PHASE_CAP_MS = BUDGET_MS / 2

const SUBSCRIBED: readonly HookName[] = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse',
  'PostToolUse', 'Notification', 'Stop', 'SessionEnd',
]

// Backstop: exit 0 no matter what, even if something below hangs unexpectedly.
// With the shared deadline above, this should be genuinely unreachable in
// normal operation — a backstop, not a silent extension of the budget.
const guard = setTimeout(() => process.exit(0), BUDGET_MS + 200)
guard.unref?.()

function buildEvent(raw: string): NudgeEvent | null {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  if (typeof parsed !== 'object' || parsed === null) return null

  const p = parsed as Record<string, unknown>
  const hook = p.hook_event_name
  const sessionId = p.session_id
  const cwd = p.cwd
  if (typeof hook !== 'string' || !SUBSCRIBED.includes(hook as HookName)) return null
  if (typeof sessionId !== 'string' || typeof cwd !== 'string') return null

  const ev: NudgeEvent = {
    source: 'claude-code',
    sessionId,
    hook: hook as HookName,
    cwd,
    project: basename(cwd.replace(/[\/\\]+$/, '')) || cwd,
    ts: Date.now(),
  }
  if (typeof p.message === 'string' && p.message.length > 0) ev.message = p.message
  if (typeof p.tool_name === 'string' && p.tool_name.length > 0) ev.tool = p.tool_name
  // detectSurfaceForHook gates the host-app process walk on the hook name itself,
  // so PreToolUse (and every other non-SessionStart hook) never pays for it. The
  // walk's own deadline is the sooner of its local WALK_DEADLINE_MS allowance and
  // whatever's left of the process-wide DEADLINE, so a slow readStdin above
  // shortens the walk rather than the walk adding to an already-spent budget.
  if (ev.hook === 'SessionStart') {
    const walkDeadline = Math.min(Date.now() + WALK_DEADLINE_MS, DEADLINE)
    ev.surface = detectSurfaceForHook(ev.hook, process.env, undefined, walkDeadline)
  }
  return ev
}

function trySpawnEngine(): void {
  if (process.env.NUDGE_NO_SPAWN === '1') return
  try {
    const child = spawn(process.execPath, [new URL('../../engine/dist/bin.js', import.meta.url).pathname], {
      detached: true, stdio: 'ignore',
    })
    child.on('error', () => {})
    child.unref()
  } catch { /* ignore */ }
}

async function main(): Promise<void> {
  const raw = await readStdin(Math.min(PHASE_CAP_MS, remaining()))
  const ev = buildEvent(raw)

  if (ev) {
    const payload = encode({ t: 'event', event: ev })
    const ok = await sendEvent(payload, Math.min(PHASE_CAP_MS, remaining()))
    if (!ok) {
      spoolEvent(payload)
      trySpawnEngine()
    }
  }
}

// Every sub-step already guards its own failures (readStdin/sendEvent resolve
// rather than reject; buildEvent/detectSurfaceForHook/detectHostApp swallow their
// own errors). This try/catch is defense in depth against anything that slips
// through regardless — a thrown error or a rejected promise here must still end
// in exit 0, never a crash with a non-zero code.
try {
  await main()
} catch {
  /* the hook must never fail the session */
} finally {
  process.exit(0)
}
