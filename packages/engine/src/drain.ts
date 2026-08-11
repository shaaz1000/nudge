import { readdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { NudgeEvent } from '@nudge/shared/types'
import { spoolDir } from '@nudge/shared/paths'

/**
 * Replays events the hook spooled while the engine was down, oldest first so
 * the state machine sees a coherent sequence. Every file is removed whether or
 * not it parsed — a poison file must not wedge the drain on every boot.
 */
export async function drainSpool(
  handle: (ev: NudgeEvent) => void,
  dir = spoolDir(),
): Promise<number> {
  let files: string[]
  try {
    files = (await readdir(dir)).filter(f => f.endsWith('.json'))
  } catch {
    return 0
  }

  const parsed: NudgeEvent[] = []
  for (const f of files) {
    const path = join(dir, f)
    try {
      const raw = await readFile(path, 'utf8')
      const msg = JSON.parse(raw) as { t?: string; event?: NudgeEvent }
      if (msg?.t === 'event' && msg.event) parsed.push(msg.event)
    } catch { /* discard */ }
    try { await unlink(path) } catch { /* already gone */ }
  }

  parsed.sort((a, b) => a.ts - b.ts)

  let replayed = 0
  for (const ev of parsed) {
    try { handle(ev); replayed++ } catch { /* one bad event must not stop the rest */ }
  }
  return replayed
}
