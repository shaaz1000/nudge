import type { NudgeEvent, SessionState } from './types.js'

export type ClientMessage =
  | { t: 'event'; event: NudgeEvent }
  | { t: 'list'; id: number }
  | { t: 'subscribe'; id: number }
  | { t: 'snooze'; id: number; sessionId: string; ms: number }
  | { t: 'mute'; id: number; on: boolean }
  | { t: 'resolve'; id: number; sessionId: string }
  | { t: 'idle'; idleMs: number }
  | { t: 'frontmost'; sessionId: string | null }
  | { t: 'ping'; id: number }

export type ServerMessage =
  | { t: 'ok'; id: number; data?: unknown }
  | { t: 'err'; id: number; message: string }
  | { t: 'state'; sessions: SessionState[] }

export function encode(msg: unknown): string {
  return JSON.stringify(msg) + '\n'
}

/** Line-buffered NDJSON decoder. A malformed line is skipped, never fatal. */
export class NdjsonDecoder {
  #buf = ''

  push(chunk: string): unknown[] {
    this.#buf += chunk
    const out: unknown[] = []
    let nl: number
    while ((nl = this.#buf.indexOf('\n')) !== -1) {
      const line = this.#buf.slice(0, nl).trim()
      this.#buf = this.#buf.slice(nl + 1)
      if (line.length === 0) continue
      try { out.push(JSON.parse(line)) } catch { /* skip */ }
    }
    return out
  }
}
