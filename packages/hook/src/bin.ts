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
import { detectSurfaceForHook } from './surface.js'
import { sendEvent } from './send.js'
import { spoolEvent } from './spool.js'

const BUDGET_MS = 500
const SUBSCRIBED: readonly HookName[] = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse',
  'PostToolUse', 'Notification', 'Stop', 'SessionEnd',
]

// Backstop: exit 0 no matter what, even if something below hangs unexpectedly.
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
  // so PreToolUse (and every other non-SessionStart hook) never pays for it.
  if (ev.hook === 'SessionStart') ev.surface = detectSurfaceForHook(ev.hook, process.env)
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
  const raw = await readStdin(BUDGET_MS / 2)
  const ev = buildEvent(raw)

  if (ev) {
    const payload = encode({ t: 'event', event: ev })
    const ok = await sendEvent(payload, BUDGET_MS / 2)
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
