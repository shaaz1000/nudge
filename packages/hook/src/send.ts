import { connect } from 'node:net'
import { socketPath } from '@nudge/shared/paths'

/** Writes a payload to the engine socket. Resolves false instead of throwing. */
export function sendEvent(payload: string, deadlineMs: number, path = socketPath()): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { sock.destroy() } catch { /* ignore */ }
      resolve(ok)
    }

    const timer = setTimeout(() => finish(false), deadlineMs)
    timer.unref?.()

    const sock = connect(path)
    sock.on('error', () => finish(false))
    sock.on('connect', () => { sock.write(payload, () => finish(true)) })
  })
}
