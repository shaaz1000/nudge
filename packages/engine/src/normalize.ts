import { basename } from 'node:path'
import type { HookName, NudgeEvent, Surface } from '@nudge/shared/types'

const SUBSCRIBED: readonly HookName[] = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse',
  'PostToolUse', 'Notification', 'Stop', 'SessionEnd',
]

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** Strip trailing separators so `/a/b/repo/` and `/a/b/repo` agree. */
function projectOf(cwd: string): string {
  return basename(cwd.replace(/[\/\\]+$/, '')) || cwd
}

/**
 * Convert a raw Claude Code hook payload into a NudgeEvent.
 * Returns null for anything we do not subscribe to or cannot identify —
 * the engine drops nulls silently rather than failing a session's hook.
 */
export function normalize(raw: unknown, surface: Surface | undefined, ts: number): NudgeEvent | null {
  if (!isObj(raw)) return null

  const hook = str(raw.hook_event_name) as HookName | undefined
  if (!hook || !SUBSCRIBED.includes(hook)) return null

  const sessionId = str(raw.session_id)
  const cwd = str(raw.cwd)
  if (!sessionId || !cwd) return null

  const ev: NudgeEvent = {
    source: 'claude-code',
    sessionId,
    hook,
    cwd,
    project: projectOf(cwd),
    ts,
  }

  const message = str(raw.message)
  if (message) ev.message = message

  const tool = str(raw.tool_name)
  if (tool) ev.tool = tool

  // The surface fingerprint is only meaningful at session start; carrying it
  // on every event would bloat the wire format for no gain.
  if (hook === 'SessionStart' && surface) ev.surface = surface

  return ev
}
