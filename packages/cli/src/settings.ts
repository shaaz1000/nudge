import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { claudeSettingsPath } from '@nudge/shared/paths'

/** Every hook Nudge installs carries this marker so uninstall is exact. */
export const NUDGE_MARK = 'nudge-hook'

const HOOKS_WITH_MATCHER = ['PreToolUse', 'PostToolUse'] as const
const ALL_HOOKS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse',
  'PostToolUse', 'Notification', 'Stop', 'SessionEnd',
] as const

interface HookEntry { matcher?: string; hooks: Array<{ type: string; command: string }> }

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isNudgeEntry(e: unknown): boolean {
  return isObj(e) && Array.isArray(e.hooks)
    && e.hooks.some(h => isObj(h) && typeof h.command === 'string' && h.command.includes(NUDGE_MARK))
}

function entryFor(hook: string, command: string): HookEntry {
  const e: HookEntry = { hooks: [{ type: 'command', command }] }
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
  const dest = `${path}.nudge-backup-${stamp}`
  copyFileSync(path, dest)
  return dest
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, 'utf8')
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

export function applySetup(opts: { command: string; dryRun: boolean; path?: string }): {
  added: number; backup: string | null; diff: string
} {
  const path = opts.path ?? claudeSettingsPath()
  const existing = readSettings(path)
  const { merged, added } = mergeHooks(existing, opts.command)

  const diff = [
    `--- ${path} (current)`,
    `+++ ${path} (after setup)`,
    ...ALL_HOOKS.map(h => `+ hooks.${h}[]  ->  ${opts.command}`),
  ].join('\n')

  if (opts.dryRun) return { added, backup: null, diff }

  const backup = backupSettings(path)
  const serialized = JSON.stringify(merged, null, 2) + '\n'
  JSON.parse(serialized)   // validate before it ever reaches disk
  writeFileSync(path, serialized, 'utf8')
  return { added, backup, diff }
}
