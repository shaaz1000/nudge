import type { NudgeEvent, SessionState } from './types.js'

export type ClientMessage =
  | { t: 'event'; event: NudgeEvent }
  | { t: 'list'; id: number }
  /**
   * `gui`, review round 1 Finding 5 (USER-APPROVED): a GUI client (currently
   * only the Electron tray — see packages/client/src/client.ts's
   * `EngineClientOptions.gui` and packages/tray/src/main.ts's wiring)
   * declares itself here so the engine can tell it apart from the CLI's
   * short-lived request/response connections (which never subscribe at all)
   * and from the VS Code extension (which subscribes but deliberately does
   * NOT set `gui` — see extension.ts's comment for why). Optional and
   * defaulting to falsy so every existing `subscribe` sender is unaffected.
   */
  | { t: 'subscribe'; id: number; gui?: boolean }
  | { t: 'snooze'; id: number; sessionId: string; ms: number }
  | { t: 'mute'; id: number; on: boolean }
  | { t: 'resolve'; id: number; sessionId: string }
  | { t: 'idle'; idleMs: number }
  | { t: 'frontmost'; sessionId: string | null }
  | { t: 'ping'; id: number }

export type ServerMessage =
  | { t: 'ok'; id: number; data?: unknown }
  | { t: 'err'; id: number; message: string }
  /**
   * `frontmost` is the session the user is currently looking at, as reported
   * by an editor client via `{t:'frontmost'}`. The engine has always tracked
   * it for its OWN suppression but never told anyone, so no client could
   * apply the same rule — the tray's Dock bounced at you while you were
   * looking at the very window that was waiting. Optional: an older engine
   * omits it and clients read `null`, which is exactly the previous
   * behaviour, and an older client ignores the extra key.
   */
  | { t: 'state'; sessions: SessionState[]; frontmost?: string | null }

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
