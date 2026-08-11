import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { claudeSettingsPath } from '@nudge/shared/paths'
import { SUBSCRIBED } from '@nudge/shared/normalize'

/**
 * Historical/informational marker — the real installed command naturally
 * contains this (the hook package's bin is literally named `nudge-hook`).
 * It is NOT used to identify Nudge's own entries; see `_nudge` below. Text
 * a user fully controls (their own hook command) must never be what decides
 * whether Nudge is allowed to overwrite or delete an entry.
 */
export const NUDGE_MARK = 'nudge-hook'

/** Schema version stamped on every entry Nudge owns, for future migrations. */
const NUDGE_SCHEMA_VERSION = 1

const HOOKS_WITH_MATCHER = ['PreToolUse', 'PostToolUse'] as const
/**
 * The set of hooks setup writes entries for. This used to be a third,
 * independent copy of the same seven-hook list carried by
 * packages/hook/src/bin.ts and packages/engine/src/normalize.ts (finding
 * I5) — now all three read the one list @nudge/shared exports.
 */
const ALL_HOOKS = SUBSCRIBED

interface HookEntry {
  matcher?: string
  hooks: Array<{ type: string; command: string }>
  _nudge: number
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Identifies Nudge's own entry by the `_nudge` key Nudge itself writes —
 * never by inspecting the user-controlled `command` text. A user hook that
 * happens to mention "nudge-hook" in its own command must not be mistaken
 * for ours; only a key we own can prove ownership.
 */
function isNudgeEntry(e: unknown): boolean {
  return isObj(e) && typeof e._nudge === 'number'
}

function entryFor(hook: string, command: string): HookEntry {
  const e: HookEntry = { hooks: [{ type: 'command', command }], _nudge: NUDGE_SCHEMA_VERSION }
  if ((HOOKS_WITH_MATCHER as readonly string[]).includes(hook)) e.matcher = '*'
  return e
}

export function hookEntriesFor(command: string): Record<string, HookEntry[]> {
  const out: Record<string, HookEntry[]> = {}
  for (const h of ALL_HOOKS) out[h] = [entryFor(h, command)]
  return out
}

/**
 * Append-only merge. Never rewrites a key it did not create; an existing Nudge
 * entry is updated in place so a moved install path does not leave a stale one.
 */
export function mergeHooks(existing: unknown, command: string): {
  merged: Record<string, unknown>; added: number
} {
  if (!isObj(existing)) throw new Error('settings.json: top level must be an object')

  const merged = structuredClone(existing) as Record<string, unknown>
  const hooks: Record<string, unknown[]> = isObj(merged.hooks)
    ? structuredClone(merged.hooks) as Record<string, unknown[]>
    : {}

  let added = 0
  for (const name of ALL_HOOKS) {
    const list = Array.isArray(hooks[name]) ? [...hooks[name]] : []
    const idx = list.findIndex(isNudgeEntry)
    const wanted = entryFor(name, command)
    if (idx === -1) { list.push(wanted); added++ }
    else if (JSON.stringify(list[idx]) !== JSON.stringify(wanted)) { list[idx] = wanted }
    hooks[name] = list
  }

  merged.hooks = hooks
  return { merged, added }
}

export function removeHooks(existing: unknown): {
  merged: Record<string, unknown>; removed: number
} {
  if (!isObj(existing)) throw new Error('settings.json: top level must be an object')
  const merged = structuredClone(existing) as Record<string, unknown>
  if (!isObj(merged.hooks)) return { merged, removed: 0 }

  const hooks = structuredClone(merged.hooks) as Record<string, unknown[]>
  let removed = 0

  for (const [name, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) continue
    const kept = list.filter(e => { const drop = isNudgeEntry(e); if (drop) removed++; return !drop })
    if (kept.length === 0) delete hooks[name]
    else hooks[name] = kept
  }

  if (Object.keys(hooks).length === 0) delete merged.hooks
  else merged.hooks = hooks

  return { merged, removed }
}

export function backupSettings(path = claudeSettingsPath()): string | null {
  if (!existsSync(path)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  // A short random suffix keeps two backups in the same millisecond from
  // silently overwriting one another.
  const suffix = randomBytes(3).toString('hex')
  const dest = `${path}.nudge-backup-${stamp}-${suffix}`
  copyFileSync(path, dest)
  return dest
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    throw new Error(
      `Refusing to touch ${path}: could not read it (${(err as Error).message}). ` +
      `Check file permissions, then re-run setup.`,
    )
  }

  try {
    const parsed = JSON.parse(raw)
    if (!isObj(parsed)) throw new Error('not an object')
    return parsed
  } catch (err) {
    throw new Error(
      `Refusing to touch ${path}: could not parse it as JSON (${(err as Error).message}). ` +
      `Fix or move the file, then re-run setup.`,
    )
  }
}

/** True when `existing` already has a Nudge-owned entry under this hook name. */
function hasNudgeEntry(existing: Record<string, unknown>, name: string): boolean {
  const hooks = isObj(existing.hooks) ? existing.hooks as Record<string, unknown> : {}
  const list = Array.isArray(hooks[name]) ? hooks[name] as unknown[] : []
  return list.some(isNudgeEntry)
}

export function applySetup(opts: { command: string; dryRun: boolean; path?: string }): {
  added: number; backup: string | null; diff: string
} {
  const path = opts.path ?? claudeSettingsPath()
  const existing = readSettings(path)
  const { merged, added } = mergeHooks(existing, opts.command)

  // Distinguish a genuine addition from an overwrite of Nudge's own existing
  // entry (e.g. the install path moved) — both look identical if we only
  // ever print "+", which hides a real change from the user before they
  // commit to it.
  const diff = [
    `--- ${path} (current)`,
    `+++ ${path} (after setup)`,
    ...ALL_HOOKS.map(h => hasNudgeEntry(existing, h)
      ? `~ hooks.${h}[]  (updating existing Nudge entry)  ->  ${opts.command}`
      : `+ hooks.${h}[]  ->  ${opts.command}`),
  ].join('\n')

  if (opts.dryRun) return { added, backup: null, diff }

  const backup = backupSettings(path)
  const serialized = JSON.stringify(merged, null, 2) + '\n'
  JSON.parse(serialized)   // validate before it ever reaches disk
  writeFileSync(path, serialized, 'utf8')
  return { added, backup, diff }
}
