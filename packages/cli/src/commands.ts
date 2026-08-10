import { connect } from 'node:net'
import { socketPath, configPath } from '@nudge/shared/paths'
import { loadConfig } from '@nudge/shared/config'
import { loadChannels } from '@nudge/channels'
import type { SessionState } from '@nudge/shared/types'
import { encode, NdjsonDecoder } from '@nudge/shared/protocol'

/** One-shot request/response against the engine socket. */
export function request(msg: unknown, path = socketPath(), timeoutMs = 3_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const dec = new NdjsonDecoder()
    let settled = false
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { sock.destroy() } catch { /* ignore */ }
      fn()
    }

    const timer = setTimeout(
      () => done(() => reject(new Error('Engine timed out — it accepted the connection but did not reply.'))),
      timeoutMs,
    )

    const sock = connect(path)
    sock.setEncoding('utf8')
    sock.on('error', () => done(() =>
      reject(new Error('Nudge engine is not running. Start it with `nudge start`.'))))
    sock.on('connect', () => sock.write(encode(msg)))
    sock.on('data', chunk => {
      for (const m of dec.push(chunk as unknown as string)) done(() => resolve(m))
    })
  })
}

const ago = (ts: number) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

export async function cmdList(): Promise<void> {
  const reply = await request({ t: 'list', id: 1 }) as { data: SessionState[] }
  const waiting = reply.data.filter(s => s.waitingSince !== null)
  if (waiting.length === 0) { console.log('Nothing waiting on you.'); return }
  for (const s of waiting) {
    console.log(`${s.tier?.padEnd(11)} ${s.project.padEnd(24)} ${ago(s.waitingSince!).padStart(8)}  ${s.message ?? ''}`)
  }
}

export async function cmdStatus(): Promise<void> {
  const cfg = loadConfig()
  const channels = await loadChannels()
  console.log(`config    ${configPath()}`)
  console.log(`socket    ${socketPath()}`)
  console.log(`detail    ${cfg.detailLevel}`)
  console.log(`muted     ${cfg.muted}`)
  console.log(`channel   ${cfg.channel?.id ?? '(none configured)'}`)
  console.log(`adapters  ${[...channels.keys()].join(', ')}`)
  try {
    await request({ t: 'ping', id: 1 })
    console.log('engine    running')
  } catch (err) {
    console.log(`engine    ${(err as Error).message}`)
  }
}

export async function cmdTest(channelId?: string): Promise<void> {
  const cfg = loadConfig()
  const id = channelId ?? cfg.channel?.id
  if (!id) throw new Error('No channel configured. Set channel.id in ' + configPath())
  const channel = (await loadChannels()).get(id)
  if (!channel) throw new Error(`Unknown channel "${id}".`)
  if (!channel.verify) throw new Error(`Channel "${id}" does not support testing.`)
  await channel.verify(cfg.channel?.options ?? {})
  console.log(`Sent a test alert via ${id}. Check your phone.`)
}

export async function cmdSnooze(sessionId: string, ms: number): Promise<void> {
  await request({ t: 'snooze', id: 1, sessionId, ms })
  console.log(`Snoozed ${sessionId} for ${Math.round(ms / 60_000)}m.`)
}

export async function cmdMute(on: boolean): Promise<void> {
  await request({ t: 'mute', id: 1, on })
  console.log(on ? 'Muted.' : 'Unmuted.')
}

/**
 * Single-instance guard for `nudge start`.
 *
 * EngineServer.listen() unconditionally unlinks and rebinds the socket file,
 * so a second `start` would otherwise silently steal the socket from a
 * running daemon — and with bin.ts calling start() then drainSpool() with no
 * lock, two engines could both read the same spooled event before either
 * unlinks it, producing duplicate alerts.
 *
 * Before spawning, probe the socket with a `ping` and wait briefly:
 *  - a live engine replies -> decline, print a message, do not call spawnEngine.
 *  - nothing answers (no socket file, a stale one from a crashed engine, or a
 *    peer that accepts but never replies) -> proceed and call spawnEngine.
 * Only a definite reply counts as "already running"; every other outcome
 * (connection error or timeout) is treated the same way, matching how a
 * user would read "nothing answered".
 */
export async function cmdStart(
  spawnEngine: () => void, path = socketPath(), probeTimeoutMs = 500,
): Promise<void> {
  try {
    await request({ t: 'ping', id: 1 }, path, probeTimeoutMs)
    console.log('Engine already running.')
  } catch {
    spawnEngine()
    console.log('Engine started.')
  }
}
