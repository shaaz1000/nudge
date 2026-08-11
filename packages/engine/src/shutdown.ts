import type { EngineLock } from './lock.js'

const DEFAULT_HARD_EXIT_MS = 2500

/**
 * Finding C3: `bin.ts`'s SIGINT/SIGTERM handler used to release the lock and
 * exit only from the happy path of a `.then()` chained onto `engine.stop()`:
 * `process.on(sig, () => { void engine.stop().then(() => { lock.release();
 * process.exit(0) }) })`. `Db#close()` deliberately rethrows anything other
 * than "database is not open" (I/O errors, corruption), so a rejecting
 * `stop()` skipped *both* the release and the exit. The C1 top-level
 * `unhandledRejection` listener then just logs and returns — it no longer
 * even crashes the process out of that state — so the daemon is left
 * half-dead: still holding a lockfile whose PID *is* alive, which `lock.ts`'s
 * stale-lock reclaim then correctly refuses to steal. Every subsequent
 * `nudge start` exits 0 quietly against a daemon doing nothing. That is the
 * exact permanent-outage failure the reclaim logic (C2) exists to prevent,
 * reached through a different door: a shutdown path that forgot to be as
 * unconditional as the crash path it replaced.
 *
 * `shutdown()` makes lock release and process exit unconditional: both run
 * from a `.finally()` on the `stop()` promise, so they happen whether it
 * resolves or rejects, and a second, independent hard-exit timer bounds how
 * long that wait may take — if graceful shutdown has not finished within
 * `hardExitMs`, the process exits anyway. That timer is `.unref()`d so it
 * can never itself be the reason the process stays alive.
 *
 * `stop` and `exit` are injected (rather than importing `Engine`/using
 * `process.exit` directly) so this can be unit tested against a stub that
 * rejects, without spawning a real daemon.
 */
export function shutdown(
  stop: () => Promise<void>,
  lock: EngineLock,
  exit: (code: number) => void = process.exit,
  hardExitMs = DEFAULT_HARD_EXIT_MS,
): void {
  let settled = false
  const finish = (code: number): void => {
    if (settled) return
    settled = true
    clearTimeout(hardTimer)
    try {
      lock.release()
    } catch (err) {
      console.error('nudge engine: lock release failed during shutdown', err)
    }
    exit(code)
  }

  const hardTimer = setTimeout(() => {
    console.error('nudge engine: graceful shutdown exceeded the hard-exit bound; forcing exit')
    finish(0)
  }, hardExitMs)
  hardTimer.unref()

  stop()
    .catch(err => console.error('nudge engine: stop() failed during shutdown', err))
    .finally(() => finish(0))
}

/**
 * Startup-side counterpart to `shutdown()`. Before this fix, a rejecting
 * `engine.start()` (a bare top-level `await engine.start()` in `bin.ts`) left
 * the process in the same class of half-dead state: the SIGINT/SIGTERM
 * handlers are registered *after* that line, so nothing would ever call
 * `shutdown()` for it, and the C1 `unhandledRejection` listener only logs —
 * the process would sit there, alive, still holding the lock, having started
 * nothing and bound no socket.
 *
 * `startOrExit` wraps the call, and on rejection releases the lock and exits
 * non-zero with a clear message instead of lingering. It returns `false` in
 * that case (rather than letting `exit` — which is `never` in production —
 * decide control flow) purely so tests can inject a non-terminating `exit`
 * stub and assert the caller doesn't proceed to the rest of startup.
 */
export async function startOrExit(
  start: () => Promise<void>,
  lock: EngineLock,
  exit: (code: number) => void = process.exit,
): Promise<boolean> {
  try {
    await start()
    return true
  } catch (err) {
    console.error('nudge engine: engine.start() failed', err)
    try {
      lock.release()
    } catch (releaseErr) {
      console.error('nudge engine: lock release failed after startup failure', releaseErr)
    }
    exit(1)
    return false
  }
}
