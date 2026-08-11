export type Tier = 'blocked' | 'idle-long' | 'idle-short' | 'stalled'

export type HookName =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Notification'
  | 'Stop'
  | 'SessionEnd'

export type SurfaceKind =
  | 'vscode' | 'cursor' | 'windsurf' | 'terminal' | 'desktop' | 'unknown'

export interface Surface {
  kind: SurfaceKind
  termProgram?: string
  termSessionId?: string
  tty?: string
  tmux?: boolean
  wtSession?: string
  ppid?: number
  /** Host application identified by walking the parent-process chain (SessionStart only). */
  app?: { name: string; path?: string; pid?: number }
}

/** A normalized event produced by an event source. */
export interface NudgeEvent {
  source: 'claude-code'
  sessionId: string
  hook: HookName
  cwd: string
  project: string
  message?: string
  tool?: string
  surface?: Surface
  ts: number
}

export type SessionStatus = 'running' | 'blocked' | 'idle' | 'stalled' | 'gone'

export interface SessionState {
  sessionId: string
  project: string
  cwd: string
  surface: Surface
  status: SessionStatus
  tier: Tier | null
  waitingSince: number | null
  turnStartedAt: number | null
  lastEventAt: number
  message: string | null
  snoozedUntil: number | null
  pushFailed: boolean
}

/** What a channel receives. `detail` is present only when detailLevel is 'full'. */
export interface Alert {
  sessionId: string
  project: string
  tier: Tier
  waitingSince: number
  detail?: string
}

// Frozen: this is a shared module-level singleton, and every session that
// starts without a known surface used to be assigned this exact object
// reference (see state.ts). An in-place mutation of one session's `surface`
// would then silently corrupt every other unknown-surface session, and this
// constant itself, for the lifetime of the process. Freezing turns that into
// a loud TypeError instead of a silent, hard-to-trace bug; call sites should
// spread a copy (`{ ...UNKNOWN_SURFACE }`) rather than assign this directly.
export const UNKNOWN_SURFACE: Surface = Object.freeze({ kind: 'unknown' })
