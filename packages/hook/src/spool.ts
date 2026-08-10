import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spoolDir } from '@nudge/shared/paths'

/** Last resort when the engine is unreachable. Must never throw. */
export function spoolEvent(raw: string, dir = spoolDir()): void {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${Date.now()}-${randomUUID()}.json`), raw, 'utf8')
  } catch { /* the hook must never fail the session */ }
}
