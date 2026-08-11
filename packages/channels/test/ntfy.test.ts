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

  it('sends project and tier only when detail is absent — no session id, timestamp, or path anywhere in the request', async () => {
    await ntfyChannel.send(alert, { serverUrl: 'https://ntfy.sh', topic: 't' })
    const [url, init] = fetchMock.mock.calls[0]
    // Assert the complete outgoing payload
    expect(url).toBe('https://ntfy.sh/t')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({
      Title: 'Sales-Dashboard needs you',
      Priority: 'high',
      Tags: 'robot',
    })
    expect(init.body).toBe('Waiting on you: permission or question')
    // Ensure no session id, timestamp, or other sensitive fields leak anywhere in the request
    const serialised = JSON.stringify(init)
    expect(serialised).not.toContain(alert.sessionId)
    expect(serialised).not.toContain(String(alert.waitingSince))
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
    expect(fetchMock.mock.calls[0][1].headers).toEqual({
      Title: 'Sales-Dashboard needs you',
      Priority: 'high',
      Tags: 'robot',
      Authorization: 'Bearer tk_abc',
    })
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

  // Finding I9: Node's fetch has no default timeout, so a black-holed
  // self-hosted server left `send` pending forever — no rejection ever
  // reached Dispatcher's retry logic, `pushFailed` never got set, and the
  // phone escalation step silently vanished with no error anywhere.
  describe('request timeout (I9)', () => {
    it('passes an AbortSignal to fetch so a hanging request is abortable at all', async () => {
      await ntfyChannel.send(alert, { serverUrl: 'https://ntfy.sh', topic: 't' })
      const init = fetchMock.mock.calls[0][1]
      expect(init.signal).toBeInstanceOf(AbortSignal)
    })

    it('rejects rather than hanging forever against a server that never responds', async () => {
      // AbortSignal.timeout() is a native binding, not implemented in terms
      // of setTimeout — verified experimentally that vitest's fake timers
      // (vi.advanceTimersByTimeAsync) do not advance it — so this test
      // genuinely waits out the real 10s request timeout rather than faking
      // it; hence the generous per-test timeout override below. fetchMock
      // here never resolves on its own, simulating a server that accepted
      // the connection and then said nothing — exactly what the finding
      // describes as "hangs `send` forever" before this fix.
      fetchMock.mockImplementation((_url: string, init: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          // Only settles via the signal's own abort — if `post()` ever stops
          // passing one, this promise (like the real black-holed server it
          // simulates) never settles at all, so a regression here shows up
          // as this test genuinely timing out, not as a false pass.
          if (init.signal instanceof AbortSignal) {
            init.signal.addEventListener('abort', () => {
              reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))
            })
          }
        }))
      await expect(ntfyChannel.send(alert, { serverUrl: 'https://ntfy.sh', topic: 't' }))
        .rejects.toThrow()
    }, 15_000)
  })
})

describe('ntfy verify', () => {
  it('posts a test message', async () => {
    await ntfyChannel.verify!({ serverUrl: 'https://ntfy.sh', topic: 't' })
    expect(fetchMock.mock.calls[0][1].headers.Title).toBe('Nudge test')
  })
})
