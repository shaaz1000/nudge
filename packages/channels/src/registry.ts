import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { channelsDir } from '@nudge/shared/paths'
import { ntfyChannel } from './ntfy.js'
import { isChannel, type Channel } from './types.js'

export type { Channel } from './types.js'
export { ntfyChannel } from './ntfy.js'

export function builtinChannels(): Channel[] {
  return [ntfyChannel]
}

/**
 * Built-ins plus anything in ~/.nudge/channels/*.js. A user file may override a
 * built-in by reusing its id. A broken file is skipped, never fatal — a bad
 * third-party adapter must not stop local alerting.
 */
export async function loadChannels(dir = channelsDir()): Promise<Map<string, Channel>> {
  const map = new Map<string, Channel>()
  for (const c of builtinChannels()) map.set(c.id, c)

  let files: string[]
  try {
    files = (await readdir(dir)).filter(f => f.endsWith('.js') || f.endsWith('.mjs'))
  } catch {
    return map
  }

  for (const f of files) {
    try {
      const mod = await import(pathToFileURL(join(dir, f)).href)
      const candidate = mod.default
      if (isChannel(candidate)) map.set(candidate.id, candidate)
    } catch {
      // Skip silently; `nudge status` surfaces the count of loaded channels.
    }
  }
  return map
}
