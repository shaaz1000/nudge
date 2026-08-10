import type { Alert, Tier } from '@nudge/shared/types'
import type { Channel } from './types.js'

const TIER_BODY: Record<Tier, string> = {
  'blocked': 'Waiting on you: permission or question',
  'idle-long': 'Long task finished — your move',
  'idle-short': 'Turn finished — your move',
  'stalled': 'Session may have stalled',
}

const TIER_PRIORITY: Record<Tier, string> = {
  'blocked': 'high',
  'idle-long': 'default',
  'idle-short': 'low',
  'stalled': 'default',
}

function endpoint(cfg: Record<string, unknown>): string {
  const server = typeof cfg.serverUrl === 'string' && cfg.serverUrl.length > 0
    ? cfg.serverUrl : 'https://ntfy.sh'
  const topic = cfg.topic
  if (typeof topic !== 'string' || topic.length === 0) {
    throw new Error('ntfy: "topic" is required')
  }
  return `${server.replace(/\/+$/, '')}/${topic}`
}

function headers(cfg: Record<string, unknown>, title: string, priority: string): Record<string, string> {
  const h: Record<string, string> = { Title: title, Priority: priority, Tags: 'robot' }
  if (typeof cfg.token === 'string' && cfg.token.length > 0) {
    h.Authorization = `Bearer ${cfg.token}`
  }
  return h
}

async function post(url: string, h: Record<string, string>, body: string): Promise<void> {
  const res = await fetch(url, { method: 'POST', headers: h, body })
  if (!res.ok) throw new Error(`ntfy: HTTP ${res.status}`)
}

export const ntfyChannel: Channel = {
  id: 'ntfy',
  configSchema: {
    type: 'object',
    required: ['topic'],
    properties: {
      serverUrl: { type: 'string', description: 'Defaults to https://ntfy.sh. Point at your own server for LAN-only delivery.' },
      topic: { type: 'string' },
      token: { type: 'string', description: 'Optional bearer token for a protected server.' },
    },
  },

  async send(alert: Alert, cfg: Record<string, unknown>): Promise<void> {
    // `detail` is populated by the engine only when detailLevel is 'full'.
    // The channel never makes that decision itself.
    const body = alert.detail ?? TIER_BODY[alert.tier]
    await post(endpoint(cfg), headers(cfg, `${alert.project} needs you`, TIER_PRIORITY[alert.tier]), body)
  },

  async verify(cfg: Record<string, unknown>): Promise<void> {
    await post(endpoint(cfg), headers(cfg, 'Nudge test', 'default'),
      'If you can read this, your phone channel works.')
  },
}
