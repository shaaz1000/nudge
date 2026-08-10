import type { Alert, SessionState, Tier } from '@nudge/shared/types'
import type { NudgeConfig } from '@nudge/shared/config'
import type { Channel } from '@nudge/channels'
import type { Clock } from './clock.js'

export interface DispatchResult {
  ok: boolean
  attempts: number
  error?: string
}

const MAX_ATTEMPTS = 3
const BASE_BACKOFF_MS = 1_000

/**
 * The single place the privacy rule lives: project and tier always, message
 * only when the user has explicitly opted into full detail. No channel and no
 * caller gets to make this decision independently.
 */
export function buildAlert(cfg: NudgeConfig, s: SessionState, tier: Tier): Alert {
  const alert: Alert = {
    sessionId: s.sessionId,
    project: s.project,
    tier,
    waitingSince: s.waitingSince ?? s.lastEventAt,
  }
  if (cfg.detailLevel === 'full' && s.message) alert.detail = s.message
  return alert
}

export class Dispatcher {
  constructor(
    private cfg: NudgeConfig,
    private clock: Clock,
    private resolveChannel: () => Promise<Channel | null>,
  ) {}

  async dispatch(s: SessionState, tier: Tier): Promise<DispatchResult> {
    const channel = await this.resolveChannel()
    if (!channel || !this.cfg.channel) {
      return { ok: false, attempts: 0, error: 'no channel configured' }
    }

    const alert = buildAlert(this.cfg, s, tier)
    const options = this.cfg.channel.options
    let lastError = ''

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await channel.send(alert, options)
        return { ok: true, attempts: attempt }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        if (attempt === MAX_ATTEMPTS) break
        await new Promise<void>(resolve => {
          this.clock.schedule(BASE_BACKOFF_MS * 2 ** (attempt - 1), resolve)
        })
      }
    }

    return { ok: false, attempts: MAX_ATTEMPTS, error: lastError }
  }
}
