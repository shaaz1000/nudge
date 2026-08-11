import { basename } from 'node:path'
import type { HookName, NudgeEvent, Surface } from './types.js'

/**
 * The seven Claude Code hooks Nudge subscribes to. This is the single source
 * of truth — `normalize()` below, the hook binary's `buildEvent`, and
 * `cli/src/settings.ts`'s settings.json writer all import this one list
 * rather than keeping their own copies in sync by hand.
 */
export const SUBSCRIBED: readonly HookName[] = [
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
 * the caller drops nulls silently rather than failing a session's hook.
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

/**
 * Type guard for an already-built `NudgeEvent` arriving over the engine's
 * wire protocol (`{ t: 'event', event: ... }`). Unlike `normalize()` above —
 * which builds a NudgeEvent from a *raw* Claude Code hook payload
 * (`hook_event_name`, `session_id`, ...) — this checks a value that already
 * claims to be a finished NudgeEvent (`hook`, `sessionId`, ...), the shape
 * `EngineServer` receives from a socket client.
 *
 * `EngineServer` casts every decoded wire message to `ClientMessage` (see
 * `protocol.ts`) without runtime verification, so a version-skewed hook, a
 * corrupted spool file, or any other client on the socket can hand the
 * engine an `event` field that is missing fields, has the wrong types, or
 * isn't an object at all. `ts` in particular flows straight into a SQLite
 * bound parameter (`Db.recordEvent`) — a non-number there throws and, unless
 * guarded, takes the whole daemon down with it. This guard is the fix.
 *
 * Finding I10: this used to check only `hook`, `sessionId`, `cwd`, `project`
 * and `ts` — not the three *optional* string fields, `message`, `tool` and
 * `source`. An event with e.g. `message: {evil:true}` passed validation,
 * reached `SessionStore#apply` and got applied to the session (it now shows
 * up with `tier: "blocked"`), and only then hit `Db.recordEvent`'s SQLite
 * bind for `message` and threw `TypeError: Provided value cannot be bound to
 * SQLite parameter 6`. `Engine#handle`'s caller-side try/catch (server.ts)
 * stops that throw from taking the daemon down, but `handle()` throws *after*
 * `store.apply()` and *before* `#applyTransition`/`broadcast`, so the session
 * is left mutated in the store with no wait row opened and no escalation
 * ladder armed — a silently orphaned "blocked" session, the exact class of
 * bug the TTL fix (I1) exists to clean up after, not prevent in the first
 * place. Each of these three fields is optional (absent is still valid) but,
 * when present, must be a string like every other field here.
 */
export function isValidEvent(v: unknown): v is NudgeEvent {
  if (!isObj(v)) return false
  const hook = v.hook
  if (typeof hook !== 'string' || !SUBSCRIBED.includes(hook as HookName)) return false
  if (!str(v.sessionId)) return false
  if (!str(v.cwd)) return false
  if (!str(v.project)) return false
  if (typeof v.ts !== 'number' || !Number.isFinite(v.ts)) return false
  if (v.message !== undefined && typeof v.message !== 'string') return false
  if (v.tool !== undefined && typeof v.tool !== 'string') return false
  if (v.source !== undefined && typeof v.source !== 'string') return false
  return true
}
