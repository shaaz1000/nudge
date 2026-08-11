import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shutdown, startOrExit } from '../src/shutdown.js'
import { acquireLock } from '../src/lock.js'

/**
 * Finding C3: `bin.ts`'s old SIGINT/SIGTERM handler —
 * `process.on(sig, () => { void engine.stop().then(() => { lock.release();
 * process.exit(0) }) })` — only released the lock and exited from the happy
 * path of `.then()`. `Db#close()` deliberately rethrows anything other than
 * "database is not open", so a rejecting `stop()` (e.g. a real I/O error)
 * skipped BOTH the release and the exit. With the C1 top-level
 * `unhandledRejection` listener now just logging and returning, the process
 * survives in a half-dead state: alive, but holding a lockfile whose PID
 * *is* alive, which `lock.ts`'s stale-lock reclaim then correctly refuses to
 * steal — every later `nudge start` exits 0 quietly against a daemon doing
 * nothing. These tests exercise `shutdown()`/`startOrExit()` directly
 * against stub/real lock and engine functions, per the task's own
 * instruction not to spawn anything that could collide with the real
 * `com.nudge.engine` LaunchAgent's lock.
 */

let dir: string

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nudge-shutdown-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('shutdown()', () => {
  it('releases the lock and exits 0 when stop() resolves cleanly', async () => {
    const lock = { release: vi.fn() }
    const exit = vi.fn()
    await new Promise<void>(resolve => {
      shutdown(() => Promise.resolve(), lock, code => { exit(code); resolve() })
    })
    expect(lock.release).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('still releases the lock and exits 0 when stop() rejects (the C3 regression)', async () => {
    const lock = { release: vi.fn() }
    const exit = vi.fn()
    const stopError = new Error('Db#close: I/O error')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await new Promise<void>(resolve => {
      shutdown(() => Promise.reject(stopError), lock, code => { exit(code); resolve() })
    })
    expect(lock.release).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
    errSpy.mockRestore()
  })

  it('releases a REAL on-disk lock file when stop() rejects', async () => {
    const lockPath = join(dir, 'engine.lock')
    const lock = acquireLock(lockPath)!
    expect(existsSync(lockPath)).toBe(true)

    const exit = vi.fn()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await new Promise<void>(resolve => {
      shutdown(() => Promise.reject(new Error('boom')), lock, code => { exit(code); resolve() })
    })
    expect(existsSync(lockPath)).toBe(false)
    expect(exit).toHaveBeenCalledWith(0)
    errSpy.mockRestore()
  })

  it('forces the exit via the hard-exit timer when stop() never settles', async () => {
    const lock = { release: vi.fn() }
    const exit = vi.fn()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    shutdown(() => new Promise(() => { /* hangs forever, like a stuck Db#close */ }), lock, exit, 20)
    expect(exit).not.toHaveBeenCalled()

    await new Promise(r => setTimeout(r, 60))
    expect(lock.release).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
    errSpy.mockRestore()
  })

  it('exits only once even if the hard-exit timer fires before a slow stop() later settles', async () => {
    let resolveStop!: () => void
    const stopPromise = new Promise<void>(resolve => { resolveStop = resolve })
    const lock = { release: vi.fn() }
    const exit = vi.fn()

    shutdown(() => stopPromise, lock, exit, 20)
    await new Promise(r => setTimeout(r, 60))
    expect(exit).toHaveBeenCalledTimes(1)

    resolveStop()
    await new Promise(r => setTimeout(r, 20))
    expect(exit).toHaveBeenCalledTimes(1) // still just once
    expect(lock.release).toHaveBeenCalledTimes(1)
  })

  it('unrefs the hard-exit timer so it cannot itself hold the process open', () => {
    const real = global.setTimeout
    const created: NodeJS.Timeout[] = []
    const spy = vi.spyOn(global, 'setTimeout').mockImplementation((...args: Parameters<typeof setTimeout>) => {
      const t = real(...args)
      created.push(t)
      return t
    })

    const lock = { release: vi.fn() }
    shutdown(() => new Promise(() => { /* never settles */ }), lock, vi.fn(), 10_000)

    expect(created).toHaveLength(1)
    expect(created[0].hasRef()).toBe(false)

    spy.mockRestore()
    clearTimeout(created[0]) // don't leak a real 10s timer out of this test
  })
})

describe('startOrExit()', () => {
  it('returns true and touches neither the lock nor exit when start() resolves', async () => {
    const lock = { release: vi.fn() }
    const exit = vi.fn()
    const ok = await startOrExit(() => Promise.resolve(), lock, exit)
    expect(ok).toBe(true)
    expect(lock.release).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it('releases the lock and exits non-zero, with a clear console.error, when start() rejects', async () => {
    const lock = { release: vi.fn() }
    const exit = vi.fn()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const startError = new Error('EADDRINUSE')

    const ok = await startOrExit(() => Promise.reject(startError), lock, exit)

    expect(ok).toBe(false)
    expect(lock.release).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(1)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('engine.start() failed'), startError)
    errSpy.mockRestore()
  })

  it('still exits non-zero even if lock.release() itself throws', async () => {
    const lock = { release: vi.fn(() => { throw new Error('unlink EPERM') }) }
    const exit = vi.fn()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const ok = await startOrExit(() => Promise.reject(new Error('nope')), lock, exit)

    expect(ok).toBe(false)
    expect(exit).toHaveBeenCalledWith(1)
    errSpy.mockRestore()
  })
})
