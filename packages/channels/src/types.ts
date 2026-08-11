import type { Alert } from '@nudge/shared/types'

export interface Channel {
  id: string
  configSchema: object
  send(alert: Alert, cfg: Record<string, unknown>): Promise<void>
  verify?(cfg: Record<string, unknown>): Promise<void>
}

export function isChannel(v: unknown): v is Channel {
  if (typeof v !== 'object' || v === null) return false
  const c = v as Partial<Channel>
  return typeof c.id === 'string' && c.id.length > 0 && typeof c.send === 'function'
}
