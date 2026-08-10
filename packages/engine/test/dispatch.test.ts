import { describe, it, expect, vi } from 'vitest'
import { Dispatcher, buildAlert } from '../src/dispatch.js'
import { FakeClock } from '../src/clock.js'
import { mergeConfig, DEFAULT_CONFIG } from '@nudge/shared/config'
import type { Channel } from '@nudge/channels'
import type { SessionState } from '@nudge/shared/types'
import type { NudgeConfig } from '@nudge/shared/config'

const session = (over: Partial<SessionState> = {}): SessionState => ({
  sessionId: 's1', project: 'Sales-Dashboard', cwd: '/a/Sales-Dashboard',
  surface: { kind: 'vscode' }, status: 'blocked', tier: 'blocked',
  waitingSince: 5_000, turnStartedAt: null, lastEventAt: 5_000,
  message: 'Allow Bash(rsync root@10.0.0.1)?', snoozedUntil: null, pushFailed: false, ...over,
})

const withChannel = (cfg: NudgeConfig, send: Channel['send']) => {
  const clock = new FakeClock(0)
  const ch: Channel = { id: 'test', configSchema: {}, send }
  const d = new Dispatcher(cfg, clock, async () => ch)
  return { d, clock }
}

describe('buildAlert enforces the privacy rule', () => {
  it('omits detail under the minimal default', () => {
    const a = buildAlert(DEFAULT_CONFIG, session(), 'blocked')
    expect(a.project).toBe('Sales-Dashboard')
    expect(a.tier).toBe('blocked')
    expect(a.waitingSince).toBe(5_000)
    expect(a.detail).toBeUndefined()
    expect(JSON.stringify(a)).not.toContain('rsync')
    expect(JSON.stringify(a)).not.toContain('/a/Sales-Dashboard')
  })

  it('includes the message only when full detail is opted into', () => {
    const cfg = mergeConfig({ detailLevel: 'full' })
    const a = buildAlert(cfg, session(), 'blocked')
    expect(a.detail).toBe('Allow Bash(rsync root@10.0.0.1)?')
  })

  it('omits detail under full when there is no message', () => {
    const cfg = mergeConfig({ detailLevel: 'full' })
    expect(buildAlert(cfg, session({ message: null }), 'idle-long').detail).toBeUndefined()
  })
})

describe('dispatch', () => {
  const cfg = mergeConfig({ channel: { id: 'test', options: {} } })

  it('sends once on success', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const { d } = withChannel(cfg as NudgeConfig, send)
    const r = await d.dispatch(session(), 'blocked')
    expect(r).toEqual({ ok: true, attempts: 1 })
    expect(send).toHaveBeenCalledOnce()
  })

  it('passes the configured channel options through', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const c = mergeConfig({ channel: { id: 'test', options: { topic: 'abc' } } })
    const { d } = withChannel(c as NudgeConfig, send)
    await d.dispatch(session(), 'blocked')
    expect(send.mock.calls[0][1]).toEqual({ topic: 'abc' })
  })

  it('retries three times with backoff then reports failure', async () => {
    const send = vi.fn().mockRejectedValue(new Error('network down'))
    const { d, clock } = withChannel(cfg as NudgeConfig, send)
    const p = d.dispatch(session(), 'blocked')
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    clock.advance(1_000)
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    clock.advance(2_000)
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3))
    clock.advance(4_000)
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.attempts).toBe(3)
    expect(r.error).toMatch(/network down/)
  })

  it('succeeds on a retry after a transient failure', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(undefined)
    const { d, clock } = withChannel(cfg as NudgeConfig, send)
    const p = d.dispatch(session(), 'blocked')
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    clock.advance(1_000)
    const r = await p
    expect(r).toEqual({ ok: true, attempts: 2 })
  })

  it('reports failure without sending when no channel is configured', async () => {
    const clock = new FakeClock(0)
    const d = new Dispatcher(DEFAULT_CONFIG, clock, async () => null)
    const r = await d.dispatch(session(), 'blocked')
    expect(r.ok).toBe(false)
    expect(r.attempts).toBe(0)
    expect(r.error).toMatch(/no channel configured/i)
  })

  it('never throws — a dead channel must not crash the engine', async () => {
    const send = vi.fn().mockImplementation(() => { throw new Error('boom') })
    const { d, clock } = withChannel(cfg as NudgeConfig, send)
    const p = d.dispatch(session(), 'blocked')
    // resolveChannel() and each backoff wait are real Promise/microtask hops,
    // so the FakeClock must be advanced once per attempt boundary — a single
    // advance() issued synchronously right after dispatch() starts would run
    // before the channel even resolves and the promise would hang forever.
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    clock.advance(1_000)
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    clock.advance(2_000)
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3))
    clock.advance(4_000)
    await expect(p).resolves.toMatchObject({ ok: false })
  })
})
