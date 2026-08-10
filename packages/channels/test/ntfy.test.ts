import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ntfyChannel } from '../src/ntfy.js'
import type { Alert } from '@nudge/shared/types'

const alert: Alert = {
  sessionId: 's1', project: 'Sales-Dashboard',
  tier: 'blocked', waitingSince: 1_700_000_000_000,
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals() })

describe('ntfy send', () => {
  it('posts to serverUrl/topic', async () => {
    await ntfyChannel.send(alert, { serverUrl: 'https://ntfy.sh', topic: 'my-topic' })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toBe('https://ntfy.sh/my-topic')
    expect(fetchMock.mock.calls[0][1].method).toBe('POST')
  })

  it('strips a trailing slash from serverUrl', async () => {
    await ntfyChannel.send(alert, { serverUrl: 'http://192.168.1.10:8080/', topic: 't' })
    expect(fetchMock.mock.calls[0][0]).toBe('http://192.168.1.10:8080/t')
  })

  it('sends project and tier only when detail is absent', async () => {
    await ntfyChannel.send(alert, { serverUrl: 'https://ntfy.sh', topic: 't' })
    const init = fetchMock.mock.calls[0][1]
    expect(init.headers.Title).toBe('Sales-Dashboard needs you')
    expect(init.body).toBe('Waiting on you: permission or question')
    expect(JSON.stringify(init)).not.toContain('/a/')
  })

  it('includes detail when the caller supplies it', async () => {
    await ntfyChannel.send({ ...alert, detail: 'Allow Bash(ls)?' }, { serverUrl: 'https://ntfy.sh', topic: 't' })
    expect(fetchMock.mock.calls[0][1].body).toBe('Allow Bash(ls)?')
  })

  it('maps tiers to distinct priorities and bodies', async () => {
    await ntfyChannel.send({ ...alert, tier: 'idle-long' }, { serverUrl: 'https://ntfy.sh', topic: 't' })
    expect(fetchMock.mock.calls[0][1].headers.Priority).toBe('default')
    await ntfyChannel.send({ ...alert, tier: 'blocked' }, { serverUrl: 'https://ntfy.sh', topic: 't' })
    expect(fetchMock.mock.calls[1][1].headers.Priority).toBe('high')
  })

  it('sends an auth header when a token is configured', async () => {
    await ntfyChannel.send(alert, { serverUrl: 'https://ntfy.sh', topic: 't', token: 'tk_abc' })
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tk_abc')
  })

  it('throws on a non-2xx response so dispatch can retry', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 503 }))
    await expect(ntfyChannel.send(alert, { serverUrl: 'https://ntfy.sh', topic: 't' }))
      .rejects.toThrow(/503/)
  })

  it('rejects config with no topic', async () => {
    await expect(ntfyChannel.send(alert, { serverUrl: 'https://ntfy.sh' }))
      .rejects.toThrow(/topic/)
  })
})

describe('ntfy verify', () => {
  it('posts a test message', async () => {
    await ntfyChannel.verify!({ serverUrl: 'https://ntfy.sh', topic: 't' })
    expect(fetchMock.mock.calls[0][1].headers.Title).toBe('Nudge test')
  })
})
